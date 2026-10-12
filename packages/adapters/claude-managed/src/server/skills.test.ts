import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEvents, startFakeManagedAgentsServer, type FakeManagedAgentsServer, type TurnScript } from "../testing/fake-managed-agents-server.js";
import { execute } from "./execute.js";
import { sessionCodec } from "./session.js";
import { buildInlineSkillsSection, readLocalSkill, resetSkillsCache, skillTitle } from "./skills.js";

let fake: FakeManagedAgentsServer;
let tmpDir: string;

beforeEach(async () => {
  resetSkillsCache();
  fake = await startFakeManagedAgentsServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-managed-skills-"));
});

afterEach(async () => {
  await fake.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function turn(text: string, cents = 1): TurnScript {
  return [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "emit", event: fakeEvents.agentMessage(text) },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 10, outputTokens: 5, listCostCents: cents }) },
    { kind: "emit", event: fakeEvents.idle() },
  ];
}

async function writeSkill(name: string, body: string, extra: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = path.join(tmpDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}\n`);
  for (const [rel, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

function skillConfig(skills: Array<{ name: string; source: string }>, desired = skills.map((s) => s.name)): Record<string, unknown> {
  return {
    paperclipRuntimeSkills: skills.map((s) => ({ key: `company/${s.name}`, runtimeName: s.name, source: s.source })),
    paperclipSkillSync: { desiredSkills: desired.map((n) => `company/${n}`) },
  };
}

function harness(options: { config?: Record<string, unknown>; sessionParams?: Record<string, unknown> | null } = {}) {
  const logs: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1234567890", companyId: "company-1", name: "Assistant", adapterType: "claude_managed", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: options.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: fake.baseUrl, ...options.config },
    context: {},
    runtimeMcp: { getServers: () => [] },
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  };
  return { ctx, logs };
}

const req = (method: string, pattern: RegExp) => fake.requests.filter((r) => r.method === method && pattern.test(r.path));

describe("claude_managed native skills", () => {
  it("first run uploads each desired skill and pins its version on the agent", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.", { "references/notes.md": "More notes." });
    const other = await writeSkill("other", "Not desired.");
    fake.queueTurns(turn("ok"));
    const h = harness({ config: skillConfig([{ name: "codeword", source: codeword }, { name: "other", source: other }], ["codeword"]) });
    const result = await execute(h.ctx);
    expect(result.exitCode).toBe(0);

    const uploads = req("POST", /^\/v1\/skills$/);
    expect(uploads).toHaveLength(1);
    const form = uploads[0].body as FormData;
    const local = (await readLocalSkill({ key: "company/codeword", runtimeName: "codeword", source: codeword }))!;
    expect(form.get("display_name")).toBe(local.title);
    expect(local.title).toMatch(/^staples-codeword-[0-9a-f]{8}$/);
    expect((form.getAll("files[]") as File[]).map((f) => f.name).sort()).toEqual([`${local.title}/SKILL.md`, `${local.title}/references/notes.md`]);
    // No ?beta=true on skills calls (see skillsRequestShape).
    expect(uploads[0].query).toBe("");
    expect(uploads[0].headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");

    const [skill] = fake.listUploadedSkills();
    const agentBody = req("POST", /^\/v1\/agents$/)[0].body as Record<string, unknown>;
    expect(agentBody.skills).toEqual([{ type: "custom", skill_id: skill.id, version: skill.latest_version_id }]);
    // The library manifest marks the enabled and the not-enabled skill.
    expect(String(agentBody.system)).toContain("company/codeword — enabled");
    expect(String(agentBody.system)).toContain("company/other — installed, not enabled for you");
    expect(String(agentBody.system)).not.toContain("Answer BANANA-7.");
  });

  it("a later run reuses the uploaded skill (no re-upload) and resumes the session", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.");
    const config = skillConfig([{ name: "codeword", source: codeword }]);
    fake.queueTurns(turn("one"), turn("two"), turn("three"));
    const first = await execute(harness({ config }).ctx);
    // Same process: the cached listing is reused, no second list call.
    const second = await execute(harness({ config, sessionParams: first.sessionParams }).ctx);
    expect(req("GET", /^\/v1\/skills$/)).toHaveLength(1);
    // New process: lists once and finds the skill by its title.
    resetSkillsCache();
    const third = await execute(harness({ config, sessionParams: second.sessionParams }).ctx);
    expect(req("GET", /^\/v1\/skills$/)).toHaveLength(2);
    expect(req("POST", /^\/v1\/skills$/)).toHaveLength(1);
    expect(req("POST", /^\/v1\/agents\/[^/]+$/)).toHaveLength(0);
    expect(fake.sessionIds()).toHaveLength(1);
    expect(sessionCodec.deserialize(third.sessionParams)).toMatchObject({ managedAgentVersion: 1 });
  });

  it("a changed SKILL.md uploads a new skill, bumps the agent version and starts a new session", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.");
    const config = skillConfig([{ name: "codeword", source: codeword }]);
    fake.queueTurns(turn("one"), turn("two"));
    const first = await execute(harness({ config }).ctx);
    await fs.writeFile(path.join(codeword, "SKILL.md"), "---\nname: codeword\ndescription: Test.\n---\n\nAnswer CHERRY-9.\n");
    const second = await execute(harness({ config, sessionParams: first.sessionParams }).ctx);
    expect(second.exitCode).toBe(0);
    expect(req("POST", /^\/v1\/skills$/)).toHaveLength(2);
    const [, newer] = fake.listUploadedSkills();
    const update = req("POST", /^\/v1\/agents\/[^/]+$/);
    expect(update).toHaveLength(1);
    expect((update[0].body as Record<string, unknown>).skills).toEqual([{ type: "custom", skill_id: newer.id, version: newer.latest_version_id }]);
    expect(sessionCodec.deserialize(second.sessionParams)).toMatchObject({ managedAgentVersion: 2 });
    expect(fake.sessionIds()).toHaveLength(2);
  });

  it("reuses a skill another process already uploaded with the same content", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.");
    const local = (await readLocalSkill({ key: "company/codeword", runtimeName: "codeword", source: codeword }))!;
    const seeded = fake.seedSkill({ displayName: local.title, files: [{ path: `${local.title}/SKILL.md`, content: local.skillMd }] });
    fake.queueTurns(turn("ok"));
    await execute(harness({ config: skillConfig([{ name: "codeword", source: codeword }]) }).ctx);
    expect(req("POST", /^\/v1\/skills$/)).toHaveLength(0);
    expect((req("POST", /^\/v1\/agents$/)[0].body as Record<string, unknown>).skills).toEqual([
      { type: "custom", skill_id: seeded.id, version: seeded.latest_version_id },
    ]);
  });

  it("follows skills list pagination", async () => {
    const fakePaged = await startFakeManagedAgentsServer({ skillsPageSize: 2 });
    try {
      const prev = fake;
      fake = fakePaged;
      const codeword = await writeSkill("codeword", "Answer BANANA-7.");
      const local = (await readLocalSkill({ key: "company/codeword", runtimeName: "codeword", source: codeword }))!;
      fake.seedSkill({ displayName: local.title, files: [{ path: `${local.title}/SKILL.md`, content: local.skillMd }] });
      for (let i = 0; i < 5; i += 1) fake.seedSkill({ displayName: `staples-filler-${i}`, files: [{ path: "x/SKILL.md", content: "x" }] });
      fake.queueTurns(turn("ok"));
      const result = await execute(harness({ config: skillConfig([{ name: "codeword", source: codeword }]) }).ctx);
      fake = prev;
      expect(result.exitCode).toBe(0);
      // The matching skill is the oldest, on the last of three pages.
      expect(fakePaged.requests.filter((r) => r.method === "GET" && r.path === "/v1/skills")).toHaveLength(3);
      expect(fakePaged.requests.filter((r) => r.method === "POST" && r.path === "/v1/skills")).toHaveLength(0);
    } finally {
      await fakePaged.close();
    }
  });

  it("inlines skills in the system prompt when the Skills API refuses, warning once", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.");
    const second = await writeSkill("second", "Second skill body.");
    fake.failNext({ method: "GET", path: "/v1/skills", status: 403, errorType: "permission_error", message: "Skills are not enabled for this organization" });
    fake.queueTurns(turn("ok"), turn("again"));
    const config = skillConfig([{ name: "codeword", source: codeword }, { name: "second", source: second }]);
    const h = harness({ config });
    const first = await execute(h.ctx);
    expect(first.exitCode).toBe(0);
    const agentBody = req("POST", /^\/v1\/agents$/)[0].body as Record<string, unknown>;
    expect(agentBody.skills).toEqual([]);
    expect(String(agentBody.system)).toContain("### Skill: codeword");
    expect(String(agentBody.system)).toContain("Answer BANANA-7.");
    expect(String(agentBody.system)).toContain("Second skill body.");
    const warnings = h.logs.join("").split("\n").filter((l) => l.includes("Skills API is not available"));
    expect(warnings).toHaveLength(1);
    expect(req("POST", /^\/v1\/skills$/)).toHaveLength(0);

    // The refusal is remembered: the next run does not call the Skills API again and keeps the session.
    const again = await execute(harness({ config, sessionParams: first.sessionParams }).ctx);
    expect(req("GET", /^\/v1\/skills$/)).toHaveLength(1);
    expect(fake.sessionIds()).toHaveLength(1);
    expect(again.exitCode).toBe(0);
  });

  it("inlines only the skill the API rejects as invalid", async () => {
    const good = await writeSkill("good", "Good body.");
    const bad = await writeSkill("claude-helper", "Bad name body."); // reserved word in the frontmatter name
    fake.queueTurns(turn("ok"));
    const h = harness({ config: skillConfig([{ name: "good", source: good }, { name: "claude-helper", source: bad }]) });
    expect((await execute(h.ctx)).exitCode).toBe(0);
    const agentBody = req("POST", /^\/v1\/agents$/)[0].body as Record<string, unknown>;
    expect(agentBody.skills).toHaveLength(1);
    expect(String(agentBody.system)).toContain("Bad name body.");
    expect(String(agentBody.system)).not.toContain("Good body.");
    expect(h.logs.join("")).toContain('skill "company/claude-helper" could not be uploaded');
  });

  it("fails the run (not a fallback) when the Skills API has a server error", async () => {
    const codeword = await writeSkill("codeword", "Answer BANANA-7.");
    fake.failNext({ method: "GET", path: "/v1/skills", status: 500, times: 10 });
    const result = await execute(harness({ config: skillConfig([{ name: "codeword", source: codeword }]) }).ctx, {});
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_skills_failed", errorFamily: "transient_upstream" });
    expect(req("POST", /^\/v1\/agents$/)).toHaveLength(0);
  }, 20_000);

  it("agents without skills keep their previous fingerprint", async () => {
    fake.queueTurns(turn("ok"));
    const result = await execute(harness({ config: { paperclipRuntimeSkills: [] } }).ctx);
    expect((req("POST", /^\/v1\/agents$/)[0].body as Record<string, unknown>).skills).toEqual([]);
    expect(req("GET", /^\/v1\/skills$/)).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});

describe("claude_managed full replies", () => {
  it("returns the full multi-line final message as the summary, with a one-line preview", async () => {
    const reply = "Here is the plan:\n\n1. First step\n2. Second step\n\nLet me know.";
    fake.queueTurns(turn(reply));
    const h = harness();
    const result = await execute(h.ctx);
    expect(result.summary).toBe(reply);
    expect(result.resultJson).toMatchObject({ result: reply, summary: reply, summaryPreview: "Here is the plan:" });
  });
});

describe("skill files and inline section", () => {
  it("reads text files, skips binaries and hashes content into the title", async () => {
    const dir = await writeSkill("files", "Body.", { "references/a.md": "A", "assets/logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]), ".hidden": "h" });
    const skill = (await readLocalSkill({ key: "k", runtimeName: "files", source: dir }))!;
    expect(skill.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
    expect(skill.skipped).toEqual(["assets/logo.png"]);
    expect(skill.title).toBe(skillTitle("files", skill.hash));
    await fs.writeFile(path.join(dir, "references/a.md"), "B");
    const changed = (await readLocalSkill({ key: "k", runtimeName: "files", source: dir }))!;
    expect(changed.hash).not.toBe(skill.hash);
  });

  it("bounds the inlined section and notes truncation", async () => {
    const big = "x".repeat(40_000);
    const mk = (name: string) => ({ key: name, runtimeName: name, hash: "0", title: name, files: [{ path: "SKILL.md", content: big }], skillMd: big, skipped: [] });
    const text = buildInlineSkillsSection([mk("a"), mk("b"), mk("c")], 60 * 1024);
    expect(text.length).toBeLessThanOrEqual(60 * 1024 + 300);
    expect(text).toContain("[Staples truncated this skill to fit the system prompt.]");
    expect(text).toContain("omitted these skills");
  });
});

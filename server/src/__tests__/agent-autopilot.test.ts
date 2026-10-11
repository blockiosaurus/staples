import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import type { AgentTemplateAnswers, PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentAutopilotRoutes } from "../routes/agent-autopilot.js";
import { agentTemplatesService } from "../services/agent-templates.js";
import { ensureTemplateAgentSetup } from "../services/plan-templates.js";
import { AGENT_AUTOPILOT_POLICY_SOURCE, toolAccessPolicyService } from "../services/tool-access-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

describeEmbeddedPostgres("agent Autopilot", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const templates = agentTemplatesService();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-autopilot-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  function recommended(questions: PaperclipQuestionSetQuestion[]): AgentTemplateAnswers {
    const answers: AgentTemplateAnswers = {};
    for (const question of questions) {
      const picks = (question.options ?? []).filter((option) => option.recommended).map((option) => option.id);
      if (question.answerMode === "text") answers[question.id] = question.initialText ?? "";
      else if (question.answerMode === "multi_select") answers[question.id] = picks;
      else answers[question.id] = picks[0] ?? "";
    }
    return answers;
  }

  async function seed(membershipRole = "owner") {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Autopilot ${nonce}`, issuePrefix: `AP${nonce.slice(0, 4).toUpperCase()}` }).returning();
    const userId = `user-${nonce}`;
    await db.insert(authUsers).values({ id: userId, name: "Pat", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole });
    if (membershipRole !== "viewer") {
      // Configuring agents (agent_config:read/update) is granted, not implied by the role.
      await db.insert(principalPermissionGrants).values({ companyId: company!.id, principalType: "user", principalId: userId, permissionKey: "agents:configure" });
    }
    const [staff] = await db.insert(agents).values({ companyId: company!.id, name: "Riley", role: "engineer", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, status: "idle" }).returning();
    return { companyId: company!.id, userId, staffId: staff!.id, membershipRole };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  /** An agent installed from a template: the install's access rules and template record (plans/apply's setup step). */
  async function templatedAgent(s: Seed, ref: string) {
    const detail = await templates.get(ref, { companyName: "Autopilot Co", personName: "Pat" });
    const rendered = await templates.render(ref, detail.version, recommended(detail.setupQuestions), { companyName: "Autopilot Co", personName: "Pat", personTimezone: "UTC" });
    const [agent] = await db.insert(agents).values({
      companyId: s.companyId, name: rendered.agent.name, role: "engineer", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, status: "idle",
    }).returning();
    await ensureTemplateAgentSetup(db, s.companyId, agent!.id, rendered, s.userId);
    return agent!.id;
  }

  /**
   * A usable connection for an app slug, its catalog (name -> risk), the
   * connection's own Ask first rules for every write (as the gallery seeds
   * them) and a company-wide allow profile. Returns a decide helper.
   */
  async function connection(companyId: string, slug: string, tools: Array<[string, "read" | "write" | "destructive"]>) {
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `app-gallery:${slug}:${randomUUID()}`, name: `${slug} ${randomUUID().slice(0, 6)}`, type: "mcp_http", status: "active", metadata: { sourceTemplateKey: slug },
    }).returning();
    const [row] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: `${slug} connection`, uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", config: { url: "https://example.invalid/mcp", sourceTemplateKey: slug },
    }).returning();
    const entries = new Map<string, string>();
    for (const [name, riskLevel] of tools) {
      const [entry] = await db.insert(toolCatalogEntries).values({
        companyId, applicationId: application!.id, connectionId: row!.id, name, toolName: name, riskLevel,
        versionHash: randomUUID(), schemaHash: randomUUID(),
      }).returning();
      entries.set(name, entry!.id);
      if (riskLevel !== "read") {
        await db.insert(toolPolicies).values({
          companyId, name: `Ask first: ${name} ${randomUUID().slice(0, 6)}`, policyType: "require_approval", priority: 50, enabled: true,
          selectors: { catalogEntryId: entry!.id }, config: { source: "app_gallery_finish", connectionId: row!.id, catalogEntryId: entry!.id },
        });
      }
    }
    const existingProfile = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId));
    if (existingProfile.length === 0) {
      const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `profile-${randomUUID()}`, name: "All tools", defaultAction: "allow" }).returning();
      await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "company", targetId: companyId });
    }
    const decide = (agentId: string, toolName: string) => toolAccessPolicyService(db).decide({
      companyId, actor: { actorType: "agent", actorId: agentId, agentId },
      request: { connectionId: row!.id, catalogEntryId: entries.get(toolName)!, toolName },
    });
    return { id: row!.id, decide };
  }

  function boardActor(s: Seed, overrides: Partial<Record<string, unknown>> = {}): Actor {
    return {
      type: "board", source: "session", userId: s.userId, companyIds: [s.companyId],
      memberships: [{ companyId: s.companyId, membershipRole: s.membershipRole, status: "active" }], isInstanceAdmin: false,
      ...overrides,
    } as Actor;
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", agentAutopilotRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const put = (actor: Actor, agentId: string, capability: string, mode: string) =>
    request(app(actor)).put(`/api/agents/${agentId}/autopilot/${capability}`).send({ mode });

  async function autopilotRows(agentId: string) {
    return (await db.select().from(toolPolicies)).filter((row) =>
      (row.config as Record<string, unknown> | null)?.source === AGENT_AUTOPILOT_POLICY_SOURCE && (row.selectors as Record<string, unknown>).agentId === agentId);
  }

  it("lists a templated agent's categories with modes and whether they can be toggled", async () => {
    const s = await seed();
    const creator = await templatedAgent(s, "staples/content-creator");
    await connection(s.companyId, "x", [["create_tweet", "write"]]);
    const response = await request(app(boardActor(s))).get(`/api/agents/${creator}/autopilot`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.categories).toEqual([
      { capability: "social", label: "Publishing posts", destructiveLabel: null, connection: { id: expect.any(String), appSlug: "x", displayName: "x connection" }, mode: "ask", canToggle: true },
      { capability: "cms", label: "Publishing to your site", destructiveLabel: null, connection: null, mode: "ask", canToggle: false },
    ]);
    // Without a connection, auto is refused (409) and nothing is created.
    const refused = await put(boardActor(s), creator, "cms", "auto");
    expect(refused.status).toBe(409);
    expect(await autopilotRows(creator)).toHaveLength(0);
    // Unknown category: 404.
    expect((await put(boardActor(s), creator, "payments", "auto")).status).toBe(404);
  }, 60_000);

  it("auto lets the category's writes on that connection run without asking; other writes, destructive calls and other agents still ask", async () => {
    const s = await seed();
    const dev = await templatedAgent(s, "staples/coding-agent");
    const github = await connection(s.companyId, "github", [
      ["merge_pull_request", "write"], ["create_branch", "write"], ["delete_branch", "destructive"], ["get_issue", "read"],
    ]);
    const otherGithub = await connection(s.companyId, "github", [["merge_pull_request", "write"]]);

    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });

    const listed = await request(app(boardActor(s))).get(`/api/agents/${dev}/autopilot`);
    expect(listed.body.categories).toEqual([expect.objectContaining({
      capability: "code", label: "Merging and pushing to the default branch", destructiveLabel: "Deleting branches or closing issues",
      connection: expect.objectContaining({ id: github.id, appSlug: "github" }), mode: "ask", canToggle: true,
    })]);

    const on = await put(boardActor(s), dev, "code", "auto");
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ capability: "code", mode: "auto", canToggle: true, connection: { id: github.id } });
    const rows = await autopilotRows(dev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ policyType: "allow", priority: 45, enabled: true });
    expect(rows[0]!.selectors).toEqual({
      agentId: dev, connectionId: github.id, riskLevels: ["write"],
      toolNamePatterns: ["*merge*", "*push*", "*create_or_update_file*", "*update_issue*", "*close*"],
    });
    expect(rows[0]!.config).toEqual({ source: AGENT_AUTOPILOT_POLICY_SOURCE, capability: "code" });

    // Idempotent: a second auto changes nothing and logs nothing.
    const again = await put(boardActor(s), dev, "code", "auto");
    expect(again.status).toBe(200);
    expect((await autopilotRows(dev)).map((row) => row.id)).toEqual([rows[0]!.id]);
    const changes = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "agent.autopilot_changed")));
    expect(await changes()).toHaveLength(1);
    expect((await changes())[0]).toMatchObject({ entityType: "agent", entityId: dev, actorType: "user", actorId: s.userId });
    expect((await changes())[0]!.details).toMatchObject({ capability: "code", mode: "auto", connectionId: github.id });

    const listedOn = await request(app(boardActor(s))).get(`/api/agents/${dev}/autopilot`);
    expect(listedOn.body.categories[0]).toMatchObject({ mode: "auto" });

    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "allow", reasonCode: "allow_policy", matchedPolicyIds: [rows[0]!.id] });
    // A write outside the category's patterns still follows the connection's own rules.
    await expect(github.decide(dev, "create_branch")).resolves.toMatchObject({ decision: "require_approval" });
    // Destructive calls still ask (the template's destructive guard).
    await expect(github.decide(dev, "delete_branch")).resolves.toMatchObject({ decision: "require_approval", policyExplanation: { templateGuard: "destructive" } });
    await expect(github.decide(dev, "get_issue")).resolves.toMatchObject({ decision: "allow" });
    // Only on that connection, and only for this agent.
    await expect(otherGithub.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });
    await expect(github.decide(s.staffId, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });

    // An explicit block still wins over Autopilot.
    const [block] = await db.insert(toolPolicies).values({
      companyId: s.companyId, name: "Never merge", policyType: "block", priority: 300, enabled: true, selectors: { toolName: "merge_pull_request" },
    }).returning();
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_policy_block" });
    await db.delete(toolPolicies).where(eq(toolPolicies.id, block!.id));

    // ask removes the rule; idempotent.
    const off = await put(boardActor(s), dev, "code", "ask");
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ mode: "ask", canToggle: true });
    expect(await autopilotRows(dev)).toHaveLength(0);
    expect((await put(boardActor(s), dev, "code", "ask")).status).toBe(200);
    expect(await changes()).toHaveLength(2);
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });
  }, 60_000);

  it("never allows a call nothing else allows", async () => {
    const s = await seed();
    const dev = await templatedAgent(s, "staples/coding-agent");
    const github = await connection(s.companyId, "github", [["merge_pull_request", "write"]]);
    expect((await put(boardActor(s), dev, "code", "auto")).status).toBe(200);
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.companyId, s.companyId));
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "deny" });
  }, 60_000);

  it("survives a policy reorder: the outward rule never moves ahead of Autopilot", async () => {
    const s = await seed();
    const dev = await templatedAgent(s, "staples/coding-agent");
    const github = await connection(s.companyId, "github", [["merge_pull_request", "write"]]);
    expect((await put(boardActor(s), dev, "code", "auto")).status).toBe(200);
    const [autopilot] = await autopilotRows(dev);
    const policies = toolAccessPolicyService(db);
    const listed = await policies.listPolicies(s.companyId);
    // Put the outward ask-first rule first and Autopilot last.
    const outward = listed.find((row) => (row.config as Record<string, unknown> | null)?.templateRule === "outward")!;
    const ordered = [outward.id, ...listed.map((row) => row.id).filter((id) => id !== outward.id && id !== autopilot!.id), autopilot!.id];
    const reordered = await policies.reorderPolicies(s.companyId, { policyIds: ordered });
    expect(reordered.find((row) => row.id === autopilot!.id)!.priority).toBe(45);
    expect(reordered.find((row) => row.id === outward.id)!.priority).toBeGreaterThan(45);
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "allow", matchedPolicyIds: [autopilot!.id] });
    // A reorder that leaves Autopilot out is fine too.
    await policies.reorderPolicies(s.companyId, { policyIds: ordered.filter((id) => id !== autopilot!.id) });
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "allow" });
    // Turning it off still restores asking.
    expect((await put(boardActor(s), dev, "code", "ask")).status).toBe(200);
    await expect(github.decide(dev, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });
  }, 60_000);

  it("is empty for untemplated and read-only agents", async () => {
    const s = await seed();
    const books = await templatedAgent(s, "staples/bookkeeper");
    for (const agentId of [s.staffId, books]) {
      const response = await request(app(boardActor(s))).get(`/api/agents/${agentId}/autopilot`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ categories: [] });
    }
    expect((await put(boardActor(s), s.staffId, "code", "auto")).status).toBe(404);
  }, 60_000);

  it("only board users who may configure the agent; agents and viewers 403; another company's agent 404", async () => {
    const s = await seed();
    const dev = await templatedAgent(s, "staples/coding-agent");
    await connection(s.companyId, "github", [["merge_pull_request", "write"]]);

    const agentActor = { type: "agent", source: "agent_key", agentId: dev, companyId: s.companyId, keyId: randomUUID(), runId: null } as unknown as Actor;
    expect((await put(agentActor, dev, "code", "auto")).status).toBe(403);
    expect((await request(app(agentActor)).get(`/api/agents/${dev}/autopilot`)).status).toBe(403);

    const viewer = await seed("viewer");
    await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user", principalId: viewer.userId, status: "active", membershipRole: "viewer" });
    const viewerActor = boardActor({ ...viewer, companyId: s.companyId });
    expect((await put(viewerActor, dev, "code", "auto")).status).toBe(403);

    const outsider = await seed();
    expect((await put(boardActor(outsider), dev, "code", "auto")).status).toBe(404);
    expect((await request(app(boardActor(outsider))).get(`/api/agents/${dev}/autopilot`)).status).toBe(404);
    expect((await put(boardActor(s), randomUUID(), "code", "auto")).status).toBe(404);
    expect(await autopilotRows(dev)).toHaveLength(0);
  }, 60_000);
});

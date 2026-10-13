import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSelfServeCompanyAgent,
  assertSelfServeCompanyHostAccess,
  configureSelfServePolicy,
  isSelfServeCompany,
  isSelfServeRestricted,
  parseSelfServeAdapterTypes,
  resetSelfServePolicy,
  selfServeAgentViolation,
  selfServeManagedInstructionsRoot,
} from "../services/self-serve-policy.js";
import { assertNoHostWorkspaceCommandMutation } from "../routes/workspace-command-authz.js";

const member = { actor: { type: "board", source: "session", userId: "u1", isInstanceAdmin: false } } as never;
const admin = { actor: { type: "board", source: "session", userId: "u2", isInstanceAdmin: true } } as never;
const agent = { actor: { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" } } as never;

function dbWith(selfServe: boolean) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ selfServe }]).then(resolve),
        }),
      }),
    }),
  } as never;
}

function on() {
  configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
}

describe("self-serve policy", () => {
  afterEach(() => resetSelfServePolicy());

  it("parses the adapter list, defaulting to claude_managed and dropping host-executed adapters", () => {
    expect(parseSelfServeAdapterTypes(undefined)).toEqual(["claude_managed"]);
    expect(parseSelfServeAdapterTypes("")).toEqual(["claude_managed"]);
    expect(parseSelfServeAdapterTypes(" claude_managed, http ,process,claude_local,http")).toEqual(["claude_managed", "http"]);
  });

  it("applies only to self-serve companies while the flag is on in authenticated mode", async () => {
    expect(await isSelfServeCompany(dbWith(true), "c1")).toBe(false);
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "local_trusted" });
    expect(await isSelfServeCompany(dbWith(true), "c1")).toBe(false);
    on();
    expect(await isSelfServeCompany(dbWith(true), "c1")).toBe(true);
    expect(await isSelfServeCompany(dbWith(false), "c1")).toBe(false);
  });

  it("allows only listed remote adapters, never process or *_local even if listed", async () => {
    configureSelfServePolicy({
      selfServeCompanies: true,
      deploymentMode: "authenticated",
      adapterTypes: ["claude_managed", "process", "codex_local"],
    });
    expect(await selfServeAgentViolation("c1", "claude_managed", { model: "claude-sonnet" })).toBeNull();
    for (const type of ["process", "claude_local", "codex_local", "http", "", null]) {
      expect(await selfServeAgentViolation("c1", type, {})).toMatchObject({ code: "self_serve_host_execution_forbidden" });
    }
  });

  it("allows only reviewed config keys, and only secret-bound ANTHROPIC_API_KEY", async () => {
    on();
    const ok = async (config: Record<string, unknown>) => selfServeAgentViolation("c1", "claude_managed", config);
    expect(await ok({ model: "m", paperclipSkillSync: { desiredSkills: [] }, networkingMode: "limited", promptTemplate: "p" })).toBeNull();
    expect(await ok({ apiBaseUrl: "https://api.anthropic.com/v1/" })).toBeNull();
    expect(await ok({ env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s" } } })).toBeNull();
    for (const config of [
      { apiBaseUrl: "http://169.254.169.254/latest" },
      { baseUrl: "http://server.railway.internal" },
      { env: { ANTHROPIC_BASE_URL: { type: "secret_ref", secretId: "s" } } },
      { env: { ANTHROPIC_API_KEY: "plain" } },
      { command: "sh" },
      { workspaceStrategy: { type: "git_worktree", provisionCommand: "id" } },
      { instructionsBundleMode: "external" },
      { agentsMdPath: "/etc/passwd" },
      { instructionsEntryFile: "../../x.md" },
      { paperclipRuntimeSkills: [] },
      { someFutureKey: 1 },
    ]) {
      expect(await ok(config), JSON.stringify(config)).toMatchObject({ code: "self_serve_config_key_not_allowed" });
    }
  });

  it("allows instruction paths only inside the company's managed folder, with no .. or symlink escape", async () => {
    on();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "self-serve-policy-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    try {
      const root = selfServeManagedInstructionsRoot("c1");
      const dir = path.join(root, "a1", "instructions");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, "AGENTS.md");
      await fs.writeFile(file, "hi");
      const check = (instructionsFilePath: string) => selfServeAgentViolation("c1", "claude_managed", { instructionsFilePath });
      expect(await check(file)).toBeNull();
      expect(await check(path.join(dir, "NOT_YET.md"))).toBeNull();
      expect(await check("/proc/self/environ")).not.toBeNull();
      expect(await check(path.join(dir, "..", "..", "..", "..", "..", "secret"))).not.toBeNull();
      expect(await check(path.join(selfServeManagedInstructionsRoot("other"), "a1", "instructions", "AGENTS.md"))).not.toBeNull();
      expect(await check("AGENTS.md")).not.toBeNull();
      const outside = path.join(home, "secret.txt");
      await fs.writeFile(outside, "SECRET");
      await fs.symlink(outside, path.join(dir, "LINK.md"));
      expect(await check(path.join(dir, "LINK.md"))).not.toBeNull();
      await fs.symlink(home, path.join(dir, "escape"));
      expect(await check(path.join(dir, "escape", "secret.txt"))).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("asserts by company, whatever the actor", async () => {
    on();
    await expect(assertSelfServeCompanyAgent(dbWith(true), "c1", "process", {})).rejects.toThrow(/not allowed/);
    await expect(assertSelfServeCompanyAgent(dbWith(false), "c1", "process", {})).resolves.toBeUndefined();
    await expect(assertSelfServeCompanyHostAccess(dbWith(true), "c1", "X")).rejects.toThrow(/X can't be used/);
    await expect(assertSelfServeCompanyHostAccess(dbWith(false), "c1", "X")).resolves.toBeUndefined();
  });

  it("refuses host-executed workspace commands in a self-serve company, for admins too", async () => {
    const paths = ["executionWorkspacePolicy.workspaceStrategy.provisionCommand"];
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(true), "c1", member, paths)).resolves.toBeUndefined();
    on();
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(true), "c1", member, paths)).rejects.toThrow(/workspace commands/);
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(true), "c1", admin, paths)).rejects.toThrow(/workspace commands/);
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(false), "c1", member, paths)).resolves.toBeUndefined();
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(true), "c1", member, [])).resolves.toBeUndefined();
    await expect(assertNoHostWorkspaceCommandMutation(dbWith(false), "c1", agent, paths)).rejects.toThrow(/Agent keys/);
  });

  it("keeps instance-level operator actions (no company) for admins", () => {
    on();
    expect(isSelfServeRestricted(member)).toBe(true);
    expect(isSelfServeRestricted(agent)).toBe(true);
    expect(isSelfServeRestricted(admin)).toBe(false);
  });
});

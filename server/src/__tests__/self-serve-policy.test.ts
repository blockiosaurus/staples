import { afterEach, describe, expect, it } from "vitest";
import {
  assertSelfServeCompanyAgent,
  assertSelfServeCompanyHostAccess,
  configureSelfServePolicy,
  isSelfServeCompany,
  isSelfServeRestricted,
  parseSelfServeAdapterTypes,
  resetSelfServePolicy,
  selfServeAgentViolation,
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

  it("allows only listed remote adapters, never process or *_local even if listed", () => {
    configureSelfServePolicy({
      selfServeCompanies: true,
      deploymentMode: "authenticated",
      adapterTypes: ["claude_managed", "process", "codex_local"],
    });
    expect(selfServeAgentViolation("claude_managed", { model: "claude-sonnet" })).toBeNull();
    for (const type of ["process", "claude_local", "codex_local", "http", "", null]) {
      expect(selfServeAgentViolation(type, {})).not.toBeNull();
    }
  });

  it("refuses endpoint overrides, host commands and workspace commands", () => {
    on();
    expect(selfServeAgentViolation("claude_managed", { apiBaseUrl: "https://api.anthropic.com/v1/" })).toBeNull();
    expect(selfServeAgentViolation("claude_managed", { apiBaseUrl: "http://169.254.169.254/latest" })).toMatch(/apiBaseUrl/);
    expect(selfServeAgentViolation("claude_managed", { baseUrl: "http://server.railway.internal" })).toMatch(/baseUrl/);
    expect(selfServeAgentViolation("claude_managed", { env: { ANTHROPIC_BASE_URL: "http://x" } })).toMatch(/ANTHROPIC_BASE_URL/);
    expect(selfServeAgentViolation("claude_managed", { env: { ANTHROPIC_API_KEY: { type: "secret_ref" } } })).toBeNull();
    expect(selfServeAgentViolation("claude_managed", { command: "sh" })).toMatch(/command/);
    expect(selfServeAgentViolation("claude_managed", { workspaceStrategy: { type: "git_worktree", provisionCommand: "id" } })).toMatch(/provisionCommand/);
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

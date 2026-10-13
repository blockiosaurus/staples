import { afterEach, describe, expect, it } from "vitest";
import {
  assertSelfServeAdapterAllowed,
  assertSelfServeHostAccess,
  configureSelfServePolicy,
  isSelfServeRestricted,
  parseSelfServeAdapterTypes,
  resetSelfServePolicy,
} from "../services/self-serve-policy.js";
import { assertNoAgentHostWorkspaceCommandMutation } from "../routes/workspace-command-authz.js";

const member = { actor: { type: "board", source: "session", userId: "u1", isInstanceAdmin: false } } as never;
const admin = { actor: { type: "board", source: "session", userId: "u2", isInstanceAdmin: true } } as never;
const localBoard = { actor: { type: "board", source: "local_implicit", userId: "local-board" } } as never;
const agent = { actor: { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" } } as never;

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

  it("is off unless enabled in authenticated mode", () => {
    expect(isSelfServeRestricted(member)).toBe(false);
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "local_trusted" });
    expect(isSelfServeRestricted(member)).toBe(false);
    on();
    expect(isSelfServeRestricted(member)).toBe(true);
  });

  it("restricts non-admin people and agents, never instance admins or the local board", () => {
    on();
    expect(isSelfServeRestricted(member)).toBe(true);
    expect(isSelfServeRestricted(agent)).toBe(true);
    expect(isSelfServeRestricted(admin)).toBe(false);
    expect(isSelfServeRestricted(localBoard)).toBe(false);
  });

  it("allows only listed remote adapters, and never process or *_local even if listed", () => {
    configureSelfServePolicy({
      selfServeCompanies: true,
      deploymentMode: "authenticated",
      adapterTypes: ["claude_managed", "process", "codex_local"],
    });
    expect(() => assertSelfServeAdapterAllowed(member, "claude_managed")).not.toThrow();
    for (const type of ["process", "claude_local", "codex_local", "http", "", null]) {
      expect(() => assertSelfServeAdapterAllowed(member, type)).toThrow(/instance admin/);
    }
    expect(() => assertSelfServeAdapterAllowed(admin, "process")).not.toThrow();
  });

  it("refuses host surfaces only for restricted actors", () => {
    expect(() => assertSelfServeHostAccess(member, "X")).not.toThrow();
    on();
    expect(() => assertSelfServeHostAccess(member, "X")).toThrow(/X needs an instance admin/);
    expect(() => assertSelfServeHostAccess(admin, "X")).not.toThrow();
  });

  it("refuses host-executed workspace commands from self-serve people", () => {
    const paths = ["executionWorkspacePolicy.workspaceStrategy.provisionCommand"];
    expect(() => assertNoAgentHostWorkspaceCommandMutation(member, paths)).not.toThrow();
    on();
    expect(() => assertNoAgentHostWorkspaceCommandMutation(member, paths)).toThrow(/host-executed workspace commands/);
    expect(() => assertNoAgentHostWorkspaceCommandMutation(admin, paths)).not.toThrow();
    expect(() => assertNoAgentHostWorkspaceCommandMutation(member, [])).not.toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import { assistantAdapterAvailability, assistantSetupStatus, canConfigureAssistant, resolveAssistantSetupEngine } from "../services/assistant-setup.js";

const base = {
  adapterType: "claude_local",
  status: "idle",
  lifecycleState: "ready",
  lifecycleVersion: 3,
  lifecycleError: null as string | null,
  lifecycleHolds: [] as string[],
  lifecycleOperation: null as Record<string, unknown> | null,
};
const failed = (codes: string[], overrides: Partial<typeof base> = {}) => ({
  ...base,
  status: "paused",
  lifecycleState: "verifying",
  lifecycleError: "The lifecycle step failed. Retry the operation.",
  lifecycleOperation: {
    id: "op", hostComplete: false, completedPluginIds: [], attempts: 2,
    lastHarnessTest: { version: 3, adapterType: "claude_local", checks: codes.map((code) => ({ code, level: "error" })) },
  },
  ...overrides,
});

describe("assistantSetupStatus", () => {
  it("is ready once the lifecycle is ready", () => {
    expect(assistantSetupStatus(base)).toEqual({ state: "ready", adapterType: "claude_local" });
  });

  it("is starting while preparing or verifying without an error", () => {
    for (const lifecycleState of ["preparing", "verifying", "resuming"]) {
      expect(assistantSetupStatus({ ...base, status: "paused", lifecycleState })).toMatchObject({ state: "starting" });
    }
  });

  it.each([
    ["claude_hello_probe_auth_required", "Claude isn't signed in on this computer."],
    ["adapter_auth_missing", "Claude isn't signed in on this computer."],
    ["claude_command_unresolvable", "Claude isn't installed on this computer."],
    ["adapter_engine_unavailable", "Claude is installed, but its default engine isn't available here. Pick Claude below to connect it on its CLI engine instead."],
  ])("needs a model when the harness test failed with %s, with a fixed reason", (code, reason) => {
    expect(assistantSetupStatus(failed([code]))).toEqual({ state: "needs_model", adapterType: "claude_local", reason });
  });

  it("names Node 24.11 only when the check says the Node version is the cause", () => {
    expect(assistantSetupStatus(failed(["adapter_engine_unavailable", "adapter_engine_node_unsupported"]))).toEqual({
      state: "needs_model", adapterType: "claude_local",
      reason: "Claude is installed, but its default engine needs Node 24.11 or newer. Pick Claude below to connect it on its CLI engine instead.",
    });
  });

  it("names Kimi's own Node minimum", () => {
    const claude = failed(["adapter_engine_unavailable", "adapter_engine_node_unsupported"]);
    const kimiFailure = {
      ...claude, adapterType: "kimi_local",
      lifecycleOperation: { ...claude.lifecycleOperation, lastHarnessTest: { ...claude.lifecycleOperation.lastHarnessTest, adapterType: "kimi_local" } },
    };
    expect(assistantSetupStatus(kimiFailure))
      .toMatchObject({ reason: "Kimi is installed, but it needs Node 20 or newer on this computer to run the Assistant." });
  });

  it("explains other harness failures with fixed copy, never the raw lifecycle message", () => {
    expect(assistantSetupStatus(failed(["claude_hello_probe_timed_out"]))).toEqual({
      state: "error", adapterType: "claude_local",
      message: "The model couldn't be reached. Connect a model to continue.",
      reason: "Claude didn't answer in time.",
    });
    expect(assistantSetupStatus(failed(["claude_hello_probe_usage_limited"]))).toMatchObject({ reason: "Claude has reached its usage limit." });
    expect(assistantSetupStatus(failed(["claude_something_else"]))).toMatchObject({ reason: "Claude didn't pass its connection test." });
  });

  it("keeps the lifecycle message for failures other than the harness test", () => {
    expect(assistantSetupStatus({ ...failed([]), lifecycleOperation: null })).toEqual({
      state: "error", adapterType: "claude_local", message: "The lifecycle step failed. Retry the operation.",
    });
  });

  it("ignores a harness test recorded for an earlier lifecycle version or another adapter", () => {
    expect(assistantSetupStatus(failed(["claude_hello_probe_auth_required"], { lifecycleVersion: 4 }))).toMatchObject({ state: "error", message: "The lifecycle step failed. Retry the operation." });
    expect(assistantSetupStatus(failed(["claude_hello_probe_auth_required"], { adapterType: "codex_local" }))).toMatchObject({ state: "error", message: "The lifecycle step failed. Retry the operation." });
  });

  it("needs a model when the Assistant is on an adapter it cannot run on", () => {
    expect(assistantSetupStatus({ ...base, adapterType: "process" })).toMatchObject({ state: "needs_model" });
  });

  it("is an error when the Assistant is paused or held", () => {
    expect(assistantSetupStatus({ ...base, status: "paused", lifecycleState: "paused" })).toMatchObject({ state: "error" });
    expect(assistantSetupStatus({ ...base, status: "paused", lifecycleState: "verifying", lifecycleHolds: ["budget"] })).toMatchObject({ state: "error" });
  });
});

describe("resolveAssistantSetupEngine", () => {
  const recorded = (adapterType: string, codes: string[]) => ({
    ...base,
    lifecycleOperation: { lastHarnessTest: { version: 3, adapterType, checks: codes.map((code) => ({ code, level: "error" })) } },
  });

  it("keeps an explicit engine", () => {
    expect(resolveAssistantSetupEngine(recorded("claude_local", ["adapter_engine_unavailable"]), "claude_local", "acp")).toBe("acp");
  });

  it("uses the CLI engine when the last test found ACP prerequisites missing for that adapter", () => {
    expect(resolveAssistantSetupEngine(recorded("claude_local", ["adapter_engine_unavailable"]), "claude_local", undefined)).toBe("cli");
    expect(resolveAssistantSetupEngine(recorded("codex_local", ["adapter_engine_unavailable"]), "codex_local", undefined)).toBe("cli");
  });

  it("leaves the engine alone otherwise, and never forces CLI on adapters whose CLI engine lacks the Assistant's tools", () => {
    expect(resolveAssistantSetupEngine(recorded("claude_local", ["claude_hello_probe_auth_required"]), "claude_local", undefined)).toBeUndefined();
    expect(resolveAssistantSetupEngine(recorded("claude_local", ["adapter_engine_unavailable"]), "codex_local", undefined)).toBeUndefined();
    expect(resolveAssistantSetupEngine(recorded("gemini_local", ["adapter_engine_unavailable"]), "gemini_local", undefined)).toBeUndefined();
  });
});

describe("assistantAdapterAvailability", () => {
  const deps = (overrides: Partial<Parameters<typeof assistantAdapterAvailability>[0]> = {}) => ({
    nodeVersion: "v24.10.0",
    commandResolvable: vi.fn(async (command: string) => command !== "kimi"),
    authSignal: vi.fn(async (type: string) => (type === "codex_local" ? "absent" as const : "unknown" as const)),
    geminiCredentialsPresent: vi.fn(async () => false),
    ...overrides,
  });

  it("detects each runtime adapter without model calls", async () => {
    const d = deps();
    const result = await assistantAdapterAvailability(d);
    expect(result).toEqual([
      { adapterType: "claude_local", installed: true, available: true, engine: "cli", signedIn: null,
        hint: "Sign-in not checked — if `claude` isn't logged in, run it in a terminal once." },
      { adapterType: "codex_local", installed: true, available: true, engine: "cli", signedIn: false,
        hint: "Sign in needed: run `codex login` in a terminal once, or connect an API key." },
      { adapterType: "gemini_local", installed: true, available: false, engine: null, signedIn: null,
        hint: "Needs Node 24.11 or newer on this computer." },
      { adapterType: "kimi_local", installed: false, available: false, engine: null, signedIn: null,
        hint: "Not installed: install the kimi CLI, then check again." },
    ]);
    expect(d.commandResolvable.mock.calls.map((call) => call[0]).sort()).toEqual(["claude", "codex", "gemini", "kimi"]);
  });

  it("uses ACP when Node is new enough and reports sign-in hints for CLI-only logins", async () => {
    const result = await assistantAdapterAvailability(deps({
      nodeVersion: "v24.11.0",
      commandResolvable: vi.fn(async () => true),
      authSignal: vi.fn(async (type: string) => (type === "claude_local" ? "present" as const : "unknown" as const)),
    }));
    expect(result.find((entry) => entry.adapterType === "claude_local")).toEqual(
      { adapterType: "claude_local", installed: true, available: true, engine: null, signedIn: true });
    expect(result.find((entry) => entry.adapterType === "gemini_local")).toEqual({
      adapterType: "gemini_local", installed: true, available: true, engine: null, signedIn: null,
      hint: "Sign-in not checked — if `gemini` isn't logged in, run it in a terminal once.",
    });
    expect(result.find((entry) => entry.adapterType === "kimi_local")).toMatchObject({ available: true, signedIn: null,
      hint: "Sign-in not checked — if `kimi` isn't logged in, run it in a terminal once." });
    expect(result.find((entry) => entry.adapterType === "codex_local")).toMatchObject({ signedIn: null,
      hint: "Sign-in not checked — if `codex` isn't logged in, run it in a terminal once." });
  });

  it("treats found Gemini credentials as signed in", async () => {
    const result = await assistantAdapterAvailability(deps({
      nodeVersion: "v25.0.0", commandResolvable: vi.fn(async () => true), geminiCredentialsPresent: vi.fn(async () => true),
    }));
    expect(result.find((entry) => entry.adapterType === "gemini_local")).toEqual(
      { adapterType: "gemini_local", installed: true, available: true, engine: null, signedIn: true });
  });
});

describe("canConfigureAssistant", () => {
  const allow = { decide: vi.fn(async () => ({ allowed: true })) };
  const member = (membershipRole: string) => ({ type: "board", source: "session", memberships: [{ companyId: "c", status: "active", membershipRole }] });

  it("lets owners, operators, local and instance admins configure when the config grant allows, but not viewers", async () => {
    expect(await canConfigureAssistant(allow, member("owner") as never, "c", "a")).toBe(true);
    expect(await canConfigureAssistant(allow, member("operator") as never, "c", "a")).toBe(true);
    expect(await canConfigureAssistant(allow, member("viewer") as never, "c", "a")).toBe(false);
    expect(await canConfigureAssistant(allow, { type: "board", source: "local_implicit" } as never, "c", "a")).toBe(true);
    expect(await canConfigureAssistant(allow, { type: "board", source: "session", isInstanceAdmin: true, memberships: [] } as never, "c", "a")).toBe(true);
    expect(await canConfigureAssistant(allow, { type: "agent" } as never, "c", "a")).toBe(false);
  });

  it("asks for the same agent_config:update decision that saving the agent needs", async () => {
    const deny = { decide: vi.fn(async () => ({ allowed: false })) };
    expect(await canConfigureAssistant(deny, member("operator") as never, "c", "a")).toBe(false);
    expect(deny.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:update",
      resource: { type: "agent", companyId: "c", agentId: "a" },
    }));
  });

  it("fails closed when the decision throws", async () => {
    const broken = { decide: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await canConfigureAssistant(broken, member("owner") as never, "c", "a")).toBe(false);
  });
});

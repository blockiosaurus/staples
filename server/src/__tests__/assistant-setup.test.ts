import { describe, expect, it } from "vitest";
import { assistantSetupStatus, resolveAssistantSetupEngine } from "../services/assistant-setup.js";

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
    ["claude_hello_probe_auth_required"],
    ["claude_command_unresolvable"],
    ["adapter_engine_unavailable"],
    ["adapter_auth_missing"],
    ["codex_hello_probe_auth_required"],
  ])("needs a model when the harness test failed with %s", (code) => {
    expect(assistantSetupStatus(failed([code]))).toMatchObject({ state: "needs_model", adapterType: "claude_local" });
  });

  it("is an error with the lifecycle message for other failures", () => {
    expect(assistantSetupStatus(failed(["claude_hello_probe_timed_out"]))).toEqual({
      state: "error", adapterType: "claude_local", message: "The lifecycle step failed. Retry the operation.",
    });
  });

  it("ignores a harness test recorded for an earlier lifecycle version or another adapter", () => {
    expect(assistantSetupStatus(failed(["claude_hello_probe_auth_required"], { lifecycleVersion: 4 }))).toMatchObject({ state: "error" });
    expect(assistantSetupStatus(failed(["claude_hello_probe_auth_required"], { adapterType: "codex_local" }))).toMatchObject({ state: "error" });
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

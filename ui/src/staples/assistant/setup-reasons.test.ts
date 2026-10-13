import { describe, expect, it } from "vitest";
import { connectionFailureReason } from "./setup-reasons";

describe("connectionFailureReason", () => {
  it("only names Node 24.11 when the check says the Node version is the cause", () => {
    expect(connectionFailureReason("claude_local", ["adapter_engine_unavailable", "adapter_engine_node_unsupported"])).toBe(
      "Claude is installed, but its default engine needs Node 24.11 or newer. Pick Claude below to connect it on its CLI engine instead.",
    );
    expect(connectionFailureReason("gemini_local", ["adapter_engine_unavailable", "adapter_engine_node_unsupported"])).toBe(
      "Gemini is installed, but it needs Node 24.11 or newer on this computer to run the Assistant.",
    );
  });

  it("names each adapter's own Node minimum", () => {
    expect(connectionFailureReason("kimi_local", ["adapter_engine_unavailable", "adapter_engine_node_unsupported"])).toBe(
      "Kimi is installed, but it needs Node 20 or newer on this computer to run the Assistant.",
    );
  });

  it("otherwise says the default engine isn't available here", () => {
    expect(connectionFailureReason("claude_local", ["adapter_engine_unavailable"])).toBe(
      "Claude is installed, but its default engine isn't available here. Pick Claude below to connect it on its CLI engine instead.",
    );
    expect(connectionFailureReason("gemini_local", ["adapter_engine_unavailable"])).toBe(
      "Gemini is installed, but its default engine isn't available here.",
    );
  });

  it("keeps the install and sign-in reasons", () => {
    expect(connectionFailureReason("codex_local", ["codex_command_unresolvable"])).toBe("Codex isn't installed on this computer.");
    expect(connectionFailureReason("claude_local", ["claude_hello_probe_auth_required"])).toBe("Claude isn't signed in on this computer.");
  });
});

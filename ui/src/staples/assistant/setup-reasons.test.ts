import { describe, expect, it } from "vitest";
import { connectionFailureReason } from "./setup-reasons";

describe("connectionFailureReason", () => {
  it("says the CLI is installed and what to do when only the default engine can't run (no contradiction with an Installed tile)", () => {
    expect(connectionFailureReason("claude_local", ["adapter_engine_unavailable"])).toBe(
      "Claude is installed, but its default engine needs Node 24.11 or newer. Pick Claude below to connect it on its CLI engine instead.",
    );
    expect(connectionFailureReason("gemini_local", ["adapter_engine_unavailable"])).toBe(
      "Gemini is installed, but it needs Node 24.11 or newer on this computer to run the Assistant.",
    );
  });

  it("keeps the install and sign-in reasons", () => {
    expect(connectionFailureReason("codex_local", ["codex_command_unresolvable"])).toBe("Codex isn't installed on this computer.");
    expect(connectionFailureReason("claude_local", ["claude_hello_probe_auth_required"])).toBe("Claude isn't signed in on this computer.");
  });
});

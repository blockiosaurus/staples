import { describe, expect, it } from "vitest";

import { getAdapterDisplay, getAdapterLabel, getAdapterLabels } from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("uses user-facing labels without the legacy local qualifier for built-in adapters", () => {
    expect(getAdapterLabel("codex_local")).toBe("Codex");
    expect(getAdapterLabel("claude_local")).toBe("Claude Code");
    expect(getAdapterLabel("acpx_local")).toBe("ACPX (retired)");
    expect(getAdapterLabel("cursor")).toBe("Cursor");
    expect(getAdapterLabel("gemini_local")).toBe("Gemini CLI");
    expect(getAdapterLabel("grok_local")).toBe("Grok Build");
    expect(getAdapterLabel("kimi_local")).toBe("Kimi Code");
    expect(getAdapterLabel("hermes_local")).toBe("Hermes");
    expect(getAdapterLabel("hermes_gateway")).toBe("Hermes Gateway");
    expect(getAdapterLabel("opencode_local")).toBe("OpenCode");
    expect(getAdapterLabel("pi_local")).toBe("Pi");

    expect(getAdapterLabels()).toMatchObject({
      codex_local: "Codex",
      claude_local: "Claude Code",
      acpx_local: "ACPX (retired)",
      cursor: "Cursor",
      gemini_local: "Gemini CLI",
      grok_local: "Grok Build",
      kimi_local: "Kimi Code",
      hermes_local: "Hermes",
      hermes_gateway: "Hermes Gateway",
      opencode_local: "OpenCode",
      pi_local: "Pi",
    });
  });

  it("shows the hosted Claude adapter as Claude (hosted), never Claude Code", () => {
    expect(getAdapterLabel("claude_managed")).toBe("Claude (hosted)");
    expect(getAdapterDisplay("claude_managed")).toMatchObject({
      label: "Claude (hosted)",
      description: "Runs in Anthropic's cloud sandbox. Uses your Anthropic API key; billed per use.",
    });
    expect(getAdapterDisplay("claude_managed").comingSoon).toBeFalsy();
    expect(getAdapterDisplay("claude_managed").hideFromVisualSelection).toBeFalsy();
    expect(JSON.stringify(getAdapterDisplay("claude_managed"))).not.toContain("Claude Code");
  });

  it("drops local suffixes for unknown plugin adapter labels", () => {
    expect(getAdapterLabel("droid_local")).toBe("Droid");
    expect(getAdapterDisplay("droid_local")).toMatchObject({
      label: "Droid",
      description: "External adapter",
    });
  });

  it("keeps a gateway suffix for unknown plugin adapter labels", () => {
    expect(getAdapterLabel("droid_gateway")).toBe("Droid (gateway)");
    expect(getAdapterDisplay("droid_gateway")).toMatchObject({
      label: "Droid (gateway)",
      description: "External gateway adapter",
    });
  });
});

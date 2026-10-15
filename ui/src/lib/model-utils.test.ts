import { describe, expect, it } from "vitest";
import { adapterCuratesModelOrder, formatModelName } from "./model-utils";

describe("adapterCuratesModelOrder", () => {
  it("keeps the advertised order for built-in adapters with a hand-ordered list", () => {
    for (const adapterType of ["claude_local", "codex_local", "paperclip_runner", "gemini_local", "opencode_local"]) {
      expect(adapterCuratesModelOrder(adapterType)).toBe(true);
    }
  });

  it("leaves discovered and third-party lists to the alphabetical fallback", () => {
    // Cursor's list comes from `agent models`, whose order can change between refreshes.
    expect(adapterCuratesModelOrder("cursor")).toBe(false);
    // An externally installed adapter is not known to order its list deliberately.
    expect(adapterCuratesModelOrder("acme_plugin_adapter")).toBe(false);
  });
});

describe("formatModelName", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["gpt-5.6", "GPT-5.6"],
    ["openai/gpt-5.6-mini", "GPT-5.6 Mini"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["grok-4", "Grok 4"],
    ["some-vendor-model", "Some Vendor Model"],
    ["  ", ""],
  ])("%s → %s", (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });
});

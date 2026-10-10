import { describe, expect, it } from "vitest";
import { ASSISTANT_BUILT_IN_AGENT_KEY, isAssistantAgent } from "./assistant-agent.js";

describe("isAssistantAgent", () => {
  it("recognizes the Assistant built-in marker", () => {
    expect(ASSISTANT_BUILT_IN_AGENT_KEY).toBe("assistant");
    expect(isAssistantAgent({
      metadata: { paperclipBuiltInAgent: { key: "assistant", featureKeys: ["assistant"] } },
    })).toBe(true);
  });

  it("rejects other built-ins, regular agents, and malformed metadata", () => {
    expect(isAssistantAgent({
      metadata: { paperclipBuiltInAgent: { key: "summarizer", featureKeys: ["summarizer"] } },
    })).toBe(false);
    expect(isAssistantAgent({ metadata: { assistant: true } })).toBe(false);
    expect(isAssistantAgent({ metadata: null })).toBe(false);
    expect(isAssistantAgent({})).toBe(false);
    expect(isAssistantAgent({ metadata: { paperclipBuiltInAgent: "assistant" } })).toBe(false);
    expect(isAssistantAgent({ metadata: [] })).toBe(false);
  });
});

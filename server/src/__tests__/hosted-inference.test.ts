import { describe, expect, it } from "vitest";
import { hostedInference } from "../services/hosted-inference.js";

describe("hostedInference", () => {
  it("is available only with a non-blank server key and no opt-out", () => {
    expect(hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy" })).toEqual({
      available: true, adapterType: "claude_managed", model: "claude-opus-5-5",
    });
    expect(hostedInference({}).available).toBe(false);
    expect(hostedInference({ ANTHROPIC_API_KEY: "   " }).available).toBe(false);
    expect(hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "off" }).available).toBe(false);
    expect(hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "OFF" }).available).toBe(false);
    expect(hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "on" }).available).toBe(true);
  });

  it("never returns the key", () => {
    const result = hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy" });
    expect(JSON.stringify(result)).not.toContain("sk-ant-test-dummy");
  });
});

describe("hostedAssistantBudgetCents", () => {
  it("defaults to $20 and accepts an explicit non-negative integer override", async () => {
    const { hostedAssistantBudgetCents } = await import("../services/hosted-inference.js");
    expect(hostedAssistantBudgetCents({})).toBe(2000);
    expect(hostedAssistantBudgetCents({ STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS: "500" })).toBe(500);
    expect(hostedAssistantBudgetCents({ STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS: "0" })).toBe(0);
    for (const invalid of ["", "-5", "12.5", "lots"]) {
      expect(hostedAssistantBudgetCents({ STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS: invalid })).toBe(2000);
    }
  });
});

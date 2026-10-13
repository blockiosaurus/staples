import { describe, expect, it } from "vitest";
import { hostedInference } from "../services/hosted-inference.js";

describe("hostedInference", () => {
  it("is available only with a non-blank server key and no opt-out", () => {
    expect(hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "sk-ant-test-dummy" })).toEqual({
      available: true, adapterType: "claude_managed", model: "claude-opus-5-5",
    });
    expect(hostedInference({}).available).toBe(false);
    expect(hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "   " }).available).toBe(false);
    expect(hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "off" }).available).toBe(false);
    expect(hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "OFF" }).available).toBe(false);
    expect(hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "sk-ant-test-dummy", STAPLES_HOSTED_INFERENCE: "on" }).available).toBe(true);
  });

  it("is never turned on by a plain ANTHROPIC_API_KEY", () => {
    expect(hostedInference({ ANTHROPIC_API_KEY: "sk-ant-test-dummy" }).available).toBe(false);
  });

  it("never returns the key", () => {
    const result = hostedInference({ STAPLES_HOSTED_ANTHROPIC_API_KEY: "sk-ant-test-dummy" });
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

describe("hosted hire and company budgets", () => {
  it("default to $20 per agent and $50 per company, with explicit overrides (0 = uncapped)", async () => {
    const { hostedAgentBudgetCents, hostedCompanyBudgetCents } = await import("../services/hosted-inference.js");
    expect(hostedAgentBudgetCents({})).toBe(2000);
    expect(hostedAgentBudgetCents({ STAPLES_HOSTED_AGENT_BUDGET_CENTS: "750" })).toBe(750);
    expect(hostedAgentBudgetCents({ STAPLES_HOSTED_AGENT_BUDGET_CENTS: "0" })).toBe(0);
    expect(hostedAgentBudgetCents({ STAPLES_HOSTED_AGENT_BUDGET_CENTS: "nope" })).toBe(2000);
    expect(hostedCompanyBudgetCents({})).toBe(5000);
    expect(hostedCompanyBudgetCents({ STAPLES_HOSTED_COMPANY_BUDGET_CENTS: "12000" })).toBe(12000);
    expect(hostedCompanyBudgetCents({ STAPLES_HOSTED_COMPANY_BUDGET_CENTS: "0" })).toBe(0);
    expect(hostedCompanyBudgetCents({ STAPLES_HOSTED_COMPANY_BUDGET_CENTS: "-1" })).toBe(5000);
  });
});

describe("hostedCompanyBudgetCeilingCents", () => {
  it("defaults to $200, with an explicit override (0 = plans never raise the cap)", async () => {
    const { hostedCompanyBudgetCeilingCents } = await import("../services/hosted-inference.js");
    expect(hostedCompanyBudgetCeilingCents({})).toBe(20000);
    expect(hostedCompanyBudgetCeilingCents({ STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS: "50000" })).toBe(50000);
    expect(hostedCompanyBudgetCeilingCents({ STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS: "0" })).toBe(0);
    expect(hostedCompanyBudgetCeilingCents({ STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS: "lots" })).toBe(20000);
  });
});

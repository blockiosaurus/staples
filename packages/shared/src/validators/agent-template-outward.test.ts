import { describe, expect, it } from "vitest";
import { agentTemplateOutwardActionSchema } from "./agent-template.js";

describe("agentTemplateOutwardActionSchema destructiveToolPatterns", () => {
  const base = { capability: "code", label: "Merging", toolPatterns: ["*merge*"] };

  it("accepts destructive tool patterns with a destructive label", () => {
    expect(agentTemplateOutwardActionSchema.safeParse({ ...base, destructiveLabel: "Closing issues", destructiveToolPatterns: ["*close*"] }).success).toBe(true);
  });

  it("needs a destructive label, at least one pattern and valid globs", () => {
    expect(agentTemplateOutwardActionSchema.safeParse({ ...base, destructiveToolPatterns: ["*close*"] }).success).toBe(false);
    expect(agentTemplateOutwardActionSchema.safeParse({ ...base, destructiveLabel: "Closing", destructiveToolPatterns: [] }).success).toBe(false);
    expect(agentTemplateOutwardActionSchema.safeParse({ ...base, destructiveLabel: "Closing", destructiveToolPatterns: ["*"] }).success).toBe(false);
  });
});

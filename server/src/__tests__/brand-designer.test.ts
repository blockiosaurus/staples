import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandKitSpecSchema } from "@paperclipai/shared";
import { listBuiltInAgentDefinitions } from "../services/built-in-agents.js";

describe("brand designer built-in", () => {
  const def = listBuiltInAgentDefinitions().find((d) => d.key === "brand-designer")!;
  it("is defined with the brand-kit skill and no hire approval", () => {
    expect(def).toBeTruthy();
    expect(def.bundle?.stockVersion).toBe("2026-10-15");
    expect(def.bypassHireApproval).toBe(true);
    expect(def.inheritCompanyAdapterType).toBe(true);
    expect(def.preferHostedInference).toBe(true);
    expect(def.defaultSkillKeys).toContain("paperclipai/paperclip/staples-brand-kit");
    expect(def.defaultRole).toBe("designer");
  });
  it("ships the skill and instructions", () => {
    const skill = readFileSync(new URL("../../../skills/staples-brand-kit/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("brand-kit/render");
    expect(skill).toContain("brand-kit/publish");
    expect(def.defaultInstructions).toContain("brand designer");
  });
  it("keeps the skill's example spec valid against the schema", () => {
    const skill = readFileSync(new URL("../../../skills/staples-brand-kit/SKILL.md", import.meta.url), "utf8");
    const block = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes("businessName"));
    expect(block).toBeTruthy();
    const spec = brandKitSpecSchema.parse(JSON.parse(block!));
    // concept names are business-name options, not labels like "HB Seal"
    expect(new Set(spec.concepts.map((c) => c.name)).size).toBe(spec.concepts.length);
    expect(skill).toContain("the business name that concept proposes");
    expect(skill).toContain("the person chose the name");
  });
});

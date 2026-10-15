import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listBuiltInAgentDefinitions } from "../services/built-in-agents.js";

describe("brand designer built-in", () => {
  const def = listBuiltInAgentDefinitions().find((d) => d.key === "brand-designer")!;
  it("is defined with the brand-kit skill and no hire approval", () => {
    expect(def).toBeTruthy();
    expect(def.bundle?.stockVersion).toBe("2026-10-15");
    expect(def.bypassHireApproval).toBe(true);
    expect(def.inheritCompanyAdapterType).toBe(true);
    expect(def.defaultSkillKeys).toContain("paperclipai/paperclip/staples-brand-kit");
    expect(def.defaultRole).toBe("designer");
  });
  it("ships the skill and instructions", () => {
    const skill = readFileSync(new URL("../../../skills/staples-brand-kit/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("brand-kit/render");
    expect(skill).toContain("brand-kit/publish");
    expect(def.defaultInstructions).toContain("brand designer");
  });
});

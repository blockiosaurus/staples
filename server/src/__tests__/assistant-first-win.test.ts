import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listBuiltInAgentDefinitions } from "../services/built-in-agents.js";

const skill = (name: string) =>
  readFileSync(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url), "utf8");

describe("assistant first-win guidance", () => {
  const assistant = listBuiltInAgentDefinitions().find((definition) => definition.key === "assistant")!;

  it("paces the interview at three questions and asks the vision card", () => {
    const interview = skill("staples-interview");
    expect(interview).toContain("at most 3 questions");
    expect(interview).toContain("30 days");
    expect(interview).toContain("What success looks like");
    expect(interview).toContain("About:");
  });

  it("builds the goal from the 30-day answer", () => {
    expect(skill("staples-plan")).toMatch(/30-day answer/);
  });

  it("puts the 6-month and 1-year answers in the brief", () => {
    expect(skill("staples-company-brief")).toContain("Where this is going");
  });

  it("tells the Assistant about the brand designer without waiting on it", () => {
    const text = assistant.bundle!.instructions.files["AGENTS.md"];
    expect(text).toContain("brand designer");
    expect(text).toContain("Do not propose a rename and do not wait for it");
    expect(assistant.bundle?.stockVersion).toBe("2026-10-15");
  });
});

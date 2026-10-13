import { describe, expect, it } from "vitest";
import { overviewDesiredSkillKeys } from "./AgentDetail";

describe("overviewDesiredSkillKeys", () => {
  it("prefers the live snapshot", () => {
    expect(overviewDesiredSkillKeys(["a"], { paperclipSkillSync: { desiredSkills: ["b"] } })).toEqual(["a"]);
  });
  it("falls back to the stored desired skills when the snapshot is unavailable", () => {
    expect(overviewDesiredSkillKeys(undefined, { paperclipSkillSync: { desiredSkills: ["b", 3, "c"] } })).toEqual(["b", "c"]);
  });
  it("returns nothing when neither exists", () => {
    expect(overviewDesiredSkillKeys(undefined, {})).toEqual([]);
    expect(overviewDesiredSkillKeys(undefined, null)).toEqual([]);
  });
});

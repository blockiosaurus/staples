import { describe, expect, it } from "vitest";
import { resolveCombinedInboxTasksEnabled } from "./useCombinedInboxTasksEnabled";

describe("resolveCombinedInboxTasksEnabled", () => {
  it("is on only when opted in", () => {
    expect(resolveCombinedInboxTasksEnabled({ enableCombinedInboxTasks: true })).toBe(true);
    expect(resolveCombinedInboxTasksEnabled({ enableCombinedInboxTasks: false })).toBe(false);
    expect(resolveCombinedInboxTasksEnabled(undefined)).toBe(false);
  });
});

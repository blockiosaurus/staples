import { describe, expect, it } from "vitest";
import { patchUiPreferencesSchema, surfaceIdSchema } from "./ui-preferences.js";

describe("patchUiPreferencesSchema", () => {
  it("accepts partial operations", () => {
    expect(patchUiPreferencesSchema.safeParse({ pin: ["nav.projects"], showEverything: true }).success).toBe(true);
  });
  it("rejects an empty patch", () => {
    expect(patchUiPreferencesSchema.safeParse({}).success).toBe(false);
  });
  it("rejects unknown keys", () => {
    expect(patchUiPreferencesSchema.safeParse({ pinned: ["nav.projects"] }).success).toBe(false);
  });
  it("rejects malformed surface ids", () => {
    expect(surfaceIdSchema.safeParse("Nav Projects").success).toBe(false);
    expect(surfaceIdSchema.safeParse("nav.projects").success).toBe(true);
  });
});

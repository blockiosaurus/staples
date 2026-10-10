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

describe("patchUiPreferencesSchema list limits", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `nav.s${i}`);
  it("accepts up to 20 ids per list", () => {
    expect(patchUiPreferencesSchema.safeParse({ hide: ids(20) }).success).toBe(true);
  });
  it("rejects more than 20 ids per list", () => {
    for (const key of ["pin", "unpin", "hide", "unhide", "reveal", "see"]) {
      expect(patchUiPreferencesSchema.safeParse({ [key]: ids(21) }).success).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { BrandKitError } from "./errors.js";
import { listFontPairings } from "./fonts.js";
import { outlineText } from "./outline.js";
describe("outlineText", () => {
  it("loads every catalogued heading font and returns path data", () => {
    for (const pairing of listFontPairings()) {
      const out = outlineText("Lantern", pairing.id, 40);
      expect(out.d.length).toBeGreaterThan(50);
      expect(out.width).toBeGreaterThan(40);
      expect(out.d).toMatch(/^M/);
    }
  });
  it("never emits NaN for any pairing or suffix", () => {
    for (const pairing of listFontPairings()) {
      for (const t of ["antern", "Lantern", "ntern", "Quick brown fox"]) expect(outlineText(t, pairing.id, 36).d).not.toContain("NaN");
    }
  });
  it("reports an unknown pairing as a BrandKitError", () => {
    expect(() => outlineText("Lantern", "no-such-pairing", 40)).toThrow(BrandKitError);
  });
  it("scales width with size", () => {
    const a = outlineText("Lantern", "modern-tech", 20).width;
    const b = outlineText("Lantern", "modern-tech", 40).width;
    expect(b / a).toBeCloseTo(2, 1);
  });
});

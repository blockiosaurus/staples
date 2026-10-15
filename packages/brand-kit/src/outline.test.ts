import { describe, expect, it } from "vitest";
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
  it("scales width with size", () => {
    const a = outlineText("Lantern", "modern-tech", 20).width;
    const b = outlineText("Lantern", "modern-tech", 40).width;
    expect(b / a).toBeCloseTo(2, 1);
  });
});

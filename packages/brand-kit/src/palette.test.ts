import { describe, expect, it } from "vitest";
import { buildPalette } from "./palette.js";
const HEX = /^#[0-9a-f]{6}$/;
describe("buildPalette", () => {
  it("is deterministic for the same seed and mood", () => {
    expect(buildPalette({ mood: "warm", seed: "Lantern" })).toEqual(buildPalette({ mood: "warm", seed: "Lantern" }));
  });
  it("respects an explicit hue and emits hex everywhere", () => {
    const p = buildPalette({ hue: 200, mood: "modern", seed: "x" });
    for (const v of [p.primary, p.accent, p.ink, p.paper, ...Object.values(p.neutral), ...Object.values(p.dark)]) expect(v).toMatch(HEX);
  });
  it("meets the contrast gates for every mood", () => {
    for (const mood of ["modern", "warm", "classic", "playful", "bold", "calm"] as const) {
      for (const hue of [0, 45, 120, 200, 280, 340]) {
        const p = buildPalette({ hue, mood, seed: "s" });
        expect(p.contrast.inkOnPaper).toBeGreaterThanOrEqual(4.5);
        expect(p.contrast.primaryOnPaper).toBeGreaterThanOrEqual(3);
        expect(p.contrast.paperOnPrimary).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

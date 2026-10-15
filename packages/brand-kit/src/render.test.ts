import { describe, expect, it } from "vitest";
import { renderBrandKit } from "./render.js";
const spec = { businessName: "Lantern", tagline: "Light for small rooms", mood: "warm" as const, fontPairingId: "editorial-warm", concepts: [
  { kind: "geometric" as const, name: "Lantern", shapes: [{ type: "circle" as const, cx: 32, cy: 32, r: 22, fill: "primary" as const }, { type: "rect" as const, x: 26, y: 10, w: 12, h: 6, rx: 2, fill: "accent" as const }] },
  { kind: "monogram" as const, name: "Lantern", letters: "L", frame: "circle" as const },
  { kind: "wordmark" as const, name: "Lantern", accentLetterIndex: 0 },
] };
describe("renderBrandKit", () => {
  it("renders one mark and one lockup per concept, all passing lint, with no text elements", () => {
    const out = renderBrandKit(spec);
    expect(out.concepts).toHaveLength(3);
    for (const c of out.concepts) {
      expect(c.lint.ok, c.lint.errors.join("; ")).toBe(true);
      expect(c.markSvg).toContain('viewBox="0 0 64 64"');
      expect(c.lockupSvg).toContain('viewBox="0 0 320 80"');
      expect(c.markSvg).not.toMatch(/<text/);
      expect(c.lockupSvg).not.toMatch(/<text/);
      expect(c.lockupSvg).toContain("<path");
    }
  });
  it("is deterministic", () => { expect(renderBrandKit(spec)).toEqual(renderBrandKit(spec)); });
  it("matches snapshots", () => { expect(renderBrandKit(spec).concepts.map((c) => c.markSvg)).toMatchSnapshot(); });
});

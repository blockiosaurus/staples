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

describe("accent wordmark", () => {
  const accentSpec = { ...spec, concepts: [{ kind: "wordmark" as const, name: "Lantern", accentLetterIndex: 0 }] };
  const plainSpec = { ...spec, concepts: [{ kind: "wordmark" as const, name: "Lantern" }] };
  const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]*)" fill="([^"]*)"/g)].map((m) => ({ d: m[1]!, fill: m[2]! }));
  // rightmost x over all word glyph paths: outer word offset + optional inner offset + path coordinates
  const maxX = (svg: string) => {
    const word = svg.slice(svg.indexOf("translate(84 "));
    let max = -Infinity;
    for (const g of word.matchAll(/(?:<g transform="translate\(([\d.]+) 0\)">)?<path d="([^"]*)"/g)) {
      const offset = 84 + Number(g[1] ?? 0);
      for (const seg of g[2]!.split(/[MLQCZ]/)) {
        const nums = seg.trim().split(/\s+/).filter(Boolean).map(Number);
        for (let k = 0; k < nums.length; k += 2) max = Math.max(max, offset + nums[k]!);
      }
    }
    return max;
  };
  it("keeps the whole word, colours only the accent letter, and matches the plain advance", () => {
    const accent = renderBrandKit(accentSpec).concepts[0]!;
    const plain = renderBrandKit(plainSpec).concepts[0]!;
    const a = paths(accent.lockupSvg);
    const p = paths(plain.lockupSvg);
    const pal = renderBrandKit(accentSpec).palette;
    expect(a.some((x) => x.d.includes("NaN"))).toBe(false);
    // mark glyph + accent letter + suffix vs mark glyph + whole word
    expect(a).toHaveLength(3);
    expect(a.slice(1).map((x) => x.fill)).toEqual([pal.accent, pal.ink]);
    const moves = (xs: typeof a) => xs.reduce((n, x) => n + (x.d.match(/M/g)?.length ?? 0), 0);
    expect(moves(a)).toBeGreaterThanOrEqual(moves(p));
    expect(Math.abs(maxX(accent.lockupSvg) - maxX(plain.lockupSvg))).toBeLessThan(1);
  });
});

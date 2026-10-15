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
  it("puts a paper background first in every lockup and leaves marks transparent", () => {
    const out = renderBrandKit(spec);
    for (const c of out.concepts) {
      const rect = `<rect x="0" y="0" width="320" height="80" rx="12" fill="${out.palette.paper}"/>`;
      expect(c.lockupSvg).toContain(`</title>${rect}`);
      expect(c.markSvg).not.toContain(rect);
    }
  });
  it("is deterministic", () => { expect(renderBrandKit(spec)).toEqual(renderBrandKit(spec)); });
  it("matches snapshots", () => { expect(renderBrandKit(spec).concepts.map((c) => c.markSvg)).toMatchSnapshot(); });
});

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

describe("accent wordmark", () => {
  const accentSpec = { ...spec, concepts: [{ kind: "wordmark" as const, name: "Lantern", accentLetterIndex: 0 }] };
  const plainSpec = { ...spec, concepts: [{ kind: "wordmark" as const, name: "Lantern" }] };
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

const one = (concept: Parameters<typeof renderBrandKit>[0]["concepts"][number], businessName = "Lantern") =>
  renderBrandKit({ ...spec, businessName, concepts: [concept] }).concepts[0]!;

describe("concept names", () => {
  it("draws each concept's own name in its lockup, not the working business name", () => {
    const r = renderBrandKit({ ...spec, businessName: "Working Name", concepts: [
      { kind: "wordmark", name: "Lantern" },
      { kind: "wordmark", name: "Ember House" },
    ] });
    expect(r.concepts[0]!.lockupSvg).toContain("<title>Lantern</title>");
    expect(r.concepts[1]!.lockupSvg).toContain("<title>Ember House</title>");
    expect(r.concepts[0]!.lockupSvg).not.toBe(r.concepts[1]!.lockupSvg);
  });
});

describe("unknown font pairing", () => {
  it("throws a BrandKitError", () => {
    expect(() => renderBrandKit({ ...spec, fontPairingId: "no-such-pairing" })).toThrow(/unknown font pairing/);
    expect(() => renderBrandKit({ ...spec, fontPairingId: "no-such-pairing" })).toThrow(expect.objectContaining({ name: "BrandKitError" }));
  });
});

describe("wordmark fitting", () => {
  it("shrinks a long name so the glyphs stay inside the lockup", () => {
    const c = one({ kind: "wordmark", name: "Wandering Harbour Lantern Company" });
    expect(c.lint.ok, c.lint.errors.join("; ")).toBe(true);
    expect(maxX(c.lockupSvg)).toBeLessThanOrEqual(308);
  });
});

describe("monogram frames", () => {
  it("renders square, rounded and none frames", () => {
    const sq = one({ kind: "monogram", name: "M", letters: "LA", frame: "square" }).markSvg;
    const ro = one({ kind: "monogram", name: "M", letters: "LA", frame: "rounded" }).markSvg;
    const no = one({ kind: "monogram", name: "M", letters: "LA", frame: "none" });
    const pal = renderBrandKit(spec).palette;
    expect(sq).toMatch(/<rect x="4" y="4" width="56" height="56" fill=/);
    expect(ro).toContain('rx="12"');
    expect(no.markSvg).not.toMatch(/<rect|<circle/);
    expect(no.markSvg).toContain(`fill="${pal.ink}"`);
    for (const svg of [sq, ro, no.markSvg]) expect(svg).toContain("<path");
    expect(no.lint.ok).toBe(true);
  });
});

describe("geometric shapes", () => {
  it("renders every shape type and passes lint", () => {
    const c = one({ kind: "geometric", name: "All", shapes: [
      { type: "circle", cx: 20, cy: 20, r: 10, fill: "primary" },
      { type: "rect", x: 30, y: 30, w: 20, h: 20, rx: 4, fill: "accent" },
      { type: "triangle", points: [[5, 60], [30, 40], [55, 60]], fill: "ink" },
      { type: "arc", cx: 32, cy: 32, r: 20, startDeg: 0, endDeg: 270, width: 4, stroke: "primary" },
      { type: "arc", cx: 32, cy: 32, r: 10, startDeg: 0, endDeg: 360, width: 2, stroke: "accent" },
      { type: "line", x1: 4, y1: 4, x2: 60, y2: 10, width: 3, stroke: "ink" },
    ] });
    expect(c.lint.ok, c.lint.errors.join("; ")).toBe(true);
    for (const tag of ["<circle", "<rect", "rx=\"4\"", "<polygon", "<path d=\"M", " A20 20 0 1 1 ", "<line", "stroke-linecap=\"round\""]) expect(c.markSvg).toContain(tag);
  });
});

describe("unsupported input", () => {
  it("reports an unsupported character as a concept lint error instead of throwing", () => {
    const c = one({ kind: "wordmark", name: "Lantern \u2603" });
    expect(c.lint.ok).toBe(false);
    expect(c.lint.errors.join(" ")).toContain("unsupported character");
    expect(c.markSvg).not.toContain("<path d=\"\"");
  });
  it("outlineText rejects empty text", async () => {
    const { outlineText } = await import("./outline.js");
    expect(() => outlineText("   ", "clean", 20)).toThrow(/empty text/);
  });
});

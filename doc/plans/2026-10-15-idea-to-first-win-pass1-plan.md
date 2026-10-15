# Idea to first win, pass 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sentence about a business in, a named company with three logo concepts, a palette and a brand starter out, with one vision question asked meanwhile.

**Architecture:** A pure package `packages/brand-kit` turns a small JSON spec into SVG (outlined OFL fonts, OKLCH palette, lint). The server exposes `render` (preview) and `publish` (store on the brand starter task) plus a `brand-starter` status endpoint. A new built-in agent, the brand designer, is provisioned with the Assistant and woken on a "Brand starter" task created at company creation. Stage 0 shows a card that lets the person pick a concept; the pick applies name and logo through the board's own branding permission.

**Tech Stack:** TypeScript, Express, Drizzle, zod 4, React 19, Vite, vitest (jsdom for UI), opentype.js, culori, svgo, @fontsource/* (OFL), sharp (already in server).

Design: `doc/plans/2026-10-15-idea-to-first-win-pass1-design.md`. Research notes (scratch, may be gone): `scratchpad/research/plan-server.md`, `plan-ui.md`, `plan-skills-pkg.md`, `svg-skills-web.md`.

## Global Constraints

- Product name constant `PRODUCT_NAME` ("Staples") from `@paperclipai/shared`; never the literal "Paperclip" in person-facing strings (guard `ui/src/__tests__/brand-guard.test.ts`).
- Person-facing copy under `ui/src/staples/**` must not contain the words adapter, harness, runtime, session, heartbeat, MCP, API, JSON, provider trace, lifecycle (guard `ui/src/__tests__/person-facing-copy.test.ts`; it scans `ui/src/staples/**` automatically).
- Token-only UI: no hex, raw px, arbitrary Tailwind brackets or `fontSize` in `ui/src/components/**` and `ui/src/pages/**`; follow the same rule under `ui/src/staples/**`. Run `pnpm check:token-gates` before committing UI.
- Every new route: `assertCompanyAccess`, consistent HTTP errors, `logActivity` on mutations, company-scoped queries.
- Fonts: only SIL OFL families, loaded from `@fontsource/*` packages; no font files committed. Final SVGs never contain `<text>`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `.claude/launch.json`. Never read `.env.local`.
- Run single test files with `pnpm exec vitest run <path>`; typecheck a package with `pnpm --filter <name> typecheck`.
- Stock versions: brand designer `"2026-10-15"`, Assistant `"2026-10-15"` (bumped in Task 8; tests pin it).
- Issue tagging for the brand starter: `originKind: "staples_brand_starter"`, `originId: <companyId>` (issues have no metadata column).
- Spec limits: 1 to 4 concepts, at most 12 shapes per geometric concept, business name 1 to 40 characters, tagline up to 80.

---

### Task 1: Shared contracts — working name, create-company kickoff, brand-kit spec and brand-starter types

**Files:**
- Create: `packages/shared/src/working-name.ts`, `packages/shared/src/working-name.test.ts`
- Create: `packages/shared/src/brand-kit.ts`, `packages/shared/src/brand-kit.test.ts`
- Create: `packages/shared/src/types/brand-starter.ts`
- Modify: `packages/shared/src/validators/company.ts` (createCompanySchema), `packages/shared/src/index.ts` (exports)

**Interfaces:**
- Produces: `deriveWorkingName(description: string): string`, `WORKING_NAME_MAX_LENGTH = 60`, `createCompanySchema` gains `kickoff: z.boolean().optional()`, `brandKitSpecSchema` + `BrandKitSpec`, `BrandKitConcept`, `BrandKitShape`, `BRAND_STARTER_ORIGIN_KIND = "staples_brand_starter"`, `BrandStarterStatus` type.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/working-name.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { deriveWorkingName, WORKING_NAME_MAX_LENGTH } from "./working-name.js";

describe("deriveWorkingName", () => {
  it("uses a name the person gives with 'called' or 'named'", () => {
    expect(deriveWorkingName("A candle shop in Austin called Lantern")).toBe("Lantern");
    expect(deriveWorkingName("I'm starting a bakery named Crumb & Co. We sell bread.")).toBe("Crumb & Co");
  });
  it("uses a quoted name", () => {
    expect(deriveWorkingName('A newsletter about jazz, "Blue Notes", twice a week')).toBe("Blue Notes");
  });
  it("drops leading filler and keeps up to four title-cased words", () => {
    expect(deriveWorkingName("I want to start a dog-walking service for busy professionals")).toBe("Dog-Walking Service");
    expect(deriveWorkingName("we're launching an online store selling vintage film cameras")).toBe("Online Store");
  });
  it("falls back when nothing usable remains", () => {
    expect(deriveWorkingName("")).toBe("New business");
    expect(deriveWorkingName("   ")).toBe("New business");
    expect(deriveWorkingName("I want to")).toBe("New business");
  });
  it("never exceeds the maximum length", () => {
    expect(deriveWorkingName("x".repeat(200)).length).toBeLessThanOrEqual(WORKING_NAME_MAX_LENGTH);
  });
});
```

`packages/shared/src/brand-kit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { brandKitSpecSchema } from "./brand-kit.js";

const base = { businessName: "Lantern", mood: "warm", fontPairingId: "editorial-warm" };

describe("brandKitSpecSchema", () => {
  it("accepts one concept of each kind", () => {
    const parsed = brandKitSpecSchema.parse({ ...base, concepts: [
      { kind: "geometric", name: "Lantern", shapes: [{ type: "circle", cx: 32, cy: 32, r: 20, fill: "primary" }] },
      { kind: "monogram", name: "Lantern", letters: "L", frame: "circle" },
      { kind: "wordmark", name: "Lantern", accentLetterIndex: 0 },
    ] });
    expect(parsed.concepts).toHaveLength(3);
  });
  it("rejects more than 12 shapes, more than 4 concepts, and unknown fills", () => {
    const shape = { type: "circle", cx: 1, cy: 1, r: 1, fill: "primary" };
    expect(() => brandKitSpecSchema.parse({ ...base, concepts: [{ kind: "geometric", name: "x", shapes: Array(13).fill(shape) }] })).toThrow();
    expect(() => brandKitSpecSchema.parse({ ...base, concepts: Array(5).fill({ kind: "wordmark", name: "x" }) })).toThrow();
    expect(() => brandKitSpecSchema.parse({ ...base, concepts: [{ kind: "geometric", name: "x", shapes: [{ ...shape, fill: "#fff" }] }] })).toThrow();
  });
  it("rejects a business name over 40 characters and a monogram over 2 letters", () => {
    expect(() => brandKitSpecSchema.parse({ ...base, businessName: "x".repeat(41), concepts: [{ kind: "wordmark", name: "x" }] })).toThrow();
    expect(() => brandKitSpecSchema.parse({ ...base, concepts: [{ kind: "monogram", name: "x", letters: "ABC", frame: "none" }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run packages/shared/src/working-name.test.ts packages/shared/src/brand-kit.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/shared/src/working-name.ts`:
```ts
/** A placeholder company name derived from a one-line business description. */
export const WORKING_NAME_MAX_LENGTH = 60;
const FALLBACK = "New business";
const FILLER = new Set(["i", "im", "i'm", "we", "we're", "were", "my", "our", "want", "wants", "would", "like", "to", "start", "starting",
  "launch", "launching", "open", "opening", "build", "building", "create", "creating", "run", "running", "make", "making", "sell", "selling",
  "a", "an", "the", "some", "new", "small", "little", "own", "online", "business", "company", "that", "which", "for", "of", "in", "on", "and", "is", "it", "about"]);
// "online" is filler only when another word follows it, see below.

function titleCase(word: string): string {
  return word.split("-").map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part)).join("-");
}

function clip(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
  return trimmed.length > WORKING_NAME_MAX_LENGTH ? trimmed.slice(0, WORKING_NAME_MAX_LENGTH).trimEnd() : trimmed;
}

export function deriveWorkingName(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return FALLBACK;
  const explicit = /\b(?:called|named)\s+([^.,;!?\n]{1,60})/i.exec(text);
  if (explicit?.[1]) return clip(explicit[1]) || FALLBACK;
  const quoted = /["“]([^"”]{1,60})["”]/.exec(text);
  if (quoted?.[1]) return clip(quoted[1]) || FALLBACK;
  const firstClause = text.split(/[.,;!?]/)[0] ?? "";
  const words = firstClause.split(" ").map((w) => w.replace(/^[^\w&-]+|[^\w&-]+$/g, "")).filter(Boolean);
  const kept: string[] = [];
  let past = false;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (!past && FILLER.has(lower) && lower !== "online") continue;
    if (!past && lower === "online" && kept.length === 0) { kept.push(word); continue; }
    past = true;
    if (FILLER.has(lower) && !["online"].includes(lower)) break;
    kept.push(word);
    if (kept.length === 4) break;
  }
  const name = clip(kept.map(titleCase).join(" "));
  return name || FALLBACK;
}
```
Adjust the filler handling until all five tests pass; the test expectations are the contract, the word list is not. In particular "online store selling vintage film cameras" must stop at "selling" (filler word after the name started ends the name) and "dog-walking service for busy professionals" must stop at "for".

`packages/shared/src/brand-kit.ts`:
```ts
import { z } from "zod";

export const BRAND_KIT_FILLS = ["primary", "accent", "ink", "paper"] as const;
export const BRAND_KIT_MOODS = ["modern", "warm", "classic", "playful", "bold", "calm"] as const;
export const BRAND_KIT_MAX_SHAPES = 12;
export const BRAND_KIT_GRID = 64; // mark viewBox is 0 0 64 64

const unit = z.number().min(0).max(BRAND_KIT_GRID);
const fill = z.enum(BRAND_KIT_FILLS);
export const brandKitShapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("circle"), cx: unit, cy: unit, r: z.number().min(1).max(32), fill }),
  z.object({ type: z.literal("rect"), x: unit, y: unit, w: z.number().min(1).max(64), h: z.number().min(1).max(64), rx: z.number().min(0).max(32).optional(), fill }),
  z.object({ type: z.literal("triangle"), points: z.tuple([z.tuple([unit, unit]), z.tuple([unit, unit]), z.tuple([unit, unit])]), fill }),
  z.object({ type: z.literal("arc"), cx: unit, cy: unit, r: z.number().min(2).max(31), startDeg: z.number().min(0).max(360), endDeg: z.number().min(0).max(360), width: z.number().min(1).max(16), stroke: fill }),
  z.object({ type: z.literal("line"), x1: unit, y1: unit, x2: unit, y2: unit, width: z.number().min(1).max(16), stroke: fill }),
]);
const conceptName = z.string().trim().min(1).max(40);
export const brandKitConceptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("geometric"), name: conceptName, shapes: z.array(brandKitShapeSchema).min(1).max(BRAND_KIT_MAX_SHAPES) }),
  z.object({ kind: z.literal("monogram"), name: conceptName, letters: z.string().trim().min(1).max(2), frame: z.enum(["circle", "square", "rounded", "none"]) }),
  z.object({ kind: z.literal("wordmark"), name: conceptName, accentLetterIndex: z.number().int().min(0).max(39).optional() }),
]);
export const brandKitSpecSchema = z.object({
  businessName: z.string().trim().min(1).max(40),
  tagline: z.string().trim().max(80).optional(),
  mood: z.enum(BRAND_KIT_MOODS),
  hue: z.number().min(0).max(360).optional(),
  fontPairingId: z.string().trim().min(1).max(40),
  concepts: z.array(brandKitConceptSchema).min(1).max(4),
}).strict();
export type BrandKitShape = z.infer<typeof brandKitShapeSchema>;
export type BrandKitConcept = z.infer<typeof brandKitConceptSchema>;
export type BrandKitSpec = z.infer<typeof brandKitSpecSchema>;
```

`packages/shared/src/types/brand-starter.ts`:
```ts
export const BRAND_STARTER_ORIGIN_KIND = "staples_brand_starter";
export interface BrandStarterConcept {
  index: number;            // 1-based, matches file names concept-<index>-*
  name: string;
  kind: "geometric" | "monogram" | "wordmark";
  markPath: string;         // /api/... content path of concept-<n>-mark.svg
  lockupPath: string;       // concept-<n>-lockup.svg
  previewPath: string | null; // concept-<n>-preview.png
}
export interface BrandStarterStatus {
  issue: { id: string; identifier: string; status: string } | null; // null: company has no brand starter
  designerName: string | null;
  latestNote: string | null;   // first line of the designer's latest comment
  concepts: BrandStarterConcept[];
  documentPath: string | null; // brand-starter.md
  palettePath: string | null;  // palette.json
  tagline: string | null;
}
```
Add `kickoff: z.boolean().optional()` to `createCompanySchema` (`packages/shared/src/validators/company.ts`). Export everything from `packages/shared/src/index.ts` next to the account-handle line, with `.js` suffixes.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run packages/shared/src/working-name.test.ts packages/shared/src/brand-kit.test.ts && pnpm --filter @paperclipai/shared typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): working-name derivation, create-company kickoff flag, brand-kit spec and brand-starter types"
```

---

### Task 2: `packages/brand-kit` — palette, fonts, templates, lint, render

**Files:**
- Create: `packages/brand-kit/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/brand-kit/src/index.ts`, `palette.ts`, `fonts.ts`, `outline.ts`, `templates.ts`, `lint.ts`, `render.ts`, `fonts.json`
- Create tests: `src/palette.test.ts`, `src/outline.test.ts`, `src/lint.test.ts`, `src/render.test.ts`
- Modify: root `vitest.config.ts` (add project), `pnpm-lock.yaml` via `pnpm install`

**Interfaces:**
- Consumes: `BrandKitSpec`, `BRAND_KIT_GRID` from `@paperclipai/shared`.
- Produces:
  - `buildPalette({ hue?: number; mood: Mood; seed: string }): BrandPalette` where `BrandPalette = { primary, accent, ink, paper, neutral: Record<"50"|"100"|"200"|"300"|"500"|"700"|"900", string>, dark: { primary, accent, ink, paper }, contrast: { inkOnPaper: number; primaryOnPaper: number; paperOnPrimary: number } }`, all hex.
  - `listFontPairings(): FontPairing[]`, `FontPairing = { id, label, heading: { family, file, weight }, body: { family }, moods: Mood[], industries: string[] }`.
  - `outlineText(text, pairingId, sizePx, opts?: { letterSpacing?: number }): { d: string; width: number; height: number; ascent: number }`.
  - `lintSvg(svg: string): { ok: boolean; errors: string[] }`.
  - `renderBrandKit(spec: BrandKitSpec): BrandKitRender` where `BrandKitRender = { palette: BrandPalette; pairing: FontPairing; concepts: Array<{ index, name, kind, markSvg: string, lockupSvg: string, lint: {ok, errors} }> }`.

- [ ] **Step 1: Package scaffold**

`packages/brand-kit/package.json` (copy fields from `packages/shared/package.json`, then):
```json
{
  "name": "@paperclipai/brand-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "test": "pnpm -w exec vitest run --root packages/brand-kit --config vitest.config.ts" },
  "dependencies": {
    "@paperclipai/shared": "workspace:*",
    "@fontsource/inter": "^5", "@fontsource/space-grotesk": "^5", "@fontsource/fraunces": "^5",
    "@fontsource/playfair-display": "^5", "@fontsource/nunito": "^5", "@fontsource/oswald": "^5",
    "culori": "^4", "opentype.js": "^1.3", "svgo": "^4"
  },
  "devDependencies": { "@types/culori": "^4", "@types/node": "^24", "@types/opentype.js": "^1.3", "typescript": "^7.0.2", "vitest": "catalog:" }
}
```
Use the same `vitest` version spec as `packages/shared` devDependencies (check whether it uses `catalog:`; copy exactly). `tsconfig.json` and `vitest.config.ts` copied from `packages/shared`. Add `"packages/brand-kit"` to the `projects` list in the root `vitest.config.ts`. Run `pnpm install` (background, up to 4 minutes). Then confirm each font package ships a 700 WOFF: `ls node_modules/@fontsource/<name>/files | grep 'latin-700-normal.woff$'` for all six; if a family lacks 700, use 600 and record it in `fonts.json`.

- [ ] **Step 2: Failing tests**

`src/palette.test.ts`:
```ts
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
```
`src/outline.test.ts`:
```ts
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
```
`src/lint.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { lintSvg } from "./lint.js";
const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>x</title><circle cx="32" cy="32" r="20" fill="#000"/></svg>';
describe("lintSvg", () => {
  it("accepts a plain mark", () => { expect(lintSvg(ok)).toEqual({ ok: true, errors: [] }); });
  it("rejects text, script, foreignObject, filters and external references", () => {
    for (const bad of ["<text x='1' y='1'>a</text>", "<script>1</script>", "<foreignObject/>", "<filter id='f'/>", "<image href='http://x/y.png'/>"]) {
      const r = lintSvg(ok.replace("</svg>", `${bad}</svg>`));
      expect(r.ok).toBe(false);
    }
  });
  it("rejects a missing viewBox and shapes outside the box", () => {
    expect(lintSvg(ok.replace(' viewBox="0 0 64 64"', "")).ok).toBe(false);
    expect(lintSvg(ok.replace('r="20"', 'r="40"')).ok).toBe(false);
  });
  it("rejects malformed XML", () => { expect(lintSvg("<svg viewBox='0 0 1 1'><circle").ok).toBe(false); });
});
```
`src/render.test.ts`:
```ts
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
```

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm exec vitest run --root packages/brand-kit --config packages/brand-kit/vitest.config.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`fonts.json` (six pairings; `file` is the path inside the fontsource package):
```json
[
  { "id": "modern-tech", "label": "Space Grotesk + Inter", "heading": { "family": "Space Grotesk", "package": "@fontsource/space-grotesk", "file": "files/space-grotesk-latin-700-normal.woff", "weight": 700 }, "body": { "family": "Inter" }, "moods": ["modern", "bold"], "industries": ["software", "studio", "agency"] },
  { "id": "editorial-warm", "label": "Fraunces + Inter", "heading": { "family": "Fraunces", "package": "@fontsource/fraunces", "file": "files/fraunces-latin-700-normal.woff", "weight": 700 }, "body": { "family": "Inter" }, "moods": ["warm", "classic"], "industries": ["food", "craft", "newsletter", "shop"] },
  { "id": "classic-trust", "label": "Playfair Display + Inter", "heading": { "family": "Playfair Display", "package": "@fontsource/playfair-display", "file": "files/playfair-display-latin-700-normal.woff", "weight": 700 }, "body": { "family": "Inter" }, "moods": ["classic", "calm"], "industries": ["consulting", "finance", "law", "boutique"] },
  { "id": "friendly", "label": "Nunito + Inter", "heading": { "family": "Nunito", "package": "@fontsource/nunito", "file": "files/nunito-latin-800-normal.woff", "weight": 800 }, "body": { "family": "Inter" }, "moods": ["playful", "warm"], "industries": ["pets", "kids", "fitness", "community"] },
  { "id": "bold-craft", "label": "Oswald + Inter", "heading": { "family": "Oswald", "package": "@fontsource/oswald", "file": "files/oswald-latin-600-normal.woff", "weight": 600 }, "body": { "family": "Inter" }, "moods": ["bold"], "industries": ["trades", "sports", "outdoors", "coffee"] },
  { "id": "clean", "label": "Inter", "heading": { "family": "Inter", "package": "@fontsource/inter", "file": "files/inter-latin-700-normal.woff", "weight": 700 }, "body": { "family": "Inter" }, "moods": ["modern", "calm"], "industries": ["services", "health", "general"] }
]
```
Fix any `file` that does not exist in the installed package (check `ls`); the test loads all six.

`fonts.ts`: `listFontPairings()` returns the JSON (import with `with { type: "json" }` or `createRequire`), `getFontPairing(id)` throws `BrandKitError("unknown font pairing")`. `resolveFontPath(pairing)` = `createRequire(import.meta.url).resolve(`${pkg}/${file}`)`.

`outline.ts`: load with `opentype.parse(readFileSync(path).buffer.slice(...))` once per pairing (cache in a Map); `font.getPath(text, 0, 0, size, { kerning: true, letterSpacing })` → `toPathData(2)`; width from `font.getAdvanceWidth(text, size, opts)`; height = size; ascent = `font.ascender / font.unitsPerEm * size`. Return `{ d, width, height, ascent }`.

`palette.ts` (culori): hue = `spec.hue ?? hashHue(seed)` (FNV-1a of the seed mod 360). Per mood: `{ modern: { L: 0.55, C: 0.16, accentShift: 180 }, warm: { L: 0.62, C: 0.15, accentShift: 30 }, classic: { L: 0.42, C: 0.10, accentShift: -30 }, playful: { L: 0.68, C: 0.19, accentShift: 150 }, bold: { L: 0.50, C: 0.20, accentShift: 180 }, calm: { L: 0.66, C: 0.08, accentShift: -45 } }`. primary = `oklch(L C hue)` gamut-clamped via `clampChroma`; accent = same with hue + accentShift and C × 0.85; ink = `oklch(0.22 0.02 hue)`; paper = `oklch(0.985 0.01 hue)`; neutral ramp L = {50: 0.985, 100: 0.96, 200: 0.92, 300: 0.85, 500: 0.62, 700: 0.42, 900: 0.22} at C 0.015. dark = { paper: oklch(0.17 0.02 hue), ink: oklch(0.95 0.01 hue), primary: lighten primary to L+0.12, accent likewise }. Gates with `wcagContrast`: while `inkOnPaper < 4.5` lower ink L by 0.02; while `primaryOnPaper < 3` lower primary L by 0.02 (floor 0.3); `paperOnPrimary` is the same ratio as primaryOnPaper (symmetric), report both. Format with `formatHex`.

`templates.ts`: pure string builders on the 64-grid. `markSvg(concept, palette, outline)`:
- geometric: `<svg xmlns viewBox="0 0 64 64"><title>{name}</title>` + each shape mapped to `<circle>`, `<rect>`, `<polygon>`, arc as `<path d="M … A …" fill="none" stroke=… stroke-width=… stroke-linecap="round"/>`, `<line>`; fills resolved from palette by name.
- monogram: frame (circle r=30 / square 4..60 / rounded rx=12 / none) in primary, letters outlined at size that fits 36 units wide (scale from `outlineText(letters, pairing, 40).width`), centred, fill paper (or ink when frame none).
- wordmark: mark = first letter in a rounded square (same as monogram with frame "rounded").
`lockupSvg`: `viewBox="0 0 320 80"`, mark scaled to 56 at (12,12), wordmark outline at size 36 starting x=84, vertically centred using ascent; optional accent letter: split the outline by rendering the name in two calls (prefix, letter, suffix) with advance-width offsets, colouring the accent letter `accent`. Tagline is not drawn (it goes in the document).

`lint.ts`: parse with `svgo`'s `optimize` wrapped in try/catch (parse failure → error "malformed"); additionally a small regex/DOM pass using `@xmldom/xmldom` is not needed — use svgo's parsed AST via a custom plugin that walks nodes: allowed elements `svg, title, g, path, circle, rect, polygon, line, ellipse, defs, clipPath`; reject `text, tspan, script, foreignObject, filter, image, use, style, a` and any attribute starting with `on`, any `href`/`xlink:href`; require `viewBox` on root; compute a conservative bbox for circle/rect/line/polygon/ellipse (paths skipped) and fail when it exceeds the viewBox by more than 0.5 units. Return `{ ok, errors }`. Keep the output SVG un-minified (lint only validates).

`render.ts`: `renderBrandKit(spec)` = parse with `brandKitSpecSchema`, `buildPalette`, `getFontPairing`, map concepts to `{ index: i+1, name, kind, markSvg, lockupSvg, lint: merge(lintSvg(mark), lintSvg(lockup)) }`.

`index.ts` re-exports all of the above plus `BrandKitError`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm exec vitest run --root packages/brand-kit --config packages/brand-kit/vitest.config.ts && pnpm --filter @paperclipai/brand-kit typecheck`
Expected: PASS; the snapshot file is created on the first run (commit it).

- [ ] **Step 6: Commit**

```bash
git add packages/brand-kit vitest.config.ts pnpm-lock.yaml && git commit -m "feat(brand-kit): deterministic palette, outlined wordmarks, mark templates and lint"
```

---

### Task 3: Server — brand starter service, render/publish routes, status route

**Files:**
- Create: `server/src/services/brand-starter.ts`, `server/src/routes/brand-kit.ts`
- Create: `server/src/__tests__/brand-kit-routes.test.ts` (mocked service, supertest), `server/src/__tests__/brand-starter.test.ts` (embedded Postgres; auto-skips)
- Modify: `server/package.json` (add `"@paperclipai/brand-kit": "workspace:*"`), `server/src/app.ts` (mount), `server/src/routes/index.ts` (export)

**Interfaces:**
- Consumes: `renderBrandKit`, `BrandKitSpec`, `BRAND_STARTER_ORIGIN_KIND`, `BrandStarterStatus`, `issueService(db).create/getById/createAttachment`, `storage.putFile`, `logActivity`, `queueIssueAssignmentWakeup`, `builtInAgentService(db)`.
- Produces:
  - `brandStarterService(db)` with `start(companyId, { description, userId }): Promise<{ issueId } | null>` (null when no brand designer agent exists), `findIssue(companyId)`, `status(companyId): Promise<BrandStarterStatus>`, `publish(companyId, { issueId, spec, document, actor }): Promise<BrandStarterStatus>`.
  - Routes: `POST /api/companies/:companyId/brand-kit/render` → `{ palette, pairing: { id, label }, concepts: [{ index, name, kind, lint, markSvg, lockupSvg, previewPng: base64 }] }`; `POST /api/companies/:companyId/brand-kit/publish` body `{ issueId, spec, document: string(max 20000), tagline?: string }` → `BrandStarterStatus`; `GET /api/companies/:companyId/brand-starter` → `BrandStarterStatus`.

- [ ] **Step 1: Failing route test (mocked service)**

Copy the shape of `server/src/__tests__/company-signals-routes.test.ts`. Mock `../services/brand-starter.js` (`status`, `publish`) and `@paperclipai/brand-kit` is real. Cases:
- `GET /api/companies/<id>/brand-starter` as a board member returns the mocked status; as an agent of another company returns 403.
- `POST .../brand-kit/render` with the Task 2 spec returns 3 concepts, each with `previewPng` non-empty base64 and `lint.ok === true`; an invalid spec (5 concepts) returns 400.
- `POST .../brand-kit/publish` as a company agent calls `publish` with `{ issueId, spec, document }` and returns its result; with a non-uuid issueId returns 400.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec vitest run server/src/__tests__/brand-kit-routes.test.ts` → FAIL.

- [ ] **Step 3: Implement the service**

`server/src/services/brand-starter.ts`:
- `findIssue(companyId)`: `db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, BRAND_STARTER_ORIGIN_KIND), eq(issues.originId, companyId))).limit(1)`.
- `start(companyId, { description, userId })`: locate the brand designer with `builtInAgentService(db).get(companyId, "brand-designer")` (Task 4 adds it; until then this returns null → return null). If an issue already exists return it. Create via `issueService(db).create(companyId, { title: "Brand starter", description: BRAND_STARTER_BODY(description), status: "todo", priority: "high", assigneeAgentId: agent.id, originKind: BRAND_STARTER_ORIGIN_KIND, originId: companyId, createdByUserId: userId, actorResponsibleUserId: userId, trustExplicitResponsibleUserId: true })`. Body template:
  ```
  The person described their business as:

  > {description}

  Follow the `staples-brand-kit` skill: three concepts (a geometric mark, a monogram, a wordmark), a palette and a one-page brand starter. Publish with the brand-kit publish call, then comment with one line per concept and mark this task done.
  ```
  Then `logActivity(db, { companyId, actorType: "user", actorId: userId, action: "issue.created", entityType: "issue", entityId: issue.id, details: { originKind: BRAND_STARTER_ORIGIN_KIND } })` and `void queueIssueAssignmentWakeup({ heartbeat: heartbeatService(db), issue: { id, assigneeAgentId, status }, reason: "issue_assigned", mutation: "create", contextSource: "issue.create", requestedByActorType: "user", requestedByActorId: userId })` (same call as `routes/plans.ts`).
- `status(companyId)`: issue or `{ issue: null, … }`; list the issue's attachments (`svc.listAttachments(issueId)` or the query the attachments route uses); map by `originalFilename`: `concept-<n>-mark.svg`, `concept-<n>-lockup.svg`, `concept-<n>-preview.png`, `brand-starter.md`, `palette.json`, `brand-starter.json` (manifest: `{ concepts: [{ index, name, kind }], tagline }`). Content paths via the same helper the artifacts list uses (`attachmentContentPath(attachmentId)`). `latestNote` = first line of the newest agent comment on the issue (comment service list, newest first), `designerName` = agent display name.
- `publish(companyId, { issueId, spec, document, tagline, actor })`: verify the issue belongs to the company and is the brand starter issue (else 404/422); `renderBrandKit(spec)`; rasterise each lockup to a 512-wide PNG with sharp (`sharp(Buffer.from(svg), { density: 300 }).resize({ width: 512 }).png().toBuffer()`); write attachments with the exact code path of the upload route (`storage.putFile` + `svc.createAttachment`, actor fields from `actor`), file names as above plus `palette.json` (the palette object) and `brand-starter.json`; replace existing attachments with the same filenames (delete old rows first so re-publishing is idempotent); `logActivity` with action `"issue.brand_kit_published"`; return `status(companyId)`.

- [ ] **Step 4: Implement the routes**

`server/src/routes/brand-kit.ts`:
```ts
export function brandKitRoutes(db: Db) {
  const router = Router();
  const starter = brandStarterService(db);
  router.get("/companies/:companyId/brand-starter", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    res.json(await starter.status(companyId));
  });
  router.post("/companies/:companyId/brand-kit/render", validate(brandKitSpecSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    const out = renderBrandKit(req.body);
    const concepts = await Promise.all(out.concepts.map(async (c) => ({ ...c, previewPng: (await rasterize(c.lockupSvg, 512)).toString("base64") })));
    res.json({ palette: out.palette, pairing: { id: out.pairing.id, label: out.pairing.label }, concepts });
  });
  router.post("/companies/:companyId/brand-kit/publish", validate(publishSchema), async (req, res) => { /* assertCompanyAccess; starter.publish(...); res.status(201).json(status) */ });
  return router;
}
```
`publishSchema = z.object({ issueId: z.uuid(), spec: brandKitSpecSchema, document: z.string().max(20000), tagline: z.string().max(80).optional() })`. `rasterize` lives in the service file (sharp imported there, not in brand-kit). Mount in `app.ts` next to `companySignalsRoutes`; export from `routes/index.ts`.

- [ ] **Step 5: Service test (embedded Postgres, copy `plans-apply-routes.test.ts` setup)**

Seed a company, a user membership, and an agent with `metadata: { paperclipBuiltInAgent: { key: "brand-designer", featureKeys: ["brand-designer"] } }` (insert directly; Task 4 adds the definition, the service only needs the marker). Assert: `start` creates one issue tagged with the origin kind and assigned to that agent, a second `start` returns the same issue; `publish` stores 3×3 + 3 files and `status` lists 3 concepts with paths; re-publish keeps the count stable. If `builtInAgentService(db).get` requires the definition, fall back to a direct query by marker key in the service (`agents.metadata -> 'paperclipBuiltInAgent' ->> 'key' = 'brand-designer'`), which is what the test seeds.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm exec vitest run server/src/__tests__/brand-kit-routes.test.ts server/src/__tests__/brand-starter.test.ts && pnpm --filter server typecheck` (use the server package's actual name from `server/package.json`).
Expected: PASS (the embedded-Postgres suite may skip on this machine; say so in the report).

- [ ] **Step 7: Commit**

```bash
git add server pnpm-lock.yaml && git commit -m "feat(server): brand starter service, brand-kit render/publish routes and status route"
```

---

### Task 4: Brand designer built-in agent, skill, and company-create kickoff

**Files:**
- Create: `server/src/built-ins/agents/brand-designer/AGENTS.md`, `skills/staples-brand-kit/SKILL.md`
- Modify: `server/src/services/built-in-agents.ts` (definition, `AUTO_PROVISION_ON_COMPANY_CREATE_KEYS`, fallback text), `server/src/routes/companies.ts` (kickoff), `server/src/__tests__/built-in-agents.test.ts` (keys list), new `server/src/__tests__/brand-designer.test.ts`

**Interfaces:**
- Consumes: `brandStarterService(db).start`, routes from Task 3.
- Produces: built-in key `"brand-designer"`, skill key `paperclipai/paperclip/staples-brand-kit`.

- [ ] **Step 1: Failing test**

`server/src/__tests__/brand-designer.test.ts` (pattern of `assistant-weekly-update.test.ts` l.91-100):
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listBuiltInAgentDefinitions } from "../services/built-in-agents.js";
describe("brand designer built-in", () => {
  const def = listBuiltInAgentDefinitions().find((d) => d.key === "brand-designer")!;
  it("is defined with the brand-kit skill and no hire approval", () => {
    expect(def).toBeTruthy();
    expect(def.bundle?.stockVersion).toBe("2026-10-15");
    expect(def.bypassHireApproval).toBe(true);
    expect(def.inheritCompanyAdapterType).toBe(true);
    expect(def.defaultSkillKeys).toContain("paperclipai/paperclip/staples-brand-kit");
    expect(def.defaultRole).toBe("designer");
  });
  it("ships the skill and instructions", () => {
    const skill = readFileSync(new URL("../../../skills/staples-brand-kit/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("brand-kit/render");
    expect(skill).toContain("brand-kit/publish");
    expect(def.defaultInstructions).toContain("brand designer");
  });
});
```
Update `built-in-agents.test.ts` l.241-262 key list to include `"brand-designer"` (sorted).

- [ ] **Step 2: Run to confirm failure** → `pnpm exec vitest run server/src/__tests__/brand-designer.test.ts server/src/__tests__/built-in-agents.test.ts`.

- [ ] **Step 3: Definition**

Add to `DEFINITIONS` (model on the Assistant entry): `key: "brand-designer"`, `displayName: "Brand designer"`, `featureKeys: ["brand-designer"]`, `shortPurpose: "Makes the first name, logo and palette ideas for a new company."`, `defaultInstructions: BRAND_DESIGNER_INSTRUCTIONS` (`readBuiltInText("brand-designer/AGENTS.md", FALLBACK_BRAND_DESIGNER)`), `defaultRole: "designer"`, `defaultTitle: "Brand designer"`, `defaultIcon: "palette"`, `defaultPermissions: { canCreateAgents: false, canCreateSkills: false }`, `defaultStatus: "idle"`, `defaultManager: null`, `allowedAdapterTypes: [...ASSISTANT_RUNTIME_ADAPTER_TYPES]`, `defaultAdapterType: "claude_local"`, `defaultBudgetMonthlyCents: 0`, `bypassHireApproval: true`, `inheritCompanyAdapterType: true`, `defaultSkillKeys: ["paperclipai/paperclip/staples-brand-kit"]`, `bundle: { stockVersion: "2026-10-15", instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": BRAND_DESIGNER_INSTRUCTIONS } } }`. Add the key to `AUTO_PROVISION_ON_COMPANY_CREATE_KEYS`. Check `agent-assignability.ts`: the brand designer must be assignable (only the Assistant is refused); if the rule keys on the built-in marker generally, scope it to the Assistant key.

- [ ] **Step 4: AGENTS.md and SKILL.md**

`server/src/built-ins/agents/brand-designer/AGENTS.md` (plain language, no secrets):
```
You are the brand designer, a built-in agent at Staples. You make the first name, logo and palette ideas for a new company so the person sees something real within minutes.

When you wake up on a "Brand starter" task, follow the `staples-brand-kit` skill end to end: read the description, decide on three distinct concepts, render them, look at the previews once, publish, comment, and mark the task done. Do not ask the person questions; make reasonable choices and say what you assumed in your comment.

You decide; code draws. Never write SVG by hand and never paste SVG into comments. Keep concepts simple: a few shapes, two colours at most per mark.

Hard boundaries: you do not rename the company, upload a logo to company settings, hire anyone, or touch anything outside your task. The person picks a concept on their screen.
```
`skills/staples-brand-kit/SKILL.md` (frontmatter `name: staples-brand-kit`, `description: Produce three logo concepts, a palette and a one-page brand starter for a new company from its description, using the brand-kit render and publish calls.`). Body sections:
1. **Read** the task (`$PAPERCLIP_TASK_ID`): the description, and whether the person already chose a name (the task body says so; otherwise propose up to three names, one per concept).
2. **Decide**: industry, mood (one of modern, warm, classic, playful, bold, calm), a font pairing from the list (modern-tech, editorial-warm, classic-trust, friendly, bold-craft, clean) and three concepts: geometric (2 to 8 shapes on the 64-grid, describe the idea in one line first), monogram (1 or 2 letters, a frame), wordmark (optional accent letter). Anti-generic list: no swooshes, no globe, no generic leaf unless the business is plants, no gradient, no more than two colours per mark.
3. **Render**: write `spec.json`, then
   ```bash
   curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/render" \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @spec.json > render.json
   jq -r '.concepts[] | "\(.index) \(.lint.ok) \(.lint.errors|join(";"))"' render.json
   for i in 1 2 3; do jq -r ".concepts[$((i-1))].previewPng" render.json | base64 -d > "preview-$i.png"; done
   ```
   Look at each `preview-N.png`. Fix lint errors. Revise at most once for balance or legibility, then stop.
4. **Write** `brand-starter.md`: chosen names (one per concept), tagline, a positioning paragraph, the palette (from `render.json` `.palette`), the type pairing, three dos and three don'ts.
5. **Publish**:
   ```bash
   jq -n --arg issueId "$PAPERCLIP_TASK_ID" --rawfile document brand-starter.md --slurpfile spec spec.json \
     '{issueId: $issueId, spec: $spec[0], document: $document}' > publish.json
   curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/publish" \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @publish.json
   ```
   Check the response lists three concepts. If it fails, say so in your comment and leave the task in review.
6. **Finish**: one comment (one line per concept: name, idea, why), then mark the task done with the `paperclip` skill's status script.

- [ ] **Step 5: Company-create kickoff**

In `server/src/routes/companies.ts` `POST /`, after `company` is in scope for both branches and before `res.status(201)`: `if (req.body.kickoff) { try { await brandStarterService(db).start(company.id, { description: company.description ?? "", userId: ownerPrincipalId }); } catch (err) { logger.warn({ err, companyId: company.id }, "brand starter did not start"); } }`. `kickoff` must not reach `svc.create` (strip it from the body passed on). Confirm `autoProvisionBundledAgents` now creates the brand designer (it loops `DEFINITIONS` with a bundle and checks the auto-provision set). Add a route test case in an existing companies route test if one has the mocked pattern; otherwise cover `start` through Task 3's test and note it.

- [ ] **Step 6: Run tests**

Run: `pnpm exec vitest run server/src/__tests__/brand-designer.test.ts server/src/__tests__/built-in-agents.test.ts server/src/__tests__/assistant-weekly-update.test.ts` → PASS. Typecheck server.

- [ ] **Step 7: Commit**

```bash
git add server skills/staples-brand-kit && git commit -m "feat(agents): brand designer built-in with brand-kit skill; company create kickoff starts the brand starter task"
```

---

### Task 5: Start page — describe the business, derived name, optional name field

**Files:**
- Modify: `ui/src/staples/start/StartCompanyPage.tsx`, `ui/src/staples/start/StartCompanyPage.test.tsx`, `ui/src/api/companies.ts` (`create` accepts `kickoff?: boolean`)

**Interfaces:**
- Consumes: `deriveWorkingName` from `@paperclipai/shared`.
- Produces: `navigate(`/${prefix}/assistant`, { replace: true, state: { firstMessage: description } })`; `companiesApi.create({ name, description, kickoff: true })`.

- [ ] **Step 1: Update tests first**

In `StartCompanyPage.test.tsx` keep the mocks, then:
- "creates from a description with a derived name": type `"A candle shop in Austin called Lantern"` into the textarea `#start-company-description`, submit; expect `create` called with `{ name: "Lantern", description: "A candle shop in Austin called Lantern", kickoff: true }` and `navigate` called with `("/NEW/assistant", { replace: true, state: { firstMessage: "A candle shop in Austin called Lantern" } })`.
- "lets the person give a name": click the button "Have a name already?", type `"Newco"` in `#start-company-name`, type a description, submit; expect `name: "Newco"`.
- "disables Create until the description has text": button disabled when empty.
- Replace the "exactly one input" assertion with: no `input[type=text]` until the disclosure is opened.
Add a `type` helper for `HTMLTextAreaElement` (native value setter on `HTMLTextAreaElement.prototype`).

- [ ] **Step 2: Run** `pnpm exec vitest run ui/src/staples/start/StartCompanyPage.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

Page: `StartShell` title **"What business do you want to start?"**; a `<Textarea id="start-company-description" rows={3} placeholder="A candle shop in Austin that sells online and at markets">` (use `ui/src/components/ui/textarea.tsx` if present, else a token-styled `<textarea className="w-full rounded-md border border-input bg-background p-3 text-sm">`); helper `<p className="text-xs text-muted-foreground">One or two sentences is plenty. You can change everything later.</p>`; a `<button type="button" className="text-sm text-muted-foreground underline">Have a name already?</button>` toggling a `Label` + `Input id="start-company-name"` (placeholder "Lantern Candle Co"); submit `Create` disabled unless `description.trim()`. On submit: `const name = typedName.trim() || deriveWorkingName(description)`; create with `{ name, description: description.trim(), kickoff: true }`; navigate with state as above. Cloud path unchanged. Keep the `aria-live` error line.

- [ ] **Step 4: Run tests, copy guard, token gates**

Run: `pnpm exec vitest run ui/src/staples/start/StartCompanyPage.test.tsx ui/src/__tests__/person-facing-copy.test.ts && pnpm check:token-gates` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/staples/start ui/src/api/companies.ts && git commit -m "feat(start): describe the business in one field; the company name is derived unless given"
```

---

### Task 6: Seed the first Assistant message from the start page

**Files:**
- Modify: `ui/src/staples/assistant/StageZeroShell.tsx`, add `ui/src/staples/assistant/StageZeroShell.test.tsx` (or extend `Assistant.test.tsx` if StageZeroShell is already covered there)

**Interfaces:**
- Consumes: `useAssistantShell().askAssistant({ text, send: true, context })`, `useLocation().state.firstMessage` from `@/lib/router`.
- Produces: the first message is sent once the Assistant is available, with a context line `About: Sent from the start page. Time zone <Intl zone>, language <navigator.language> (/start)`.

- [ ] **Step 1: Failing test**

Render `StageZeroShell` inside `MemoryRouter initialEntries={[{ pathname: "/NEW/assistant", state: { firstMessage: "A candle shop" } }]}` with a mocked `AssistantProvider` value (`available: false` then `true`) and `AssistantConversation` stubbed. Assert `askAssistant` is not called while unavailable, called exactly once with `{ text: "A candle shop", send: true, context: { label: expect.stringContaining("Time zone"), href: "/start" } }` after `available` flips, and not again on re-render.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

In `StageZeroShell`: `const location = useLocation(); const navigate = useNavigate(); const shell = useAssistantShell(); const firedRef = useRef(false);`
```ts
useEffect(() => {
  const text = (location.state as { firstMessage?: string } | null)?.firstMessage;
  if (!text || firedRef.current || !shell?.available) return;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sent = shell.askAssistant({ text, send: true, context: { label: `Sent from the start page. Time zone ${zone}, language ${navigator.language}`, href: "/start" } });
  if (sent) { firedRef.current = true; navigate(location.pathname, { replace: true, state: null }); }
}, [location.state, location.pathname, navigate, shell]);
```
Confirm `askAssistant` with `send: true` is consumed by the thread even while the composer is blocked for "setup starting" (it checks `available`, which is the Assistant GET succeeding; if the thread drops a send while setup is `starting`, gate on `setup.state === "ready"` from `useAssistant()` instead and say so in the report).

- [ ] **Step 4: Run** the new test plus `ui/src/staples/assistant/Assistant.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/staples/assistant && git commit -m "feat(stage0): send the business description as the first Assistant message with time zone context"
```

---

### Task 7: Brand starter card in Stage 0

**Files:**
- Create: `ui/src/api/brand-starter.ts`, `ui/src/staples/assistant/BrandStarterCard.tsx`, `ui/src/staples/assistant/BrandStarterCard.test.tsx`
- Modify: `ui/src/lib/queryKeys.ts` (`brandStarter.status(companyId) = ["brand-starter", companyId]`), `ui/src/staples/assistant/StageZeroShell.tsx` (mount above the conversation)

**Interfaces:**
- Consumes: `GET /companies/:id/brand-starter` → `BrandStarterStatus`; `assetsApi.uploadCompanyLogo(companyId, file)`; `companiesApi.updateBranding(companyId, { name?, logoAssetId })`; `useCompany().selectedCompany`.
- Produces: `brandStarterApi.get(companyId)`.

- [ ] **Step 1: Failing component test**

Mock `@/api/brand-starter`, `@/api/assets`, `@/api/companies`, `@/context/CompanyContext`. Cases:
- status `{ issue: null }` → renders nothing.
- issue todo/in_progress, no concepts → text "Your brand designer is working on name and logo ideas" and the `latestNote` line.
- three concepts → three tiles, each an `<img>` with the lockup path, the name, and a button "Use this"; clicking tile 2 calls `uploadCompanyLogo` with a File whose name is `concept-2-mark.svg` (mock `fetch` to return the SVG blob) then `updateBranding(companyId, { name: "Lantern", logoAssetId: "asset-1" })`; afterwards the card shows "Applied" and a link to `/NEW/artifacts` labelled "See what we've made".
- "Keep my name" checkbox checked → `updateBranding` called with `{ logoAssetId }` only.
- `selectedCompany.logoAssetId` already set → compact "Brand applied" state with a dismiss button that writes `localStorage["staples.brandStarter.dismissed.<companyId>"]`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`brandStarterApi.get = (companyId) => api.get<BrandStarterStatus>(`/companies/${companyId}/brand-starter`)`. Query: `useQuery({ queryKey: queryKeys.brandStarter.status(companyId), queryFn, enabled: !!companyId, refetchInterval: (q) => { const d = q.state.data; if (!d?.issue) return false; return d.concepts.length ? false : 5_000; } })`. Card markup per `WeeklyUpdateCard` classes: `<section aria-label="Brand starter" data-testid="brand-starter-card" className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-card p-3">`. Tiles: `grid gap-3 sm:grid-cols-3`, each `<figure className="flex flex-col gap-2 rounded-md border border-border p-2">` with `<img src={lockupPath} alt={`${name} logo idea`} className="aspect-video w-full object-contain bg-accent/20">`, `<figcaption className="text-sm font-medium text-foreground">`, `<Button size="sm">Use this</Button>`. Apply: `const res = await fetch(markPath); const blob = await res.blob(); const file = new File([blob], `concept-${index}-mark.svg`, { type: "image/svg+xml" }); const asset = await assetsApi.uploadCompanyLogo(companyId, file); await companiesApi.updateBranding(companyId, keepName ? { logoAssetId: asset.assetId } : { name, logoAssetId: asset.assetId }); await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });` with a `role="alert"` error line on failure. Mount in `StageZeroShell` inside `<main>` above the conversation, wrapped in `px-3 pt-3`. Check the result at 375px: tiles stack (`sm:` breakpoint), no horizontal scroll.

- [ ] **Step 4: Run** the test, `person-facing-copy.test.ts`, `pnpm check:token-gates` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src && git commit -m "feat(stage0): brand starter card with concept tiles that apply name and logo"
```

---

### Task 8: Interview pacing, vision question, plan goal, Assistant prompt

**Files:**
- Modify: `skills/staples-interview/SKILL.md`, `skills/staples-plan/SKILL.md`, `skills/staples-company-brief/SKILL.md`, `server/src/built-ins/agents/assistant/AGENTS.md`, `server/src/services/built-in-agents.ts` (Assistant `stockVersion: "2026-10-15"`), `server/src/__tests__/assistant-weekly-update.test.ts` (l.94, l.207 pins), add `server/src/__tests__/assistant-first-win.test.ts`

- [ ] **Step 1: Failing test**

`assistant-first-win.test.ts`: read the three SKILL.md files and the Assistant definition; assert the interview skill contains "at most 3 questions" and "30 days", the plan skill says the goal comes from the 30-day answer, the brief skill has a "Where this is going" section, the Assistant instructions mention "brand designer", and `stockVersion === "2026-10-15"`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Edit the skills and prompt**

`staples-interview/SKILL.md` "Rounds":
- Replace "At most 4 questions per card" with: "**Round one is at most 3 questions**, the ones that unblock the most; later rounds at most 4."
- Add under "Facts are your job": "The first message may carry an `About:` line with the person's time zone and language. Treat country and time zone as settled from it; never ask for them."
- Add a section **"Round two: what success looks like"**: "Right after round one, before anything else, ask one card titled 'What success looks like' with three `text` questions (`required: false`): q1 'In 30 days, what would make you say this is working?', q2 'In 6 months?', q3 'In a year?'. Put a concrete suggestion in each `initialText` based on what you know. End your turn. These answers feed the goal and the brief; they are not open decisions."
`staples-plan/SKILL.md` §2 Goal: "**Goal**: the person's 30-day answer from the interview, written as one outcome from their point of view (title under 200 characters; description: how you will both know). If they skipped it, write the outcome you would recommend."
`staples-company-brief/SKILL.md`: add a section "Where this is going" holding the 6-month and 1-year answers, two lines each.
Assistant `AGENTS.md` "Starting something new": after step 1 add: "While you interview, a built-in brand designer is already working on name and logo ideas from the person's first message; the person picks one on their screen. Mention it once, after round one, in one line. Do not propose a rename and do not wait for it." In step 3 add: "Propose the plan after the 'What success looks like' card is answered (or skipped)." Bump the Assistant stock version to `"2026-10-15"` and update the two pins in `assistant-weekly-update.test.ts`.

- [ ] **Step 4: Run** `pnpm exec vitest run server/src/__tests__/assistant-first-win.test.ts server/src/__tests__/assistant-weekly-update.test.ts server/src/__tests__/built-in-agents.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add skills server && git commit -m "feat(assistant): three-question first round, vision card feeds the goal and brief, brand designer mention; stock 2026-10-15"
```

---

### Task 9: Whole-branch checks

- [ ] Run `pnpm -r typecheck` (background), `pnpm check:token-gates`, `pnpm exec vitest run ui/src/__tests__` and the server tests touched above.
- [ ] Live walkthrough (controller, not a subagent): reset local DB, `/start` with "A candle shop in Austin called Lantern", confirm the thread sends it, the brand card moves from working to three tiles, pick one, switcher shows the name and logo, "What we've made" lists the files, the vision card appears, plan proposed after it. Record findings in the ledger.

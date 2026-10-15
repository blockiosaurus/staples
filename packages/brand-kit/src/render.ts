import { brandKitSpecSchema, type BrandKitSpec } from "@paperclipai/shared";
import { BrandKitError } from "./errors.js";
import { getFontPairing, type FontPairing } from "./fonts.js";
import { lintSvg, type LintResult } from "./lint.js";
import { buildPalette, type BrandPalette } from "./palette.js";
import { lockupSvg, markSvg } from "./templates.js";

export interface BrandKitRender {
  palette: BrandPalette;
  pairing: FontPairing;
  concepts: Array<{
    index: number;
    name: string;
    kind: "geometric" | "monogram" | "wordmark";
    markSvg: string;
    lockupSvg: string;
    lint: LintResult;
  }>;
}

export function renderBrandKit(input: BrandKitSpec): BrandKitRender {
  const spec = brandKitSpecSchema.parse(input);
  const palette = buildPalette({ hue: spec.hue, mood: spec.mood, seed: spec.businessName });
  const pairing = getFontPairing(spec.fontPairingId);
  const concepts = spec.concepts.map((concept, i) => {
    const base = { index: i + 1, name: concept.name, kind: concept.kind };
    try {
      const mark = markSvg(concept, palette, pairing.id);
      const lockup = lockupSvg(concept, spec.businessName, palette, pairing.id);
      const a = lintSvg(mark);
      const b = lintSvg(lockup);
      return {
        ...base,
        markSvg: mark,
        lockupSvg: lockup,
        lint: { ok: a.ok && b.ok, errors: [...a.errors.map((e) => `mark: ${e}`), ...b.errors.map((e) => `lockup: ${e}`)] },
      };
    } catch (err) {
      if (!(err instanceof BrandKitError)) throw err;
      return { ...base, markSvg: "", lockupSvg: "", lint: { ok: false, errors: [err.message] } };
    }
  });
  return { palette, pairing, concepts };
}

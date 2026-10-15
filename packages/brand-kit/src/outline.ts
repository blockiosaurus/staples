import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import { getFontPairing, resolveFontPath } from "./fonts.js";

export interface OutlinedText {
  d: string;
  width: number;
  height: number;
  ascent: number;
}

const cache = new Map<string, opentype.Font>();

function loadFont(pairingId: string): opentype.Font {
  const hit = cache.get(pairingId);
  if (hit) return hit;
  const buf = readFileSync(resolveFontPath(getFontPairing(pairingId)));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  cache.set(pairingId, font);
  return font;
}

/**
 * Text converted to SVG path data at the origin (baseline y = 0).
 *
 * Layout is done per glyph (cmap + kerning) rather than through font.getPath(), because
 * opentype.js 1.x throws on GSUB lookups some catalogued fonts ship (e.g. chained
 * contextual format 2). Ligatures and contextual shaping are not wanted for logo text.
 */
export function outlineText(text: string, pairingId: string, sizePx: number, opts: { letterSpacing?: number } = {}): OutlinedText {
  const font = loadFont(pairingId);
  const scale = sizePx / font.unitsPerEm;
  const spacing = (opts.letterSpacing ?? 0) * sizePx;
  const path = new opentype.Path();
  let x = 0;
  let prev: opentype.Glyph | null = null;
  for (const ch of Array.from(text)) {
    const glyph = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, glyph) * scale + spacing;
    const gp = glyph.getPath(x, 0, sizePx);
    path.extend(gp);
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return {
    d: path.toPathData(2),
    width: x,
    height: sizePx,
    ascent: (font.ascender / font.unitsPerEm) * sizePx,
  };
}

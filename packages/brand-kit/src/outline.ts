import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import { BrandKitError } from "./errors.js";
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

const r2 = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * Own serializer: opentype.js 1.3.5 Path.toPathData() emits "NaN" for some glyphs
 * (seen with Fraunces "a" at certain offsets), so absolute commands are written directly.
 */
function serialize(commands: opentype.PathCommand[]): string {
  let last = "";
  return commands
    .map((c) => {
      switch (c.type) {
        case "M": last = `${r2(c.x)} ${r2(c.y)}`; return `M${last}`;
        case "L": {
          const pt = `${r2(c.x)} ${r2(c.y)}`;
          if (pt === last) return ""; // opentype.js emits a redundant L after each Q
          last = pt;
          return `L${pt}`;
        }
        case "Q": last = `${r2(c.x)} ${r2(c.y)}`; return `Q${r2(c.x1)} ${r2(c.y1)} ${last}`;
        case "C": last = `${r2(c.x)} ${r2(c.y)}`; return `C${r2(c.x1)} ${r2(c.y1)} ${r2(c.x2)} ${r2(c.y2)} ${last}`;
        case "Z": return "Z";
      }
    })
    .join("");
}

export interface OutlinedGlyphs extends OutlinedText {
  /** One entry per character, already positioned (kerning included) in the same layout as `d`. */
  glyphs: Array<{ char: string; d: string }>;
}

/**
 * Text converted to positioned per-glyph SVG path data (baseline y = 0).
 *
 * Layout is done per glyph (cmap + kerning) rather than through font.getPath(), because
 * opentype.js 1.x throws on GSUB lookups some catalogued fonts ship (e.g. chained
 * contextual format 2). Ligatures and contextual shaping are not wanted for logo text.
 * Characters the font lacks throw BrandKitError instead of rendering as .notdef.
 */
export function outlineGlyphs(text: string, pairingId: string, sizePx: number, opts: { letterSpacing?: number } = {}): OutlinedGlyphs {
  if (text.trim() === "") throw new BrandKitError("empty text");
  const font = loadFont(pairingId);
  const scale = sizePx / font.unitsPerEm;
  const spacing = (opts.letterSpacing ?? 0) * sizePx;
  const glyphs: OutlinedGlyphs["glyphs"] = [];
  let x = 0;
  let prev: opentype.Glyph | null = null;
  for (const ch of Array.from(text)) {
    const glyph = font.charToGlyph(ch);
    if (glyph.index === 0 && ch.trim() !== "") throw new BrandKitError(`unsupported character: ${ch}`);
    if (prev) x += font.getKerningValue(prev, glyph) * scale + spacing;
    glyphs.push({ char: ch, d: serialize(glyph.getPath(x, 0, sizePx).commands) });
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return {
    d: glyphs.map((g) => g.d).join(""),
    glyphs,
    width: x,
    height: sizePx,
    ascent: (font.ascender / font.unitsPerEm) * sizePx,
  };
}

/** Text converted to SVG path data at the origin (baseline y = 0). */
export function outlineText(text: string, pairingId: string, sizePx: number, opts: { letterSpacing?: number } = {}): OutlinedText {
  const { d, width, height, ascent } = outlineGlyphs(text, pairingId, sizePx, opts);
  return { d, width, height, ascent };
}

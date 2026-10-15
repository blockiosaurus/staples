import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BrandKitError } from "./errors.js";

import type { Mood } from "./palette.js";

export interface FontPairing {
  id: string;
  label: string;
  heading: { family: string; package: string; file: string; weight: number };
  body: { family: string };
  moods: Mood[];
  industries: string[];
}

const require = createRequire(import.meta.url);
const PAIRINGS: FontPairing[] = JSON.parse(
  readFileSync(new URL("./fonts.json", import.meta.url), "utf8"),
) as FontPairing[];

export function listFontPairings(): FontPairing[] {
  return PAIRINGS.map((p) => ({ ...p }));
}

export function getFontPairing(id: string): FontPairing {
  const found = PAIRINGS.find((p) => p.id === id);
  if (!found) throw new BrandKitError("unknown font pairing");
  return found;
}

export function resolveFontPath(pairing: FontPairing): string {
  try {
    return require.resolve(`${pairing.heading.package}/${pairing.heading.file}`);
  } catch {
    throw new BrandKitError(`font file for pairing ${pairing.id} is not installed`);
  }
}

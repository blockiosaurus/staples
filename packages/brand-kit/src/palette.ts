import { clampChroma, formatHex, wcagContrast } from "culori";
import { BRAND_KIT_MOODS } from "@paperclipai/shared";

export type Mood = (typeof BRAND_KIT_MOODS)[number];

export interface BrandPalette {
  primary: string;
  accent: string;
  ink: string;
  paper: string;
  neutral: Record<"50" | "100" | "200" | "300" | "500" | "700" | "900", string>;
  dark: { primary: string; accent: string; ink: string; paper: string };
  contrast: { inkOnPaper: number; primaryOnPaper: number; paperOnPrimary: number; accentOnPaper: number };
}

const MOODS: Record<Mood, { L: number; C: number; accentShift: number }> = {
  modern: { L: 0.55, C: 0.16, accentShift: 180 },
  warm: { L: 0.62, C: 0.15, accentShift: 30 },
  classic: { L: 0.42, C: 0.1, accentShift: -30 },
  playful: { L: 0.68, C: 0.19, accentShift: 150 },
  bold: { L: 0.5, C: 0.2, accentShift: 180 },
  calm: { L: 0.66, C: 0.08, accentShift: -45 },
};

const NEUTRAL_L = { "50": 0.985, "100": 0.96, "200": 0.92, "300": 0.85, "500": 0.62, "700": 0.42, "900": 0.22 } as const;

function hashHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

const norm = (h: number) => ((h % 360) + 360) % 360;

function hex(l: number, c: number, h: number): string {
  const clamped = clampChroma({ mode: "oklch", l, c, h: norm(h) }, "oklch");
  return formatHex(clamped);
}

export function buildPalette(input: { hue?: number; mood: Mood; seed: string }): BrandPalette {
  const hue = input.hue ?? hashHue(input.seed);
  const m = MOODS[input.mood];

  let inkL = 0.22;
  let ink = hex(inkL, 0.02, hue);
  const paper = hex(0.985, 0.01, hue);
  while (wcagContrast(ink, paper) < 4.5 && inkL > 0.02) {
    inkL -= 0.02;
    ink = hex(inkL, 0.02, hue);
  }

  let primaryL = m.L;
  let primary = hex(primaryL, m.C, hue);
  while (wcagContrast(primary, paper) < 3 && primaryL > 0.3) {
    primaryL -= 0.02;
    primary = hex(primaryL, m.C, hue);
  }
  const accentHue = hue + m.accentShift;
  let accentL = m.L;
  let accent = hex(accentL, m.C * 0.85, accentHue);
  while (wcagContrast(accent, paper) < 3 && accentL > 0.3) {
    accentL -= 0.02;
    accent = hex(accentL, m.C * 0.85, accentHue);
  }

  const neutral = Object.fromEntries(
    Object.entries(NEUTRAL_L).map(([k, l]) => [k, hex(l, 0.015, hue)]),
  ) as BrandPalette["neutral"];

  const ratio = wcagContrast(primary, paper);
  return {
    primary,
    accent,
    ink,
    paper,
    neutral,
    dark: {
      paper: hex(0.17, 0.02, hue),
      ink: hex(0.95, 0.01, hue),
      primary: hex(primaryL + 0.12, m.C, hue),
      accent: hex(accentL + 0.12, m.C * 0.85, accentHue),
    },
    contrast: {
      inkOnPaper: wcagContrast(ink, paper),
      primaryOnPaper: ratio,
      paperOnPrimary: wcagContrast(paper, primary),
      accentOnPaper: wcagContrast(accent, paper),
    },
  };
}

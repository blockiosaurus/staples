import type { BrandKitConcept, BrandKitShape } from "@paperclipai/shared";
import type { BrandPalette } from "./palette.js";
import { outlineText } from "./outline.js";

const NS = "http://www.w3.org/2000/svg";
const CAP_HEIGHT = 0.7; // approximate cap height as a fraction of font size

const n = (v: number): string => String(Math.round(v * 100) / 100);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type FillName = "primary" | "accent" | "ink" | "paper";
const color = (p: BrandPalette, name: FillName): string => p[name];

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`;
  };
  const span = (((endDeg - startDeg) % 360) + 360) % 360;
  const large = span > 180 ? 1 : 0;
  return `M${pt(startDeg)} A${n(r)} ${n(r)} 0 ${large} 1 ${pt(endDeg)}`;
}

function shapeSvg(s: BrandKitShape, p: BrandPalette): string {
  switch (s.type) {
    case "circle":
      return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}" fill="${color(p, s.fill)}"/>`;
    case "rect":
      return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${s.rx ? ` rx="${n(s.rx)}"` : ""} fill="${color(p, s.fill)}"/>`;
    case "triangle":
      return `<polygon points="${s.points.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" fill="${color(p, s.fill)}"/>`;
    case "arc": {
      const full = Math.abs(s.endDeg - s.startDeg) % 360 === 0;
      if (full) return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}" fill="none" stroke="${color(p, s.stroke)}" stroke-width="${n(s.width)}"/>`;
      return `<path d="${arcPath(s.cx, s.cy, s.r, s.startDeg, s.endDeg)}" fill="none" stroke="${color(p, s.stroke)}" stroke-width="${n(s.width)}" stroke-linecap="round"/>`;
    }
    case "line":
      return `<line x1="${n(s.x1)}" y1="${n(s.y1)}" x2="${n(s.x2)}" y2="${n(s.y2)}" stroke="${color(p, s.stroke)}" stroke-width="${n(s.width)}" stroke-linecap="round"/>`;
  }
}

type Frame = "circle" | "square" | "rounded" | "none";

function monogramInner(letters: string, frame: Frame, p: BrandPalette, pairingId: string): string {
  const frameSvg =
    frame === "circle" ? `<circle cx="32" cy="32" r="30" fill="${p.primary}"/>`
    : frame === "square" ? `<rect x="4" y="4" width="56" height="56" fill="${p.primary}"/>`
    : frame === "rounded" ? `<rect x="4" y="4" width="56" height="56" rx="12" fill="${p.primary}"/>`
    : "";
  const probe = outlineText(letters, pairingId, 40);
  const size = Math.min(40, (40 * 36) / probe.width);
  const o = outlineText(letters, pairingId, size);
  const x = 32 - o.width / 2;
  const baseline = 32 + (CAP_HEIGHT * size) / 2;
  const fill = frame === "none" ? p.ink : p.paper;
  return `${frameSvg}<g transform="translate(${n(x)} ${n(baseline)})"><path d="${o.d}" fill="${fill}"/></g>`;
}

function markInner(concept: BrandKitConcept, p: BrandPalette, pairingId: string): string {
  switch (concept.kind) {
    case "geometric":
      return concept.shapes.map((s) => shapeSvg(s, p)).join("");
    case "monogram":
      return monogramInner(concept.letters.toUpperCase(), concept.frame, p, pairingId);
    case "wordmark":
      return monogramInner(Array.from(concept.name)[0]!.toUpperCase(), "rounded", p, pairingId);
  }
}

export function markSvg(concept: BrandKitConcept, p: BrandPalette, pairingId: string): string {
  return `<svg xmlns="${NS}" viewBox="0 0 64 64"><title>${esc(concept.name)}</title>${markInner(concept, p, pairingId)}</svg>`;
}

export function lockupSvg(concept: BrandKitConcept, businessName: string, p: BrandPalette, pairingId: string): string {
  const maxWidth = 224; // 84 .. 308
  let size = 36;
  const natural = outlineText(businessName, pairingId, size).width;
  if (natural > maxWidth) size = (size * maxWidth) / natural;
  const baseline = 40 + (CAP_HEIGHT * size) / 2;

  const accentIdx = concept.kind === "wordmark" ? concept.accentLetterIndex : undefined;
  const chars = Array.from(businessName);
  let word: string;
  if (accentIdx !== undefined && accentIdx < chars.length) {
    const prefix = chars.slice(0, accentIdx).join("");
    const letter = chars[accentIdx]!;
    const suffix = chars.slice(accentIdx + 1).join("");
    const parts: string[] = [];
    let x = 0;
    for (const [text, fill] of [[prefix, p.ink], [letter, p.accent], [suffix, p.ink]] as const) {
      if (!text) continue;
      const o = outlineText(text, pairingId, size);
      parts.push(`<g transform="translate(${n(x)} 0)"><path d="${o.d}" fill="${fill}"/></g>`);
      x += o.width;
    }
    word = parts.join("");
  } else {
    word = `<path d="${outlineText(businessName, pairingId, size).d}" fill="${p.ink}"/>`;
  }
  return (
    `<svg xmlns="${NS}" viewBox="0 0 320 80"><title>${esc(businessName)}</title>` +
    `<g transform="translate(12 12) scale(0.875)">${markInner(concept, p, pairingId)}</g>` +
    `<g transform="translate(84 ${n(baseline)})">${word}</g></svg>`
  );
}

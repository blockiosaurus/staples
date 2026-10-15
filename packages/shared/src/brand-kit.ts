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

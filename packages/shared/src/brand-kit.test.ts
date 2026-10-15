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
  it("rejects a business name over 60 characters and a monogram over 2 letters", () => {
    expect(() => brandKitSpecSchema.parse({ ...base, businessName: "x".repeat(61), concepts: [{ kind: "wordmark", name: "x" }] })).toThrow();
    expect(() => brandKitSpecSchema.parse({ ...base, concepts: [{ kind: "monogram", name: "x", letters: "ABC", frame: "none" }] })).toThrow();
  });
});

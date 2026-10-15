import { describe, expect, it } from "vitest";
import { projectedMonthEndCents } from "./projection";

describe("projectedMonthEndCents", () => {
  it("scales month-to-date spend to the full month in UTC", () => {
    expect(projectedMonthEndCents(1000, new Date("2026-10-10T12:00:00Z"))).toBe(3100);
  });
  it("is null before there is spend", () => {
    expect(projectedMonthEndCents(0, new Date("2026-10-10T12:00:00Z"))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { BOARD_ROUTE_ROOTS, isReservedCompanyRouteSegment } from "./reserved-route-segments.js";

describe("reserved route segments", () => {
  it.each(["runs", "budgets", "status-cards"])("reserves the real company route %s", (segment) => {
    expect(BOARD_ROUTE_ROOTS).toContain(segment);
    expect(isReservedCompanyRouteSegment(segment)).toBe(true);
    expect(isReservedCompanyRouteSegment(segment.toUpperCase())).toBe(true);
  });
});

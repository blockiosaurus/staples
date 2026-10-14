import { describe, expect, it } from "vitest";
import { BOARD_ROUTE_ROOTS, GLOBAL_ROUTE_ROOTS, isReservedCompanyRouteSegment } from "./reserved-route-segments.js";

describe("reserved route segments", () => {
  it.each(["runs", "budgets", "status-cards", "home"])("reserves the real company route %s", (segment) => {
    expect(BOARD_ROUTE_ROOTS).toContain(segment);
    expect(isReservedCompanyRouteSegment(segment)).toBe(true);
    expect(isReservedCompanyRouteSegment(segment.toUpperCase())).toBe(true);
  });

  it("reserves the global /start company-naming page from prefixes and board roots", () => {
    expect(GLOBAL_ROUTE_ROOTS).toContain("start");
    expect(BOARD_ROUTE_ROOTS).not.toContain("start");
    expect(isReservedCompanyRouteSegment("start")).toBe(true);
    expect(isReservedCompanyRouteSegment("START")).toBe(true);
  });

  it.each(["terms", "privacy"])("reserves the public legal page /%s", (segment) => {
    expect(GLOBAL_ROUTE_ROOTS).toContain(segment);
    expect(isReservedCompanyRouteSegment(segment)).toBe(true);
    expect(isReservedCompanyRouteSegment(segment.toUpperCase())).toBe(true);
  });
});

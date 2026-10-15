import { describe, expect, it } from "vitest";
import { deriveWorkingName, WORKING_NAME_MAX_LENGTH } from "./working-name.js";

describe("deriveWorkingName", () => {
  it("uses a name the person gives with 'called' or 'named'", () => {
    expect(deriveWorkingName("A candle shop in Austin called Lantern")).toBe("Lantern");
    expect(deriveWorkingName("I'm starting a bakery named Crumb & Co. We sell bread.")).toBe("Crumb & Co");
  });
  it("uses a quoted name", () => {
    expect(deriveWorkingName('A newsletter about jazz, "Blue Notes", twice a week')).toBe("Blue Notes");
  });
  it("drops leading filler and keeps up to four title-cased words", () => {
    expect(deriveWorkingName("I want to start a dog-walking service for busy professionals")).toBe("Dog-Walking Service");
    expect(deriveWorkingName("we're launching an online store selling vintage film cameras")).toBe("Online Store");
  });
  it("falls back when nothing usable remains", () => {
    expect(deriveWorkingName("")).toBe("New business");
    expect(deriveWorkingName("   ")).toBe("New business");
    expect(deriveWorkingName("I want to")).toBe("New business");
  });
  it("never exceeds the maximum length", () => {
    expect(deriveWorkingName("x".repeat(200)).length).toBeLessThanOrEqual(WORKING_NAME_MAX_LENGTH);
  });
});

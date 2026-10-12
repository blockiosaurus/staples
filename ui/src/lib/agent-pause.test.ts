import { describe, expect, it } from "vitest";
import { TEMPLATE_SETUP_PAUSE_MESSAGE, isTemplateSetupPause } from "./agent-pause";

describe("agent pause helpers", () => {
  it("detects template-setup pauses", () => {
    expect(isTemplateSetupPause({ status: "paused", pauseReason: "template_setup" })).toBe(true);
    expect(isTemplateSetupPause({ status: "paused", pauseReason: "manual" })).toBe(false);
    expect(isTemplateSetupPause({ status: "idle", pauseReason: "template_setup" })).toBe(false);
  });
  it("uses the shared message", () => {
    expect(TEMPLATE_SETUP_PAUSE_MESSAGE).toContain("apply the plan again");
  });
});

import { describe, expect, it } from "vitest";
import { agentTemplateRecord } from "./templateRecord";

describe("agentTemplateRecord requiredApps", () => {
  it("carries the reason and optional flag", () => {
    const record = agentTemplateRecord({
      staplesTemplate: {
        ref: "staples/newsletter",
        requiredApps: [
          { capability: "newsletter", anyOf: ["beehiiv"], why: "Sends each issue." },
          { capability: "extra", anyOf: ["slack"], optional: true },
        ],
      },
    });
    expect(record?.requiredApps).toEqual([
      { capability: "newsletter", anyOf: ["beehiiv"], why: "Sends each issue.", optional: false },
      { capability: "extra", anyOf: ["slack"], why: null, optional: true },
    ]);
  });
});

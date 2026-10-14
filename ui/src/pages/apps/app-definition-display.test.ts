import { describe, expect, it } from "vitest";
import { appDefinitionDescription } from "./app-definition-display";

describe("appDefinitionDescription", () => {
  it("turns the provider-hosted boilerplate into a plain sentence", () => {
    expect(appDefinitionDescription({ description: "Connect Stripe's provider-hosted MCP server." } as never)).toBe("Let agents use Stripe.");
    expect(appDefinitionDescription({ description: "Connect Hugging Face’s provider-hosted MCP server." } as never)).toBe("Let agents use Hugging Face.");
  });
  it("leaves other descriptions alone", () => {
    expect(appDefinitionDescription({ description: "Send email through Resend." } as never)).toBe("Send email through Resend.");
  });
});

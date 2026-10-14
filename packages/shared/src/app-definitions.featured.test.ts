import { describe, expect, it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { APP_STORE_HIDDEN_SLUGS } from "./app-definitions.js";
import { isAppAggregator } from "./aggregator-apps.js";

const FEATURED = [
  "gmail", "google-calendar", "slack", "notion", "stripe", "shopify", "github", "resend", "beehiiv",
  "klaviyo", "agentmail", "linear", "vercel", "netlify", "webflow", "google-drive", "google-docs", "google-sheets",
];

describe("featured app definitions", () => {
  const featured = APP_DEFINITIONS.filter((app) => app.featured).map((app) => app.slug);

  it("matches the curated popular set", () => {
    expect([...featured].sort()).toEqual([...FEATURED].sort());
  });

  it("never features an aggregator", () => {
    expect(featured.filter((slug) => isAppAggregator(slug))).toEqual([]);
    for (const slug of ["arcade", "composio", "executor", "zapier"]) expect(featured).not.toContain(slug);
  });

  it("keeps featured apps visible in the store", () => {
    expect(featured.filter((slug) => APP_STORE_HIDDEN_SLUGS.has(slug))).toEqual([]);
    expect(APP_STORE_HIDDEN_SLUGS.has("xero")).toBe(false);
  });
});

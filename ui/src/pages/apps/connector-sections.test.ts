import { describe, expect, it } from "vitest";
import { classifyRow, teamNeeds, type SectionRow } from "./connector-sections";

const row = (slug: string, extra: Partial<SectionRow> = {}): SectionRow => ({
  key: `gallery:${slug}`, slug, name: slug, entry: null, aggregatorApp: undefined, connections: [], chatEndpoints: [], upstreamApps: undefined, ...extra,
});

describe("classifyRow", () => {
  it("sends model providers, raw connectors and aggregators to Advanced", () => {
    expect(classifyRow(row("anthropic", { entry: { tags: ["model-provider"], categories: ["ai"] } as never }))).toBe("advanced");
    expect(classifyRow(row("api-key-generic"))).toBe("advanced");
    expect(classifyRow(row("composio", { aggregatorApp: { slug: "composio" } as never }))).toBe("advanced");
    expect(classifyRow(row("linkedin", { aggregatorApp: { slug: "linkedin", routes: [] } as never }))).toBe("advanced");
  });
  it("never hides a connection the person already made", () => {
    const connected = [{ id: "c1", status: "active" }] as never;
    expect(classifyRow(row("composio", { aggregatorApp: { slug: "composio" } as never, connections: connected }))).toBe("regular");
    expect(classifyRow(row("api-key-generic", { connections: connected }))).toBe("regular");
    expect(classifyRow(row("gmail", { aggregatorApp: {} as never, entry: { featured: true } as never, connections: connected }))).toBe("popular");
  });
  it("marks featured entries popular and everything else regular", () => {
    expect(classifyRow(row("gmail", { entry: { featured: true, categories: ["communication"] } as never }))).toBe("popular");
    expect(classifyRow(row("todoist", { entry: { featured: false } as never }))).toBe("regular");
    expect(classifyRow(row("legacy", { entry: null }))).toBe("regular");
  });
});

describe("teamNeeds", () => {
  const agents = [
    { id: "a1", name: "Newsletter editor", status: "active", metadata: { staplesTemplate: { ref: "staples/newsletter", requiredApps: [{ capability: "newsletter", anyOf: ["beehiiv", "resend"], why: "Holds your subscriber list and sends each issue." }] } } },
    { id: "a2", name: "Retired", status: "terminated", metadata: { staplesTemplate: { ref: "staples/coding-agent", requiredApps: [{ capability: "code", anyOf: ["github"], why: "x" }] } } },
  ];
  it("lists unmet required apps with the agent and reason", () => {
    const rows = [row("beehiiv"), row("resend"), row("github")];
    const needs = teamNeeds({ agents: agents as never, rows, requests: [] });
    expect(needs).toEqual([{ kind: "template", row: rows[0], agentName: "Newsletter editor", why: "Holds your subscriber list and sends each issue.", alternatives: [rows[1]] }]);
  });
  it("drops needs that an installed alternative satisfies", () => {
    const rows = [row("beehiiv"), row("resend", { connections: [{ id: "c1", status: "active" } as never] })];
    expect(teamNeeds({ agents: agents as never, rows, requests: [] })).toEqual([]);
  });
  it("adds open requests, deduplicated by service", () => {
    const rows = [row("stripe")];
    const requests = [{ interactionId: "i1", issueId: "t1", issueIdentifier: "LAN-4", serviceSlug: "stripe", serviceName: "Stripe", requestingAgentId: "a9", requestingAgentName: "Bookkeeper", createdAt: "2026-10-14T00:00:00Z" }];
    const needs = teamNeeds({ agents: [], rows, requests });
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: "request", row: rows[0], agentName: "Bookkeeper", issueHref: "/issues/LAN-4" });
  });
});

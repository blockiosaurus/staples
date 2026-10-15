import { isAppAggregator } from "@paperclipai/shared/aggregator-apps";
import type { Agent, PendingConnectionRequest } from "@paperclipai/shared";
import { agentTemplateRecord } from "@/staples/autopilot/templateRecord";

/** The slice of a Browse row the sections need. */
export interface SectionRow {
  key: string;
  slug: string;
  name: string;
  entry: { featured?: boolean; categories?: string[]; tags?: string[]; aiConnectionRouter?: unknown } | null;
  aggregatorApp?: unknown;
  connections: Array<{ status?: string }>;
  chatEndpoints: unknown[];
  upstreamApps?: Array<{ accounts: unknown[] }>;
}

const RAW_CONNECTOR_SLUGS = new Set(["api-key-generic", "oauth-generic", "local", "gateway", "chat-completions-api", "messages-api", "responses-api", "bedrock"]);

export const POPULAR_CATEGORY_LABELS: Record<string, string> = {
  communication: "Email and messaging",
  productivity: "Calendar and documents",
  commerce: "Sales and payments",
  content: "Website and content",
  developer: "Developer tools",
  data: "Data",
  analytics: "Analytics",
  ai: "AI",
  other: "Other",
};

export function rowIsInstalled(row: SectionRow): boolean {
  return row.connections.length > 0 || row.chatEndpoints.length > 0 || (row.upstreamApps ?? []).some((app) => app.accounts.length > 0);
}

export function classifyRow(row: SectionRow): "advanced" | "popular" | "regular" {
  // A connection the person already made always stays visible in the default view.
  if (rowIsInstalled(row)) return row.entry?.featured === true ? "popular" : "regular";
  if (row.aggregatorApp || isAppAggregator(row.slug) || RAW_CONNECTOR_SLUGS.has(row.slug)) return "advanced";
  if (row.entry?.tags?.includes("model-provider") || row.entry?.aiConnectionRouter) return "advanced";
  return row.entry?.featured === true ? "popular" : "regular";
}

/** Popular rows grouped by their first category, in the label map's order. */
export function groupPopular<T extends SectionRow>(rows: T[]): Array<{ label: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const first = row.entry?.categories?.[0] ?? "other";
    const category = first in POPULAR_CATEGORY_LABELS ? first : "other";
    groups.set(category, [...(groups.get(category) ?? []), row]);
  }
  return Object.keys(POPULAR_CATEGORY_LABELS)
    .filter((category) => groups.has(category))
    .map((category) => ({ label: POPULAR_CATEGORY_LABELS[category]!, rows: groups.get(category)! }));
}

export type TeamNeed<T extends SectionRow = SectionRow> =
  | { kind: "template"; row: T; agentName: string; why: string | null; alternatives: T[] }
  | { kind: "request"; row: T | null; serviceName: string; agentName: string; issueHref: string };

/** Apps hired agents need but nobody connected, then open connection requests. */
export function teamNeeds<T extends SectionRow>(input: {
  agents: Array<Pick<Agent, "id" | "name" | "status" | "metadata">>;
  rows: T[];
  requests: PendingConnectionRequest[];
}): TeamNeed<T>[] {
  const bySlug = new Map(input.rows.map((row) => [row.slug, row] as const));
  const needs: TeamNeed<T>[] = [];
  const seen = new Set<string>();
  for (const agent of input.agents) {
    if (agent.status === "terminated") continue;
    const record = agentTemplateRecord(agent.metadata);
    if (!record) continue;
    for (const app of record.requiredApps) {
      if (app.optional) continue;
      const candidates = app.anyOf.map((slug) => bySlug.get(slug)).filter((row): row is T => Boolean(row));
      if (candidates.length === 0 || candidates.some(rowIsInstalled)) continue;
      const [row, ...alternatives] = candidates as [T, ...T[]];
      if (seen.has(row.slug)) continue;
      seen.add(row.slug);
      needs.push({ kind: "template", row, agentName: agent.name, why: app.why, alternatives });
    }
  }
  for (const request of input.requests) {
    if (seen.has(request.serviceSlug)) continue;
    seen.add(request.serviceSlug);
    const row = bySlug.get(request.serviceSlug) ?? null;
    if (row && rowIsInstalled(row)) continue;
    needs.push({ kind: "request", row, serviceName: request.serviceName, agentName: request.requestingAgentName, issueHref: `/issues/${request.issueIdentifier ?? request.issueId}` });
  }
  return needs;
}

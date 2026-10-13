/**
 * Read-only view of `agent.metadata.staplesTemplate`: the template an agent
 * was hired from (server-owned; written only by plans/apply).
 */

export interface AgentTemplateOutwardCategory {
  capability: string;
  label: string;
  toolPatterns: string[];
  destructiveToolPatterns: string[];
}

export interface AgentTemplateRecordView {
  /** "staples/<slug>" */
  ref: string;
  slug: string;
  version: string | null;
  readOnly: boolean;
  outwardActions: AgentTemplateOutwardCategory[];
  requiredApps: Array<{ capability: string; anyOf: string[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** The template slug of a ref like "staples/email-secretary". */
export function templateSlugFromRef(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/** The agent's template record, or null when it was not hired from a template. */
export function agentTemplateRecord(metadata: unknown): AgentTemplateRecordView | null {
  if (!isRecord(metadata)) return null;
  const record = metadata.staplesTemplate;
  if (!isRecord(record) || typeof record.ref !== "string" || !record.ref.trim()) return null;
  const outwardActions = (Array.isArray(record.outwardActions) ? record.outwardActions.filter(isRecord) : [])
    .filter((action) => typeof action.capability === "string" && action.capability)
    .map((action) => ({
      capability: action.capability as string,
      label: typeof action.label === "string" && action.label.trim() ? action.label : (action.capability as string),
      toolPatterns: strings(action.toolPatterns),
      destructiveToolPatterns: strings(action.destructiveToolPatterns),
    }));
  const requiredApps = (Array.isArray(record.requiredApps) ? record.requiredApps.filter(isRecord) : [])
    .filter((app) => typeof app.capability === "string" && app.capability)
    .map((app) => ({ capability: app.capability as string, anyOf: strings(app.anyOf) }));
  return {
    ref: record.ref,
    slug: templateSlugFromRef(record.ref),
    version: typeof record.version === "string" && record.version.trim() ? record.version : null,
    readOnly: record.readOnly === true,
    outwardActions,
    requiredApps,
  };
}

/** True when the agent was hired from a template. */
export function isTemplatedAgent(agent: { metadata?: unknown } | null | undefined): boolean {
  return agentTemplateRecord(agent?.metadata) !== null;
}

/**
 * Case-insensitive whole-name glob where `*` is the only wildcard (mirrors
 * the server's `toolNamePatternMatches`).
 */
export function toolNamePatternMatches(pattern: string, name: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || !/[^*]/.test(trimmed)) return false;
  const source = trimmed
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(name);
}

/**
 * The outward category a tool belongs to for this template: its name matches
 * one of the category's tool patterns and none of its destructive patterns.
 * Null when no single category matches.
 */
export function outwardCategoryForTool(
  record: AgentTemplateRecordView | null,
  toolName: string,
): AgentTemplateOutwardCategory | null {
  if (!record || record.readOnly) return null;
  const matches = record.outwardActions.filter((category) =>
    category.toolPatterns.some((pattern) => toolNamePatternMatches(pattern, toolName))
    && !category.destructiveToolPatterns.some((pattern) => toolNamePatternMatches(pattern, toolName)));
  return matches.length === 1 ? matches[0]! : null;
}

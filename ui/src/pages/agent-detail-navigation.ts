import { auditSectionHref, type AuditSection } from "./audit/audit-navigation";

export type AgentDetailView =
  | "overview"
  | "instructions"
  | "skills"
  | "autopilot"
  | "runtime"
  | "secrets"
  | "tools"
  | "channels"
  | "permissions"
  | "api-keys"
  | "revisions"
  | "run-detail";

export type AgentLocalDetailView = Exclude<AgentDetailView, "run-detail">;

export const AGENT_DETAIL_NAVIGATION: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ value: AgentLocalDetailView; label: string }>;
}> = [
  {
    label: "Agent",
    items: [
      { value: "overview", label: "Overview" },
      { value: "instructions", label: "Instructions" },
      { value: "skills", label: "Skills" },
      { value: "autopilot", label: "Autopilot" },
    ],
  },
  {
    label: "Setup",
    items: [
      { value: "runtime", label: "Runs on" },
      { value: "secrets", label: "Secrets" },
      { value: "tools", label: "Tools" },
      { value: "channels", label: "Channels" },
    ],
  },
  {
    label: "Governance",
    items: [
      { value: "permissions", label: "Permissions / Trust" },
      { value: "api-keys", label: "API Keys" },
      { value: "revisions", label: "Revisions" },
    ],
  },
] as const;

export function parseAgentDetailView(value: string | null): AgentLocalDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "skills") return "skills";
  if (value === "autopilot") return "autopilot";
  if (value === "runtime" || value === "configure" || value === "configuration") return "runtime";
  if (value === "secrets") return "secrets";
  if (value === "tools") return "tools";
  if (value === "channels") return "channels";
  if (value === "permissions" || value === "trust") return "permissions";
  if (value === "api-keys" || value === "keys") return "api-keys";
  if (value === "revisions" || value === "history") return "revisions";
  return "overview";
}

export function agentDetailHref(agentRef: string, view: AgentLocalDetailView = "overview") {
  return `/agents/${agentRef}/${view}`;
}

export function agentLegacyAuditSection(value: string | null): AuditSection | null {
  if (value === "runs") return "runs";
  if (value === "audit" || value === "activity") return "activity";
  if (value === "cost" || value === "costs") return "costs";
  if (value === "budget" || value === "budgets") return "budgets";
  return null;
}

export function agentScopedAuditHref(agentId: string, section: AuditSection) {
  return auditSectionHref(section, {
    mode: section === "activity" ? "agents" : undefined,
    agentId,
  });
}

export const AGENT_ADVANCED_STORAGE_KEY = "staples:agent-advanced-open";

/** Navigation groups that always show; everything after them lives under Advanced. */
export const AGENT_PRIMARY_NAVIGATION_LABELS: ReadonlyArray<string> = ["Agent"];

export function agentPrimaryNavigation() {
  return AGENT_DETAIL_NAVIGATION.filter((section) => AGENT_PRIMARY_NAVIGATION_LABELS.includes(section.label));
}

export function agentAdvancedNavigation() {
  return AGENT_DETAIL_NAVIGATION.filter((section) => !AGENT_PRIMARY_NAVIGATION_LABELS.includes(section.label));
}

/** Active local view from a pathname like /agents/:ref/:view; null when not an agent-detail path. */
export function agentActiveViewFromPath(pathname: string): AgentLocalDetailView | null {
  const match = /^(?:\/[^/]+)?\/agents\/[^/]+\/([^/]+)/.exec(pathname);
  if (!match) return null;
  return parseAgentDetailView(match[1]!);
}

export type AgentChannelEndpoint = {
  assignedAgentId?: string | null;
  status?: string | null;
  provider?: string | null;
};

/** Non-archived, visible channel endpoints assigned to the agent; shared by the sidebar count and the Channels panel. */
export function agentChannelEndpoints<T extends AgentChannelEndpoint>(
  endpoints: ReadonlyArray<T>,
  agentId: string,
  isVisible: (provider: string | null | undefined) => boolean,
): T[] {
  return endpoints.filter(
    (e) => e.assignedAgentId === agentId && e.status !== "archived" && isVisible(e.provider),
  );
}

export function agentChannelCount(
  endpoints: ReadonlyArray<AgentChannelEndpoint>,
  agentId: string,
  isVisible: (provider: string | null | undefined) => boolean,
): number {
  return agentChannelEndpoints(endpoints, agentId, isVisible).length;
}

/** True when the active view or the scoped Audit routes live inside Advanced. */
export function isAgentAdvancedActive(input: {
  activeView: AgentLocalDetailView | null;
  auditActive?: boolean;
}): boolean {
  if (input.auditActive) return true;
  if (!input.activeView) return false;
  return agentAdvancedNavigation().some((section) =>
    section.items.some((item) => item.value === input.activeView),
  );
}

/** Advanced is open when the person opened it before, or the active view is inside it. */
export function resolveAgentAdvancedOpen(input: { storedOpen: boolean; advancedActive: boolean }): boolean {
  return input.storedOpen || input.advancedActive;
}

export type AgentAdvancedCounts = {
  /** undefined = loading/error/unknown (fail open: keep visible) */
  channels?: number;
  apiKeys?: number;
  /** Whether the agent was hired from a template; Autopilot shows only when true. */
  templated?: boolean;
};

/**
 * Hide Channels / API keys when the agent is known to have none, unless that
 * view is active. Autopilot shows only for templated agents (it fails closed:
 * hidden while unknown).
 */
export function isAgentAdvancedItemHidden(
  view: AgentLocalDetailView,
  counts: AgentAdvancedCounts,
  activeView: AgentLocalDetailView | null,
): boolean {
  if (view === "autopilot") return counts.templated !== true;
  if (view === activeView) return false;
  if (view === "channels") return counts.channels === 0;
  if (view === "api-keys") return counts.apiKeys === 0;
  return false;
}

export function readAgentAdvancedOpen(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    return store?.getItem(AGENT_ADVANCED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAgentAdvancedOpen(open: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    store?.setItem(AGENT_ADVANCED_STORAGE_KEY, String(open));
  } catch {
    // storage unavailable; the preference simply isn't remembered
  }
}

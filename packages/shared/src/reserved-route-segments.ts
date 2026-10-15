/**
 * First path segments the board UI owns. A company issue prefix lowercases to
 * the same string as one of these would make `/:prefix/...` ambiguous with a
 * board route, so prefix allocation must never hand one out.
 */
export const BOARD_ROUTE_ROOTS = [
  "home",
  "dashboard",
  "companies",
  "company",
  "skills",
  "teams-catalog",
  "org",
  "agents",
  "chats",
  "apps",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "tasks",
  "routines",
  "goals",
  "artifacts",
  "tools",
  "approvals",
  "costs",
  "usage",
  "activity",
  "audit",
  "decisions",
  "inbox",
  "u",
  "design-guide",
  "search",
  "settings",
  "timeline",
  "assistant",
  "cases",
  "status",
  "pipelines",
  "review-queue",
  "learnings",
  "runs",
  "budgets",
  "status-cards",
] as const;

/** Top-level routes that live outside any company prefix. */
export const GLOBAL_ROUTE_ROOTS = ["auth", "invite", "board-claim", "cli-auth", "mcp-connect", "dot-connect", "assistant-connections", "docs", "instance", "start", "terms", "privacy"] as const;

/** Every lowercase route root a company issue prefix must not equal. */
export const RESERVED_COMPANY_ROUTE_SEGMENTS: readonly string[] = [
  ...BOARD_ROUTE_ROOTS,
  ...GLOBAL_ROUTE_ROOTS,
];

export function isReservedCompanyRouteSegment(value: string): boolean {
  return RESERVED_COMPANY_ROUTE_SEGMENTS.includes(value.toLowerCase());
}

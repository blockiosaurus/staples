import type { AssistantPageContext } from "@paperclipai/shared";

type EntityType = NonNullable<AssistantPageContext["entity"]>["type"];

/**
 * Company-relative route roots whose second segment names an entity, and the
 * second-segment values that are list/filter/sub-pages rather than an entity.
 */
const ENTITY_ROOTS: Record<string, { type: EntityType; notIds: ReadonlySet<string> }> = {
  issues: { type: "issue", notIds: new Set(["new", "all", "active", "backlog", "done", "recent"]) },
  tasks: { type: "issue", notIds: new Set(["new", "all", "active", "backlog", "done", "recent"]) },
  agents: { type: "agent", notIds: new Set(["new", "all", "active", "paused", "error", "builtin"]) },
  projects: { type: "project", notIds: new Set(["new"]) },
  goals: { type: "goal", notIds: new Set(["new"]) },
  routines: { type: "routine", notIds: new Set(["new"]) },
  approvals: { type: "approval", notIds: new Set(["pending", "all"]) },
  skills: { type: "skill", notIds: new Set(["sources", "studio", "new"]) },
};

const ROUTE_MAX = 500;
const TITLE_MAX = 200;
const ID_MAX = 200;
const LABEL_MAX = 200;

function clip(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function companyRelativePath(pathname: string, companyPrefix: string | null | undefined) {
  const segments = pathname.split("/").filter(Boolean);
  if (companyPrefix && segments[0]?.toLowerCase() === companyPrefix.toLowerCase()) segments.shift();
  return segments;
}

function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isSettingsRoute(segments: string[]) {
  const [first, second] = segments.map((segment) => segment.toLowerCase());
  return first === "settings" || first === "instance" || (first === "company" && second === "settings");
}

export interface PageContextInput {
  pathname: string;
  companyPrefix?: string | null;
  /** `document.title` of the page the person is looking at. */
  title?: string | null;
  /** The page's own label for its entity (the last breadcrumb). */
  label?: string | null;
}

/**
 * What the person is looking at, for messages sent to the Assistant. Returns
 * null on the Assistant page itself, which has nothing to point at.
 */
export function currentPageContext({ pathname, companyPrefix, title, label }: PageContextInput): AssistantPageContext | null {
  const segments = companyRelativePath(pathname, companyPrefix);
  const root = segments[0]?.toLowerCase();
  if (root === "assistant") return null;
  const context: AssistantPageContext = { route: clip(`/${segments.join("/")}`, ROUTE_MAX) };
  // Settings pages (secrets, access, instance) can title or label sensitive
  // values: the Assistant only learns which settings page is open.
  if (isSettingsRoute(segments)) return context;
  const trimmedTitle = title?.trim();
  if (trimmedTitle) context.title = clip(trimmedTitle, TITLE_MAX);
  const entityRoot = root ? ENTITY_ROOTS[root] : undefined;
  const rawId = segments[1];
  if (entityRoot && rawId && !entityRoot.notIds.has(rawId.toLowerCase())) {
    const trimmedLabel = label?.trim();
    context.entity = {
      type: entityRoot.type,
      id: clip(safeDecode(rawId), ID_MAX),
      ...(trimmedLabel ? { label: clip(trimmedLabel, LABEL_MAX) } : {}),
    };
  }
  return context;
}

/** The short text for the dock's "Seeing:" chip. */
export function pageContextLabel(context: AssistantPageContext): string {
  return context.entity?.label ?? context.title?.split(" • ")[0] ?? context.route;
}

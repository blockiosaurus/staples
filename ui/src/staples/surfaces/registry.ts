import {
  Boxes,
  CircleCheck,
  DollarSign,
  FolderOpen,
  GitBranch,
  History,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  Package,
  Repeat,
  Target,
  Unplug,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { CompanySignals, InstanceExperimentalSettings } from "@paperclipai/shared";

export type SurfaceTier = "core" | "grows" | "advanced";
export type SurfaceGroup = "top" | "work" | "org";

export interface SurfaceContext {
  signals: CompanySignals | null;
  flags: InstanceExperimentalSettings | null;
  inboxUnread: number;
}

export interface SurfaceDefinition {
  id: string;
  label: string;
  to: string;
  /**
   * First path segment(s) after the company prefix that count as visiting this surface.
   * Every root must be a reserved board route root (BOARD_ROUTE_ROOTS).
   */
  matchRoots: string[];
  /**
   * Multi-segment paths relative to the company prefix (no leading slash) that count as
   * visiting this surface. Longest match wins and these are checked before `matchRoots`.
   */
  matchPaths?: string[];
  icon: LucideIcon;
  group: SurfaceGroup;
  tier: SurfaceTier;
  available?: (ctx: SurfaceContext) => boolean;
  revealWhen?: (ctx: SurfaceContext) => boolean;
  reason?: string;
}

export const SURFACE_REGISTRY: readonly SurfaceDefinition[] = [
  {
    id: "nav.dashboard",
    label: "Dashboard",
    to: "/dashboard",
    matchRoots: ["dashboard"],
    icon: LayoutDashboard,
    group: "top",
    tier: "core",
  },
  {
    id: "nav.inbox",
    label: "Inbox",
    to: "/inbox",
    matchRoots: ["inbox"],
    icon: Inbox,
    group: "top",
    tier: "grows",
    available: (ctx) => ctx.flags?.enableCombinedInboxTasks !== true,
    revealWhen: (ctx) => ctx.inboxUnread > 0,
    reason: "Inbox appeared because something is waiting for you.",
  },
  {
    id: "nav.decisions",
    label: "Decisions",
    to: "/decisions",
    matchRoots: ["decisions", "approvals"],
    icon: ListChecks,
    group: "top",
    tier: "grows",
    available: (ctx) => ctx.flags?.enableDecisions === true,
    revealWhen: (ctx) => ctx.signals !== null && ctx.signals.approvalsEver + ctx.signals.questionsEver > 0,
    reason: "Decisions appeared because an agent asked you something.",
  },
  {
    id: "nav.status",
    label: "Status",
    to: "/status",
    matchRoots: ["status"],
    icon: LayoutGrid,
    group: "top",
    tier: "advanced",
    available: (ctx) => ctx.flags?.enableStatusCards === true,
  },
  {
    id: "nav.chat",
    label: "Chat",
    to: "/chats",
    matchRoots: ["chats"],
    icon: MessageCircle,
    group: "work",
    tier: "core",
    available: (ctx) => ctx.flags?.enableAgentChat === true,
  },
  {
    id: "nav.tasks",
    label: "Tasks",
    to: "/issues",
    matchRoots: ["issues", "tasks"],
    icon: CircleCheck,
    group: "work",
    tier: "core",
  },
  {
    id: "nav.projects",
    label: "Projects",
    to: "/projects",
    matchRoots: ["projects"],
    icon: FolderOpen,
    group: "work",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && (ctx.signals.projects >= 2 || ctx.signals.tasks >= 25),
    reason: "Projects appeared because you have enough work to group.",
  },
  {
    id: "nav.routines",
    label: "Routines",
    to: "/routines",
    matchRoots: ["routines"],
    icon: Repeat,
    group: "work",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && ctx.signals.routines >= 1,
    reason: "Routines appeared because you created a recurring job.",
  },
  {
    id: "nav.artifacts",
    label: "Artifacts",
    to: "/artifacts",
    matchRoots: ["artifacts"],
    icon: Package,
    group: "work",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && ctx.signals.artifacts >= 1,
    reason: "Artifacts appeared because your agents produced deliverables.",
  },
  {
    id: "nav.goals",
    label: "Goals",
    to: "/goals",
    matchRoots: ["goals"],
    icon: Target,
    group: "work",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && ctx.signals.goals >= 2,
    reason: "Goals appeared because you have more than one goal.",
  },
  {
    id: "nav.cases",
    label: "Cases",
    to: "/cases",
    matchRoots: ["cases"],
    icon: Layers,
    group: "work",
    tier: "advanced",
    available: (ctx) => ctx.flags?.enableCases === true,
  },
  {
    id: "nav.pipelines",
    label: "Pipelines",
    to: "/pipelines",
    matchRoots: ["pipelines", "review-queue", "learnings"],
    icon: GitBranch,
    group: "work",
    tier: "advanced",
    available: (ctx) => ctx.flags?.enablePipelines === true,
  },
  {
    id: "nav.workspaces",
    label: "Workspaces",
    to: "/workspaces",
    matchRoots: ["workspaces", "execution-workspaces"],
    icon: GitBranch,
    group: "work",
    tier: "advanced",
    available: (ctx) => ctx.flags?.enableIsolatedWorkspaces === true && ctx.flags?.enableAgentChat !== true,
  },
  {
    id: "nav.agents",
    label: "Agents",
    to: "/agents",
    matchRoots: ["agents", "org"],
    icon: Users,
    group: "org",
    tier: "core",
  },
  {
    id: "nav.skills",
    label: "Skills",
    to: "/skills",
    matchRoots: ["skills"],
    icon: Boxes,
    group: "org",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && ctx.signals.extraSkills >= 1,
    reason: "Skills appeared because your company added its own skills.",
  },
  {
    id: "nav.connectors",
    label: "Connectors",
    to: "/apps",
    matchRoots: ["apps"],
    icon: Unplug,
    group: "org",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && (ctx.signals.connections >= 1 || ctx.signals.connectionRequests >= 1),
    reason: "Connectors appeared because an app connection exists or was requested.",
  },
  {
    id: "nav.costs",
    label: "Costs",
    to: "/activity/costs",
    matchRoots: [],
    // `/runs` and `/budgets` are compatibility redirects into `/activity/...`, so the
    // tracker only ever sees the canonical paths below.
    matchPaths: ["activity/costs", "activity/budgets", "costs", "audit/costs", "audit/budgets"],
    icon: DollarSign,
    group: "org",
    tier: "grows",
    revealWhen: (ctx) => ctx.signals !== null && (ctx.signals.budgetSet || ctx.signals.monthSpendCents > 0),
    reason: "Costs appeared because spending started.",
  },
  {
    id: "nav.audit",
    label: "Audit",
    to: "/activity",
    matchRoots: ["activity", "audit"],
    icon: History,
    group: "org",
    tier: "advanced",
  },
];

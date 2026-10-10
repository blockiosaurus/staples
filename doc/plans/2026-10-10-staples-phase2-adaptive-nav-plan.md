# Staples Phase 2: Adaptive Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Navigation starts small and grows with the company: a surface registry decides which nav items each person sees from per-company signals, per-person preferences and instance flags.

**Architecture:** The server exposes cheap per-company counts (`GET /api/companies/:companyId/signals`) and per-person UI preferences stored in a new `company_user_ui_preferences` table (`GET/PATCH /api/companies/:companyId/ui-preferences/me`). The UI holds a static registry of surfaces with reveal rules and a pure resolver; the sidebar, mobile bottom nav and command palette render from it. Revealed surfaces are persisted so they never flicker away. Spec: `doc/plans/2026-10-10-staples-adaptive-ux-design.md` (Architecture sections 1-3 and the Growth table).

**Tech Stack:** Express + Drizzle (Postgres), Zod (`@paperclipai/shared`), React 19 + TanStack Query v5, Vitest (UI tests use `// @vitest-environment jsdom`, `createRoot` + `flushSync`, no testing-library).

## Global Constraints

- Hard fork: upstream merge compatibility is not a goal.
- Hidden never blocks a URL. Every route stays reachable; visiting a surface's route reveals it.
- Once revealed, a surface stays visible even if its signal drops (sticky reveal), unless the person hides it.
- Visibility precedence: unavailable (instance flag off) → hidden; person `hidden` → hidden; `pinned` → visible; `showEverything` → visible; `revealed` → visible; tier `core` → visible; tier `grows` → visible when `revealWhen` is true; tier `advanced` → hidden.
- Signals and preferences are company-scoped; every route asserts company access. People may write their own UI preferences even with viewer membership (follow `server/src/routes/primary-agent.ts:14-27`).
- Mutating preference routes call `logActivity` (AGENTS.md rule: activity logging for mutating actions).
- New route files must be registered in `server/src/routes/openapi.ts` and the filename map in `server/src/__tests__/openapi-routes.test.ts`.
- New tables are exported from `packages/db/src/schema/index.ts`; migrations are generated with `pnpm db:generate` (never hand-named).
- Nav labels stay literal English strings (the surrounding sidebar code does not use i18n).
- Commands: single tests `npx vitest run <path>` from the repo root; full UI suite `cd ui && npx vitest run` (713 files green at phase start); typechecks `pnpm --filter @paperclipai/<shared|db|server|ui> typecheck`. Known pre-existing failures: `packages/shared` `worktree-seed-source.test.ts` (8, macOS symlink).
- Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use explicit `git add` paths (`.superpowers/` is gitignored) and confirm with `git log --oneline -1`.

---

### Task 1: Shared contracts for signals and UI preferences

**Files:**
- Create: `packages/shared/src/types/company-signals.ts`, `packages/shared/src/types/ui-preferences.ts`, `packages/shared/src/validators/ui-preferences.ts`, `packages/shared/src/validators/ui-preferences.test.ts`, `packages/shared/src/ui-preferences.ts` (merge function), `packages/shared/src/ui-preferences.test.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`, `packages/shared/src/index.ts` (re-exports, next to the sidebar-preferences exports)

**Interfaces — Produces:**

```ts
// packages/shared/src/types/company-signals.ts
export interface CompanySignals {
  companyId: string;
  /** Non-terminated agents, excluding built-in agents (metadata key "paperclipBuiltInAgent"). */
  agents: number;
  /** Visible execution issues in any status. */
  tasks: number;
  /** Visible execution issues not in done/cancelled. */
  openTasks: number;
  /** Projects with archivedAt null. */
  projects: number;
  goals: number;
  /** Routines whose status is not "archived". */
  routines: number;
  artifacts: number;
  /** Company skills whose key does not start with "paperclipai/paperclip/". */
  extraSkills: number;
  connections: number;
  /** issue_thread_interactions with kind "connection_intent", any status. */
  connectionRequests: number;
  /** Approvals in any status. */
  approvalsEver: number;
  /** Interactions of kinds suggest_tasks, ask_user_questions, request_confirmation, request_checkbox_confirmation, request_item_verdicts, any status. */
  questionsEver: number;
  /** True when companies.budget_monthly_cents > 0 or any active budget policy has amount > 0. */
  budgetSet: boolean;
  /** Sum of cost_events.cost_cents since the start of the current UTC month. */
  monthSpendCents: number;
  generatedAt: string;
}
```

```ts
// packages/shared/src/types/ui-preferences.ts
export interface UiPreferences {
  pinned: string[];
  hidden: string[];
  /** surfaceId -> ISO timestamp of first reveal */
  revealed: Record<string, string>;
  /** surfaceId -> ISO timestamp of first visit */
  seen: Record<string, string>;
  showEverything: boolean;
  updatedAt: string | null;
}
```

```ts
// packages/shared/src/validators/ui-preferences.ts
import { z } from "zod";
export const surfaceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
const surfaceIdList = z.array(surfaceIdSchema).max(50);
export const patchUiPreferencesSchema = z
  .object({
    pin: surfaceIdList.optional(),
    unpin: surfaceIdList.optional(),
    hide: surfaceIdList.optional(),
    unhide: surfaceIdList.optional(),
    reveal: surfaceIdList.optional(),
    see: surfaceIdList.optional(),
    showEverything: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one change is required",
  });
export type PatchUiPreferences = z.infer<typeof patchUiPreferencesSchema>;
```

Merge function, shared by server and UI (`packages/shared/src/ui-preferences.ts`, re-exported from the package root; also export `DEFAULT_UI_PREFERENCES: UiPreferences` = `{ pinned: [], hidden: [], revealed: {}, seen: {}, showEverything: false, updatedAt: null }`):

```ts
export function applyUiPreferencesPatch(current: UiPreferences, patch: PatchUiPreferences, now: string): UiPreferences {
  const pinned = new Set(current.pinned);
  const hidden = new Set(current.hidden);
  for (const id of patch.pin ?? []) { pinned.add(id); hidden.delete(id); }
  for (const id of patch.unpin ?? []) pinned.delete(id);
  for (const id of patch.hide ?? []) { hidden.add(id); pinned.delete(id); }
  for (const id of patch.unhide ?? []) hidden.delete(id);
  const revealed = { ...current.revealed };
  for (const id of patch.reveal ?? []) revealed[id] ??= now;
  const seen = { ...current.seen };
  for (const id of patch.see ?? []) { seen[id] ??= now; revealed[id] ??= now; }
  return {
    pinned: [...pinned].sort(),
    hidden: [...hidden].sort(),
    revealed,
    seen,
    showEverything: patch.showEverything ?? current.showEverything,
    updatedAt: now,
  };
}
```

- [ ] **Step 1a: Write failing validator tests** in `ui-preferences.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { patchUiPreferencesSchema, surfaceIdSchema } from "./ui-preferences.js";

describe("patchUiPreferencesSchema", () => {
  it("accepts partial operations", () => {
    expect(patchUiPreferencesSchema.safeParse({ pin: ["nav.projects"], showEverything: true }).success).toBe(true);
  });
  it("rejects an empty patch", () => {
    expect(patchUiPreferencesSchema.safeParse({}).success).toBe(false);
  });
  it("rejects unknown keys", () => {
    expect(patchUiPreferencesSchema.safeParse({ pinned: ["nav.projects"] }).success).toBe(false);
  });
  it("rejects malformed surface ids", () => {
    expect(surfaceIdSchema.safeParse("Nav Projects").success).toBe(false);
    expect(surfaceIdSchema.safeParse("nav.projects").success).toBe(true);
  });
});
```

- [ ] **Step 1b: Write failing tests for `applyUiPreferencesPatch`** in `packages/shared/src/ui-preferences.test.ts`: pin removes from hidden; hide removes from pinned; reveal keeps the first timestamp; see also reveals; showEverything toggles; arrays are sorted and de-duplicated.
- [ ] **Step 2: Run, expect FAIL** (`npx vitest run packages/shared/src/validators/ui-preferences.test.ts packages/shared/src/ui-preferences.test.ts`).
- [ ] **Step 3: Create the source files above and the re-exports.** Follow how `sidebar-preferences` is re-exported (`types/index.ts`, `validators/index.ts`, root `index.ts`). Import style must match neighbouring validators (check whether they import from `"zod"` or `"zod/v4"`).
- [ ] **Step 4: Run tests and `pnpm --filter @paperclipai/shared typecheck`, expect PASS.**
- [ ] **Step 5: Commit** `feat(shared): company signals and UI preference contracts`

---

### Task 2: Signals service and route

**Files:**
- Create: `server/src/services/company-signals.ts`, `server/src/routes/company-signals.ts`, `server/src/__tests__/company-signals-service.test.ts`, `server/src/__tests__/company-signals-routes.test.ts`
- Modify: `server/src/services/index.ts`, `server/src/routes/index.ts`, `server/src/app.ts` (mount next to `dashboardRoutes(db)`), `server/src/routes/openapi.ts`, `server/src/__tests__/openapi-routes.test.ts`
- Possibly modify: `server/src/services/company-artifacts.ts` (add a count method, see Step 3)

**Interfaces:**
- Consumes: `CompanySignals` from Task 1.
- Produces: `companySignalsService(db).get(companyId): Promise<CompanySignals>`; `companySignalsRoutes(db)` serving `GET /companies/:companyId/signals` (mounted under `/api`).

- [ ] **Step 1: Write the failing service test** following `server/src/__tests__/dashboard-service.test.ts` (embedded Postgres via `startEmbeddedPostgresTestDatabase`, `createDb`, cleanup in `afterEach`). Seed two companies. In company A insert: 2 agents (one `status: "terminated"`), 1 built-in agent (`metadata: { paperclipBuiltInAgent: { key: "assistant", featureKeys: [] } }`), 3 visible issues (one `done`), 1 hidden issue (`hiddenAt` set), 2 projects (one archived), 1 goal, 2 routines (one `archived`), 1 company skill with key `paperclipai/paperclip/paperclip` and 1 with key `acme/custom`, 1 approval, 1 `ask_user_questions` interaction and 1 `connection_intent` interaction on a visible issue, 1 cost event this month (250 cents). In company B insert one agent and one issue. Assert for A:

```ts
expect(signals).toMatchObject({
  companyId: companyA, agents: 1, tasks: 3, openTasks: 2, projects: 1, goals: 1, routines: 1,
  extraSkills: 1, connectionRequests: 1, approvalsEver: 1, questionsEver: 1,
  budgetSet: false, monthSpendCents: 250,
});
```

and that B's signals show `agents: 1, tasks: 1`. Use the real column names from the schema files listed in the research notes: `agents` (`agents.ts`), `issues` (`issues.ts`, visibility via `visibleIssueCondition()` and `executionIssueCondition()` from `server/src/services/issue-visibility.ts`), `projects.archivedAt`, `goals`, `routines.status`, `companySkills.key`, `toolConnections` (`tool_access.ts`), `issueThreadInteractions.kind`, `approvals`, `budgetPolicies.amount`/`isActive`, `companies.budgetMonthlyCents`, `costEvents.costCents`/`occurredAt`. Use the minimal required columns for each insert (check `.notNull()` columns without defaults in each schema file).

- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement `companySignalsService`.** Pattern: like `dashboardService`, check the company exists (`notFound("Company not found")`), wrap each query in `retryIdempotentDatabaseOperation`, run counts in parallel with `Promise.all`, convert with `Number(...)`. Agent count excludes `status = 'terminated'` and built-ins: `sql\`not (coalesce(${agents.metadata}, '{}'::jsonb) ? 'paperclipBuiltInAgent')\``. Interactions join `issues` and apply `visibleIssueCondition()`. Artifacts: open `server/src/services/company-artifacts.ts`; if `list` composes its conditions in a reusable way, add `count(companyId, { issueConditions })` that reuses them and returns the total; otherwise count `issueWorkProducts` with `type = 'artifact'` joined to visible issues plus non-system `issueDocuments` (`SYSTEM_ISSUE_DOCUMENT_KEYS`) joined to visible issues. State which approach you chose in the report and add an artifact row to the test seed so `artifacts` is asserted as `1`.
- [ ] **Step 4: Run the service test, expect PASS.**
- [ ] **Step 5: Write the failing route test** `company-signals-routes.test.ts`, copying the mocked-service structure of `server/src/__tests__/sidebar-preferences-routes.test.ts`: GET as a board member of `company-1` returns the mocked signals (200); GET for `company-2` returns 403.
- [ ] **Step 6: Implement the route:**

```ts
router.get("/companies/:companyId/signals", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  res.json(await svc.get(companyId));
});
```

Export, mount (`api.use(companySignalsRoutes(db));` beside `dashboardRoutes`), register in OpenAPI (tag `"dashboard"`, mirror the dashboard entry) and add `"company-signals.ts": "/api"` to the openapi-routes test map.
- [ ] **Step 7: Run both tests + `npx vitest run server/src/__tests__/openapi-routes.test.ts` + `pnpm --filter @paperclipai/server typecheck`, expect PASS.**
- [ ] **Step 8: Commit** `feat(server): company signals endpoint`

---

### Task 3: UI preferences table, service and route

**Files:**
- Create: `packages/db/src/schema/company_user_ui_preferences.ts`, generated migration `packages/db/src/migrations/0331_*.sql` (+ meta), `server/src/services/ui-preferences.ts`, `server/src/routes/ui-preferences.ts`, `server/src/__tests__/ui-preferences-service.test.ts`, `server/src/__tests__/ui-preferences-routes.test.ts`
- Modify: `packages/db/src/schema/index.ts`, `server/src/services/index.ts`, `server/src/routes/index.ts`, `server/src/app.ts` (mount next to `sidebarPreferenceRoutes`), `server/src/routes/openapi.ts`, `server/src/__tests__/openapi-routes.test.ts`

**Interfaces:**
- Consumes: `UiPreferences`, `patchUiPreferencesSchema`, `PatchUiPreferences`, `applyUiPreferencesPatch`, `DEFAULT_UI_PREFERENCES` (Task 1).
- Produces: `uiPreferencesService(db).get(companyId, userId): Promise<UiPreferences>`, `.patch(companyId, userId, patch: PatchUiPreferences): Promise<UiPreferences>`; routes `GET` and `PATCH /companies/:companyId/ui-preferences/me`.

Schema (template: `company_user_sidebar_preferences.ts`):

```ts
export const companyUserUiPreferences = pgTable(
  "company_user_ui_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    pinned: jsonb("pinned").$type<string[]>().notNull().default([]),
    hidden: jsonb("hidden").$type<string[]>().notNull().default([]),
    revealed: jsonb("revealed").$type<Record<string, string>>().notNull().default({}),
    seen: jsonb("seen").$type<Record<string, string>>().notNull().default({}),
    showEverything: boolean("show_everything").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_user_ui_preferences_company_idx").on(table.companyId),
    userIdx: index("company_user_ui_preferences_user_idx").on(table.userId),
    companyUserUq: uniqueIndex("company_user_ui_preferences_company_user_uq").on(table.companyId, table.userId),
  }),
);
```

Patch semantics: use `applyUiPreferencesPatch` from `@paperclipai/shared` (Task 1).

`patch` runs in a transaction: `insert ... onConflictDoNothing()` for the (company, user) row, `select ... for update`, `applyUiPreferencesPatch`, `update`, return. `get` returns defaults (`[]`, `{}`, `false`, `updatedAt: null`) when no row exists without inserting.

- [ ] **Step 1: Add the schema file + export, build and generate the migration** (`pnpm db:generate`). Inspect the generated SQL: one `CREATE TABLE`, FK with `ON DELETE cascade`, three indexes. Run `pnpm --filter @paperclipai/db typecheck`.
- [ ] **Step 2: Implement the service** (using shared `applyUiPreferencesPatch`) and add a DB-backed service test (embedded Postgres, like `dashboard-service.test.ts`): `get` defaults; two sequential patches merge; another user's row is independent; deleting the company cascades.
- [ ] **Step 3: Run the service test, expect PASS.**
- [ ] **Step 4: Write failing route tests** (mocked service, structure of `sidebar-preferences-routes.test.ts`): GET 200 for a member; PATCH 200 for a member with role `viewer` (personal preference); PATCH 400 for `{}`; GET 403 for a non-member; PATCH calls `logActivity` with `action: "ui_preferences.updated"`, `entityType: "company"`, `entityId: companyId`, and `details` equal to the patch body.
- [ ] **Step 5: Implement the routes** with a router-level guard copied from `primary-agent.ts:14-27` (board actor, company access, user id required, active membership unless local implicit or instance admin, company exists) and `validate(patchUiPreferencesSchema)` on PATCH. Mount, register OpenAPI (tag `"sidebar"`), add `"ui-preferences.ts": "/api"` to the openapi-routes map.
- [ ] **Step 6: Run route tests, openapi-routes test, server typecheck. Expect PASS.**
- [ ] **Step 7: Commit** `feat: per-person UI preferences for adaptive navigation`

---

### Task 4: UI data layer

**Files:**
- Create: `ui/src/api/companySignals.ts`, `ui/src/api/uiPreferences.ts`, `ui/src/hooks/useCompanySignals.ts`, `ui/src/hooks/useUiPreferences.ts`, `ui/src/hooks/useUiPreferences.test.tsx`
- Modify: `ui/src/api/index.ts`, `ui/src/lib/queryKeys.ts`, `ui/src/context/LiveUpdatesProvider.tsx` (+ its test file if one covers `invalidateActivityQueries`)

**Interfaces — Produces:**

```ts
// ui/src/api/companySignals.ts
export const companySignalsApi = {
  get: (companyId: string) => api.get<CompanySignals>(`/companies/${companyId}/signals`),
};
// ui/src/api/uiPreferences.ts
export const uiPreferencesApi = {
  get: (companyId: string) => api.get<UiPreferences>(`/companies/${companyId}/ui-preferences/me`),
  patch: (companyId: string, patch: PatchUiPreferences) =>
    api.patch<UiPreferences>(`/companies/${companyId}/ui-preferences/me`, patch),
};
// ui/src/lib/queryKeys.ts (add)
signals: (companyId: string) => ["company-signals", companyId] as const,
uiPreferences: (companyId: string, userId: string) => ["ui-preferences", companyId, userId] as const,
// hooks
export function useCompanySignals(companyId: string | null | undefined):
  { signals: CompanySignals | null; loaded: boolean; failed: boolean };
export function useUiPreferences(companyId: string | null | undefined): {
  preferences: UiPreferences; // defaults while loading
  loaded: boolean;
  failed: boolean;
  update: (patch: PatchUiPreferences) => void; // optimistic; skips no-op patches
};
```

If `api.patch` does not exist in `ui/src/api/client.ts`, add it following `api.put`.

`useUiPreferences.update` applies the patch optimistically with shared `applyUiPreferencesPatch`, then `setQueryData` with the server response, and rolls back on error. It must skip the network call when the patch changes nothing (for example revealing an already revealed id). User id comes from the session query the same way `ui/src/hooks/useProjectOrder.ts` gets it.

LiveUpdatesProvider: invalidate `queryKeys.signals(companyId)` at the top of `invalidateActivityQueries` (next to `queryKeys.dashboard(companyId)` and `queryKeys.sidebarBadges(companyId)`) and in the `agent.status` handler.

- [ ] **Step 1: Write failing hook tests** (`// @vitest-environment jsdom`, QueryClient with `retry: false`, mock `../api/uiPreferences` and the session API): `update({ pin: ["nav.goals"] })` shows `nav.goals` in `preferences.pinned` before the request resolves; a rejected request restores the previous value; `update({ reveal: ["nav.projects"] })` when already revealed makes no request.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the api modules, keys, hooks and live invalidation.**
- [ ] **Step 4: Run the hook tests, the LiveUpdatesProvider tests, UI + server + shared typechecks. Expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): signals and UI preference hooks`

---

### Task 5: Surface registry and resolver

**Files:**
- Create: `ui/src/staples/surfaces/registry.ts`, `ui/src/staples/surfaces/resolve.ts`, `ui/src/staples/surfaces/resolve.test.ts`, `ui/src/staples/surfaces/index.ts`

**Interfaces — Produces:**

```ts
// registry.ts
import type { LucideIcon } from "lucide-react";
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
  /** First path segment(s) after the company prefix that count as visiting this surface. */
  matchRoots: string[];
  icon: LucideIcon;
  group: SurfaceGroup;
  tier: SurfaceTier;
  available?: (ctx: SurfaceContext) => boolean;
  revealWhen?: (ctx: SurfaceContext) => boolean;
  reason?: string;
}
```

Registry entries (in render order; icons from `lucide-react` as in today's `Sidebar.tsx`):

| id | label | to | matchRoots | icon | group | tier | available | revealWhen | reason |
|---|---|---|---|---|---|---|---|---|---|
| nav.dashboard | Dashboard | /dashboard | dashboard | LayoutDashboard | top | core | – | – | – |
| nav.inbox | Inbox | /inbox | inbox | Inbox | top | grows | `flags?.enableCombinedInboxTasks !== true` | `ctx.inboxUnread > 0` | "Inbox appeared because something is waiting for you." |
| nav.decisions | Decisions | /decisions | decisions | ListChecks | top | grows | `flags?.enableDecisions === true` | `approvalsEver + questionsEver > 0` | "Decisions appeared because an agent asked you something." |
| nav.status | Status | /status | status | LayoutGrid | top | advanced | `flags?.enableStatusCards === true` | – | – |
| nav.chat | Chat | /chats | chats | MessageCircle | work | core | `flags?.enableAgentChat === true` | – | – |
| nav.tasks | Tasks | /issues | issues, tasks | CircleCheck | work | core | – | – | – |
| nav.projects | Projects | /projects | projects | FolderOpen | work | grows | – | `projects >= 2 \|\| tasks >= 25` | "Projects appeared because you have enough work to group." |
| nav.routines | Routines | /routines | routines | Repeat | work | grows | – | `routines >= 1` | "Routines appeared because you created a recurring job." |
| nav.artifacts | Artifacts | /artifacts | artifacts | Package | work | grows | – | `artifacts >= 1` | "Artifacts appeared because your agents produced deliverables." |
| nav.goals | Goals | /goals | goals | Target | work | grows | – | `goals >= 2` | "Goals appeared because you have more than one goal." |
| nav.cases | Cases | /cases | cases | Layers | work | advanced | `flags?.enableCases === true` | – | – |
| nav.pipelines | Pipelines | /pipelines | pipelines, review-queue, learnings | GitBranch | work | advanced | `flags?.enablePipelines === true` | – | – |
| nav.workspaces | Workspaces | /workspaces | workspaces, execution-workspaces | GitBranch | work | advanced | `flags?.enableIsolatedWorkspaces === true && flags?.enableAgentChat !== true` | – | – |
| nav.agents | Agents | /agents | agents, org | Users | org | core | – | – | – |
| nav.skills | Skills | /skills | skills | Boxes | org | grows | – | `extraSkills >= 1` | "Skills appeared because your company added its own skills." |
| nav.connectors | Connectors | /apps | apps | Unplug | org | grows | – | `connections >= 1 \|\| connectionRequests >= 1` | "Connectors appeared because an app connection exists or was requested." |
| nav.costs | Costs | /activity/costs | (none) | DollarSign | org | grows | – | `budgetSet \|\| monthSpendCents > 0` | "Costs appeared because spending started." |
| nav.audit | Audit | /activity | activity, audit, runs, costs, budgets | History | org | advanced | – | – | – |

`nav.costs` has empty `matchRoots` so visiting Audit's Costs tab reveals Audit, not both. All `revealWhen` functions return `false` when `ctx.signals` is null (signals not loaded).

```ts
// resolve.ts
import type { UiPreferences } from "@paperclipai/shared";
import type { SurfaceContext, SurfaceDefinition } from "./registry";

export interface SurfaceState {
  surface: SurfaceDefinition;
  available: boolean;
  visible: boolean;
  /** Visible because of growth or a visit, and the person has not visited it yet. */
  isNew: boolean;
  /** The growth rule fires but the reveal has not been persisted yet. */
  shouldPersistReveal: boolean;
  /** Why it is visible: used by the "More" menu and tests. */
  source: "unavailable" | "hidden" | "pinned" | "everything" | "revealed" | "core" | "grows" | "advanced";
}

export function resolveSurface(surface: SurfaceDefinition, ctx: SurfaceContext, prefs: UiPreferences): SurfaceState {
  const available = surface.available ? surface.available(ctx) : true;
  const growthFires = surface.tier === "grows" && ctx.signals !== null && (surface.revealWhen?.(ctx) ?? false);
  const revealed = surface.id in prefs.revealed;
  const base = { surface, available, isNew: false, shouldPersistReveal: false };
  if (!available) return { ...base, visible: false, source: "unavailable" };
  if (prefs.hidden.includes(surface.id)) return { ...base, visible: false, source: "hidden" };
  const shouldPersistReveal = growthFires && !revealed;
  const isNew = (revealed || growthFires) && surface.tier !== "core" && !(surface.id in prefs.seen);
  if (prefs.pinned.includes(surface.id)) return { ...base, visible: true, shouldPersistReveal, source: "pinned" };
  if (prefs.showEverything) return { ...base, visible: true, shouldPersistReveal, source: "everything" };
  if (surface.tier === "core") return { ...base, visible: true, source: "core" };
  if (revealed) return { ...base, visible: true, isNew, source: "revealed" };
  if (growthFires) return { ...base, visible: true, isNew, shouldPersistReveal, source: "grows" };
  return { ...base, visible: false, source: surface.tier };
}

export function resolveSurfaces(surfaces: readonly SurfaceDefinition[], ctx: SurfaceContext, prefs: UiPreferences): SurfaceState[] {
  return surfaces.map((surface) => resolveSurface(surface, ctx, prefs));
}

export function surfaceForPath(surfaces: readonly SurfaceDefinition[], pathWithoutPrefix: string): SurfaceDefinition | null {
  const root = pathWithoutPrefix.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!root) return null;
  return surfaces.find((surface) => surface.matchRoots.includes(root)) ?? null;
}
```

- [ ] **Step 1: Write failing tests** in `resolve.test.ts` using a `signals(overrides)` fixture (all zeros) and `prefs(overrides)` fixture (empty). Cover:
  1. Fresh company (all zero signals): visible ids are exactly `nav.dashboard`, `nav.tasks`, `nav.agents` (flags all false/undefined, inboxUnread 0).
  2. `projects: 2` → `nav.projects` visible, `isNew: true`, `shouldPersistReveal: true`, `source: "grows"`.
  3. Revealed `nav.projects` with `projects: 0` → still visible (`source: "revealed"`), `shouldPersistReveal: false`.
  4. Revealed and seen → `isNew: false`.
  5. Hidden beats pinned, growth and showEverything.
  6. `showEverything` shows advanced surfaces only when available (`nav.cases` hidden unless `flags.enableCases`).
  7. Unavailable surface stays hidden even when pinned.
  8. Signals null → only core surfaces visible; no `shouldPersistReveal`.
  9. `surfaceForPath(REGISTRY, "/issues/PAP-1")` → `nav.tasks`; `"/activity/costs"` → `nav.audit`; `"/unknown"` → null.
  10. Every registry id matches `surfaceIdSchema` from `@paperclipai/shared`, ids are unique, and `nav.costs.matchRoots` is empty.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `registry.ts` (export `SURFACE_REGISTRY: readonly SurfaceDefinition[]`), `resolve.ts`, and `index.ts` re-exports.**
- [ ] **Step 4: Run tests and UI typecheck, expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): adaptive navigation surface registry`

---

### Task 6: `useSurfaces` hook with reveal persistence and visit tracking

**Files:**
- Create: `ui/src/staples/surfaces/useSurfaces.ts`, `ui/src/staples/surfaces/useSurfaces.test.tsx`, `ui/src/staples/surfaces/SurfaceTracker.tsx`
- Modify: `ui/src/components/Layout.tsx` (render `<SurfaceTracker />` once inside the company layout)

**Interfaces:**
- Consumes: `useCompanySignals`, `useUiPreferences` (Task 4); `SURFACE_REGISTRY`, `resolveSurfaces`, `surfaceForPath` (Task 5); `useInboxBadge(companyId)` (`ui/src/hooks/useInboxBadge.ts`, `.inbox` count); experimental settings via `queryKeys.instance.experimentalSettings` / `instanceSettingsApi.getExperimental()`.
- Produces:

```ts
export function useSurfaces(): {
  states: SurfaceState[];          // registry order
  visible: SurfaceState[];          // states.filter(s => s.visible)
  hiddenAvailable: SurfaceState[];  // available && !visible
  preferences: UiPreferences;
  ready: boolean;                   // flags and preferences loaded (signals may still be loading)
  update: (patch: PatchUiPreferences) => void;
};
```

`SurfaceTracker` (renders null):
1. When `ready` and some states have `shouldPersistReveal`, call `update({ reveal: ids })` once per distinct id set (guard with a ref so re-renders don't resend).
2. On every location change, strip the company prefix (use `useParams().companyPrefix` or `ui/src/lib/company-routes.ts` helpers), find `surfaceForPath`, and if that surface is not core and not already in `preferences.seen`, call `update({ see: [id] })` (this also reveals it).

- [ ] **Step 1: Write failing tests** (jsdom; mock `useCompanySignals`, `useUiPreferences`, `useInboxBadge`, experimental settings API, and `@/lib/router` location): a growth-fired surface triggers exactly one `update({ reveal: ["nav.projects"] })` across re-renders; navigating to `/PAP/routines` triggers `update({ see: ["nav.routines"] })`; navigating to `/PAP/issues` triggers nothing (core); `ready` is false until flags and preferences load.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement hook + tracker; mount the tracker in `Layout.tsx`.**
- [ ] **Step 4: Run tests, UI typecheck, `npx vitest run ui/src/components/Layout.test.tsx`. Expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): persist surface reveals and visits`

---

### Task 7: Render navigation from the registry

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`, `ui/src/components/Sidebar.test.tsx`, `ui/src/components/SidebarNavItem.tsx` (+ test), `ui/src/components/MobileBottomNav.tsx`, `ui/src/components/CommandPalette.tsx` (+ test)
- Modify (retire flag): `packages/shared/src/feature-catalog.ts` (`RETIRED_FEATURE_KEYS` += `enableGoalsSidebarLink`), `packages/shared/src/validators/instance.ts` (move to the deprecated block, keep default false), `packages/shared/src/types/instance.ts` (`@deprecated`), `ui/src/pages/InstanceExperimentalSettings.tsx` (+ test) (remove its toggle), shared validator tests (extend the retired-key tests)

**Interfaces:**
- Consumes: `useSurfaces()` (Task 6).
- Produces: `SidebarNavItem` gains an optional `hint?: string` prop rendered as the item's tooltip/`title` text, used for the reveal `reason` while `isNew`.

Rules:
- **Sidebar:** keep the company menu, New Task button and Search row exactly as today. Render `top` group surfaces after Search, then the "Work" section with `work` surfaces, then the "Org" section with `org` surfaces. Omit a section header when it has no visible surfaces. Keep existing per-item extras by surface id: `nav.dashboard` → `liveCount`; `nav.inbox` → inbox badge props; `nav.tasks` → inbox badge props when `enableCombinedInboxTasks`; `nav.decisions` → attention badge (keep the existing attention query, enabled only when `nav.decisions` is visible); `nav.status`/`nav.cases` → `textBadge="beta"`. When `isNew`, pass `textBadge="new"` (takes precedence over "beta") and `hint={surface.reason}`. Keep `<SidebarStarredProjects />` directly after `nav.projects` only when Projects is visible. Keep plugin outlets at the end of Work, `<SidebarAgents />`, `<SidebarRecentTasks />` and the `sidebarPanel` outlet unchanged. Remove the Goals loading placeholder (the registry no longer depends on that flag).
- **No flash:** while `ready` is false render only core surfaces plus surfaces already in `preferences.revealed` / `pinned` from cache; never render then remove a grows item because signals arrived.
- **MobileBottomNav:** keep its fixed shape (Home, Chat when visible, New Task, Tasks, Agents, Inbox when `nav.inbox` is visible), driven by `useSurfaces` visibility instead of flags.
- **CommandPalette "Pages":** list every *available* surface (visible or not) so hidden pages stay one search away; label hidden ones with a muted "hidden" suffix. Selecting navigates (the tracker then reveals it).

- [ ] **Step 1: Update/extend tests first:** Sidebar test "fresh company shows Dashboard, Tasks and Agents only" (mock `useSurfaces`); "a grows surface marked new renders the new badge and hint"; "Starred projects render only with Projects"; replace flag-combination tests with registry-driven equivalents; CommandPalette lists Routines even when hidden; SidebarNavItem renders `hint` as `title`. Extend the shared retired-key tests to cover `enableGoalsSidebarLink`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Delete the `goalsLinkPending` placeholder and its test ("does not flash the Workspaces link while experimental settings are loading" becomes a registry no-flash test).
- [ ] **Step 4: Run Sidebar/SidebarNavItem/CommandPalette/MobileBottomNav-related tests, shared tests, UI + shared typechecks, then the full UI suite. Expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): render navigation from the adaptive surface registry`

---

### Task 8: "More" menu for hidden surfaces and personal controls

**Files:**
- Create: `ui/src/staples/surfaces/SidebarMoreMenu.tsx`, `ui/src/staples/surfaces/SidebarMoreMenu.test.tsx`
- Modify: `ui/src/components/Sidebar.tsx` (render the menu after the Org section)

**Interfaces:**
- Consumes: `useSurfaces()` (`hiddenAvailable`, `visible`, `preferences`, `update`).

Behaviour:
- A sidebar row "More" (`Ellipsis` icon; rail mode shows icon + tooltip) that opens a popover (use the existing `components/ui/popover` primitive; if none exists use `DropdownMenu` from `components/ui`).
- Section "Open": one row per `hiddenAvailable` surface (icon + label); clicking navigates to `surface.to` and closes the popover.
- Section "In your sidebar": one row per visible non-core surface with a "Hide" action (`update({ hide: [id] })`), and per hidden-by-person surface an "Unhide" action (`update({ unhide: [id] })`).
- A "Show everything" switch bound to `preferences.showEverything` (`update({ showEverything: value })`).
- Render nothing when there are no hidden available surfaces, no non-core visible surfaces and `showEverything` is false.

- [ ] **Step 1: Write failing tests:** hidden Routines appears under "Open" and clicking navigates to `/routines`; "Hide" on Projects calls `update({ hide: ["nav.projects"] })`; toggling "Show everything" calls `update({ showEverything: true })`; the menu is absent when nothing qualifies.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests, UI typecheck and full UI suite. Expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): More menu for hidden navigation surfaces`

---

### Task 9: Phase verification

- [ ] **Step 1:** `pnpm typecheck`; `cd ui && npx vitest run`; `npx vitest run packages/shared server/src/__tests__/company-signals-service.test.ts server/src/__tests__/company-signals-routes.test.ts server/src/__tests__/ui-preferences-service.test.ts server/src/__tests__/ui-preferences-routes.test.ts server/src/__tests__/openapi-routes.test.ts`; `pnpm --filter @paperclipai/ui build`.
- [ ] **Step 2:** Restart the dev server (`staples-dev` in `.claude/launch.json`; it runs migrations). In a fresh browser tab on the existing test company (no agents): the sidebar shows New Task, Search, Dashboard, Work → Tasks, Org → Agents, More. Create two projects via the API (`POST /api/companies/:id/projects`); without a reload the sidebar shows Projects with a "new" badge. Visit `/PREFIX/routines` directly: Routines appears in the sidebar. Hide Projects from More: it disappears; reload: still hidden. Toggle Show everything: Audit appears. Console has no errors.
- [ ] **Step 3:** Record results in the ledger.

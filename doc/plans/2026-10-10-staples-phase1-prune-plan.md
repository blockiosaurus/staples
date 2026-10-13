# Staples Phase 1: Prune and Route Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy UI shell, UX lab/preview pages and the Board Chat relay, and make unprefixed board URLs (for example `/dashboard`) redirect to the selected company, so later phases build on one shell.

**Architecture:** The streamlined shell becomes the only shell. Every `enableStreamlinedUi` branch collapses to its "enabled" side. Retired experimental keys stay in the strict Zod schema as deprecated compatibility keys (the existing pattern used by `enableApps`), so stored settings rows still parse, but nothing reads them. Spec: `doc/plans/2026-10-10-staples-adaptive-ux-design.md` (section 7, Pruning).

**Tech Stack:** React 19, react-router-dom v7, TanStack Query v5, Vitest 5 (jsdom), Express, Zod, pnpm workspaces.

## Global Constraints

- Hard fork: upstream merge compatibility is not a goal.
- Do not change behavior of the streamlined shell except where a task says so.
- Retired experimental keys must remain accepted by `instanceExperimentalSettingsSchema` (it is `.strict()`); mark them with a `// Deprecated compatibility key.` comment.
- Run single UI tests with `npx vitest run <path>` from the repo root. Run the whole UI suite with `cd ui && npx vitest run`. Typecheck UI with `pnpm --filter @paperclipai/ui typecheck`; server with `pnpm --filter @paperclipai/server typecheck`; shared with `pnpm --filter @paperclipai/shared typecheck`.
- A task is done only when its typecheck and the tests it touches pass. The UI baseline is fully green (719 files, 8101 tests, log at `tmp/ui-tests-baseline.log`), so any UI test failure is a regression. Server baseline: `tmp/server-tests-baseline.log`.
- Commit after each task. Message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Redirect unprefixed board paths

**Problem:** `/dashboard` renders "Organization not found" because `Layout` treats `dashboard` as a company prefix. `ui/src/lib/company-routes.ts` already has `isBoardPathWithoutPrefix(pathname)` backed by `BOARD_ROUTE_ROOTS`.

**Files:**
- Modify: `ui/src/components/Layout.tsx` (the `hasUnknownCompanyPrefix ? <NotFoundPage ...>` branch near line 730)
- Modify: `ui/src/lib/company-routes.ts` (`BOARD_ROUTE_ROOTS`: remove the duplicate `"artifacts"`, add `"assistant"`, `"routines"` is present, add `"cases"`, `"status"`, `"pipelines"`, `"review-queue"`, `"learnings"`, `"onboarding"` is NOT added)
- Test: `ui/src/lib/company-routes.test.ts`, `ui/src/components/Layout.test.tsx`

**Interfaces:**
- Consumes: `isBoardPathWithoutPrefix(pathname: string): boolean`, `UnprefixedBoardRedirect` (defined in `ui/src/App.tsx`; export it from a new file so Layout can import it without a cycle).
- Produces: `ui/src/components/UnprefixedBoardRedirect.tsx` exporting `UnprefixedBoardRedirect` (moved verbatim from `App.tsx`, App imports it from there).

- [ ] **Step 1: Write failing route-helper test**

Add to `ui/src/lib/company-routes.test.ts`:

```ts
it("treats every top-level board section as an unprefixed board path", () => {
  for (const root of ["dashboard", "assistant", "cases", "status", "pipelines", "review-queue", "learnings"]) {
    expect(isBoardPathWithoutPrefix(`/${root}`)).toBe(true);
    expect(extractCompanyPrefixFromPath(`/${root}/x`)).toBeNull();
  }
});
```

- [ ] **Step 2: Run it, expect FAIL** (`assistant`, `cases`, etc. missing)

Run: `npx vitest run ui/src/lib/company-routes.test.ts`

- [ ] **Step 3: Update `BOARD_ROUTE_ROOTS`** with the additions listed above and remove the duplicate `"artifacts"`. Rerun, expect PASS.

- [ ] **Step 4: Move `UnprefixedBoardRedirect`** out of `App.tsx` into `ui/src/components/UnprefixedBoardRedirect.tsx` (copy the function and its imports exactly; `export function UnprefixedBoardRedirect()`), and import it in `App.tsx`.

- [ ] **Step 5: Write failing Layout test**

In `ui/src/components/Layout.test.tsx`, follow the existing render helper used by the "does not render the deployment explainer" test, render at `/dashboard` with one company `{ issuePrefix: "TST" }` selected, and assert navigation lands on `/TST/dashboard` (assert via the test's location probe or `screen.queryByText("Organization not found")` being null and the router location pathname `"/TST/dashboard"`).

- [ ] **Step 6: Run it, expect FAIL.**

Run: `npx vitest run ui/src/components/Layout.test.tsx -t "unprefixed"`

- [ ] **Step 7: Implement** in `Layout.tsx`:

```tsx
{hasUnknownCompanyPrefix ? (
  isBoardPathWithoutPrefix(location.pathname) ? (
    <UnprefixedBoardRedirect />
  ) : (
    <NotFoundPage
      scope="invalid_company_prefix"
      requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix}
    />
  )
) : (
```

Import `isBoardPathWithoutPrefix` from `@/lib/company-routes` and `UnprefixedBoardRedirect` from `./UnprefixedBoardRedirect`. Use the `location` already in scope in Layout (add `const location = useLocation()` from `@/lib/router` if not present).

- [ ] **Step 8: Run both tests and UI typecheck, expect PASS.**

- [ ] **Step 9: Commit** `fix(ui): redirect unprefixed board paths to the selected company`

---

### Task 2: Collapse streamlined flag inside components and pages

Every component below reads `useStreamlinedUiEnabled()` (or receives a `streamlinedUi`/`streamlinedUiEnabled` prop derived from it). Make each behave as if the flag is `true` and delete the dead `false` branches.

**Files (modify):**
`ui/src/components/IssuesList.tsx`, `NewIssueDialog.tsx`, `PropertiesPanel.tsx`, `TaskChatThread.tsx`, `issue-properties/IssueProperties.tsx`, `issue-properties/property-picker.tsx`, `ui/src/hooks/useCombinedInboxTasksEnabled.ts`, `ui/src/pages/Agents.tsx`, `CompanySkills.tsx`, `Inbox.tsx`, `IssueDetail.tsx`, `Issues.tsx`, `MyIssues.tsx`, `RoutineDetail.tsx`, `Routines.tsx`, `Timeline.tsx`, `audit/CompanyActivity.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/Layout.tsx`.

**Tests (modify):** the matching `*.test.tsx` files that mock `useStreamlinedUiEnabled` or set `enableStreamlinedUi: false`: `IssueProperties.test.tsx`, `IssuesList.test.tsx`, `Layout.test.tsx`, `PropertiesPanel.test.tsx`, `Sidebar.test.tsx`, `TaskChatThread.test.tsx`, `useCombinedInboxTasksEnabled.test.ts`, `Inbox.test.tsx`, `IssueDetail.test.tsx`, `App.activity-routing.test.tsx`.

**Interfaces:**
- Produces: no component or hook in this list references `useStreamlinedUiEnabled`, `resolveStreamlinedUiEnabled` or `enableStreamlinedUi` after this task. `useCombinedInboxTasksEnabled()` keeps its signature `{ enabled: boolean; loaded: boolean }` but only reads `enableCombinedInboxTasks`.

- [ ] **Step 1: For each file, apply the collapse rules:**
  1. `const { enabled: x } = useStreamlinedUiEnabled()` → delete; replace reads of `x` with `true` and simplify (`x && y` → `y`, `x ? A : B` → `A`, `!x && y` → remove).
  2. Props named `streamlinedUi`/`streamlinedUiEnabled`/`streamlined` whose only source is the flag: remove the prop from the component signature and all call sites, inlining the `true` behavior. Props named `streamlined` on `SidebarAgents` that are always passed `true` from `Sidebar.tsx`: keep the prop removal consistent (inline `true`).
  3. Delete imports that become unused.
- [ ] **Step 2: Tests:** delete test cases whose title or setup exercises the legacy (`false`) path (for example "keeps the global sidebar beside legacy settings navigation when Streamlined UI is off"); remove `enableStreamlinedUi` from fixtures; remove `vi.mock` of `useStreamlinedUiEnabled`.
- [ ] **Step 3: Verify no references remain:**

Run: `grep -rn "treamlinedUi\|useStreamlinedUiEnabled" ui/src --include='*.ts' --include='*.tsx' | grep -v "App.tsx\|hooks/useStreamlinedUiEnabled\|\.production\."`
Expected: no output.

- [ ] **Step 4: Run UI typecheck and the modified tests.** Expected: PASS (except baseline failures).

Run: `pnpm --filter @paperclipai/ui typecheck && npx vitest run ui/src/components ui/src/pages ui/src/hooks`

- [ ] **Step 5: Commit** `refactor(ui): make the streamlined shell unconditional in components`

---

### Task 3: Delete the legacy shell and production pages

**Files:**
- Delete: all 22 `ui/src/**/*.production.tsx` files (`components/AppConnectionSidebar`, `AppsSidebar`, `BreadcrumbBar`, `CompanySettingsSidebar`, `Layout`, `SecondarySidebar`, `Sidebar`, `SidebarAccountMenu`, `SidebarAgents`, `SidebarCompanyMenu`, `SidebarNavItem`, `SidebarShell`, `SidebarStarredProjects`, `routine-sections/editable-sections`; `pages/AgentDetail`, `Agents`, `CompanySkills`, `OrgChart`, `RoutineDetail`, `Routines`, `audit/AuditFeed`, `audit/CompanyActivity`).
- Delete: `ui/src/hooks/useStreamlinedUiEnabled.ts`, `ui/src/hooks/useStreamlinedUiEnabled.test.tsx`.
- Modify: `ui/src/App.tsx` (remove `ProductionLayout` import, the `Production*` lazy imports, `ProductionSurface`, the `streamlinedUiEnabled` parameter of `boardRoutes`, every ternary on it, and the `streamlinedUiLoaded` gates: use `<CloudAccessGate ... />` directly).
- Modify tests importing production files: `App.activity-routing.test.tsx`, `components/AppsSidebar.test.tsx`, `SidebarAccountMenu.test.tsx`, `SidebarCompanyMenu.test.tsx`, `chat/ChatDetailSidebar.test.tsx`, `pages/AgentDetail.log-visibility.test.tsx`, `pages/Agents.test.tsx` (delete the cases that render a production component; keep the rest).
- Modify: `ui/storybook/stories/primary-agent/PrimaryAgentStory.tsx`, `file-viewer.stories.tsx`, `fireflies-pr.stories.tsx` if they import production files or the hook (replace with the streamlined component of the same name).

**Interfaces:**
- Consumes: Task 2 (no component reads the flag).
- Produces: `boardRoutes(combinedInboxTasksEnabled: boolean)`. `/:prefix/org` always redirects to `/agents/all`; `/:prefix/timeline` always redirects to `/activity/timeline`; `/:prefix/costs` follows the streamlined branch.

- [ ] **Step 1:** Edit `App.tsx` as described. Where a route had `streamlinedUiEnabled ? A : B`, keep `A`. Where a block was `{streamlinedUiEnabled ? (<>…</>) : null}`, keep the fragment contents unconditionally; where `: (<>…</>)` held legacy-only routes (for example legacy `costs`), delete them.
- [ ] **Step 2:** `git rm` the production files and the hook files.
- [ ] **Step 3:** Fix test and story imports listed above.
- [ ] **Step 4: Verify**

Run: `grep -rn "\.production\"\|useStreamlinedUiEnabled\|ProductionSurface" ui/src ui/storybook`
Expected: no output.

Run: `pnpm --filter @paperclipai/ui typecheck && cd ui && npx vitest run`
Expected: typecheck clean; test failures only from the baseline list.

- [ ] **Step 5:** Start the dev server (`.claude/launch.json` entry `staples-dev`) and confirm `/TEST/agents/all`, `/TEST/routines`, `/TEST/activity` and `/TEST/skills` render (replace `TEST` with the local company prefix).
- [ ] **Step 6: Commit** `refactor(ui): delete the legacy shell and production pages`

---

### Task 4: Retire the streamlined flag in shared and server

**Files:**
- Modify: `packages/shared/src/validators/instance.ts` — move `enableStreamlinedUi` (and `enableStreamlinedLeftNavigation` if it is unread after Task 2; check with grep) under a `// Deprecated compatibility key. The streamlined shell is the only shell; this remains accepted so older stored rows and managed configs continue to load.` comment. Keep `z.boolean().default(true)`.
- Modify: `packages/shared/src/feature-catalog.ts` — delete the `enableStreamlinedUi` entry (and `enableStreamlinedLeftNavigation` if retired).
- Modify: `packages/shared/src/types/instance.ts` — keep the field with a `/** @deprecated */` JSDoc.
- Modify: `server/src/services/instance-settings.ts` — keep normalization (`?? true`) so responses stay shape-compatible.
- Modify: `ui/src/pages/InstanceExperimentalSettings.tsx` and its test — remove the toggle row(s) for the retired key(s).
- Modify tests: `packages/shared/src/validators/instance.test.ts`, `server/src/__tests__/instance-settings-*.test.ts` — keep parse-compat assertions; drop assertions about the toggle's catalog metadata.

**Interfaces:**
- Produces: `featureCatalog` has no `enableStreamlinedUi` key; schema still parses `{ enableStreamlinedUi: false }`.

- [ ] **Step 1: Write failing test** in `packages/shared/src/validators/instance.test.ts`:

```ts
it("still accepts the retired enableStreamlinedUi key", () => {
  expect(instanceExperimentalSettingsSchema.safeParse({ enableStreamlinedUi: false }).success).toBe(true);
});
it("does not expose enableStreamlinedUi in the feature catalog", () => {
  expect(Object.keys(EXPERIMENTAL_FEATURE_CATALOG)).not.toContain("enableStreamlinedUi");
});
```

Use the actual exported catalog name from `feature-catalog.ts` (check with `grep -n "export const" packages/shared/src/feature-catalog.ts`).

- [ ] **Step 2: Run, expect the catalog test to FAIL.** `npx vitest run packages/shared/src/validators/instance.test.ts`
- [ ] **Step 3: Apply the edits above.** Rerun; PASS.
- [ ] **Step 4:** `pnpm --filter @paperclipai/shared typecheck && pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/ui typecheck && npx vitest run server/src/__tests__/instance-settings-service.test.ts server/src/__tests__/instance-settings-routes.test.ts server/src/__tests__/instance-settings-cloud-defaults.test.ts ui/src/pages/InstanceExperimentalSettings.test.tsx`
- [ ] **Step 5: Commit** `refactor: retire the streamlined UI experimental flag`

---

### Task 5: Delete UX lab and preview surfaces

**Files:**
- Delete: `ui/src/pages/BootstrapSetupUxLab.tsx`, `CrossIssueCollaborationUxLab.tsx`, `InviteUxLab.tsx`, `InviteUxLab.test.tsx`, `IssueChatUxLab.tsx`, `ResponsibleUserDenialUxLab.tsx`, `RunTranscriptUxLab.tsx`, `SystemNoticeUxLab.tsx`, `IssueChatLongThreadPerf.tsx` (route `tests/perf/long-thread`).
- Delete: `ui/src/wizard-preview-main.tsx`, `connect-flow-preview-main.tsx`, `connect-model-preview-main.tsx`, `ui/wizard-preview.html`, `ui/connect-flow-preview.html`, `ui/connect-model-preview.html`, `ui/vite.preview.config.mjs`, `ui/vite.flow-preview.config.mjs`.
- Delete: `ui/storybook/stories/ux-labs.stories.tsx`.
- Modify: `ui/src/App.tsx` — remove the `ux-lab/*` and `tests/perf/long-thread` routes and imports. Keep `dev/task-chat-lab` only if its page is not one of the deleted files; otherwise remove it too.
- Modify: `ui/package.json` — remove the `build:preview` script; root `package.json` scripts that reference removed configs (check with grep).
- Modify: `scripts/codemod-extract-colors.mjs` — remove references to deleted files from its file list.
- Keep: `ui/vite.qa.config.mjs` unless it only serves deleted entries (check its `input`).

- [ ] **Step 1:** Before deleting, check for other importers:

Run: `grep -rln "BootstrapSetupUxLab\|CrossIssueCollaborationUxLab\|InviteUxLab\|IssueChatUxLab\|ResponsibleUserDenialUxLab\|RunTranscriptUxLab\|SystemNoticeUxLab\|IssueChatLongThreadPerf\|preview-main\|preview.html\|vite.preview.config\|vite.flow-preview" ui scripts package.json .github docs doc --exclude-dir=node_modules`

If a non-deleted, non-test module imports shared helpers *from* a lab page (for example a fixture), move that helper next to its consumer instead of deleting it.

- [ ] **Step 2:** Delete files and edit references.
- [ ] **Step 3:** Rerun the grep; expected output only in `doc/` history files (leave docs alone).
- [ ] **Step 4:** `pnpm --filter @paperclipai/ui typecheck && pnpm --filter @paperclipai/ui build && cd ui && npx vitest run`
- [ ] **Step 5: Commit** `chore(ui): remove UX lab and preview entry points`

---

### Task 6: Remove the Board Chat relay

**Files:**
- Delete: `server/src/routes/board-chat.ts`, `server/src/__tests__/board-chat-route-feature-flag.test.ts`, `ui/src/pages/BoardChat.tsx`, `ui/src/pages/BoardChat.test.tsx`, `ui/src/components/ConferenceRoomChatGate.tsx`, `ui/src/components/ConferenceRoomChatGate.test.tsx`, `ui/src/hooks/useConferenceRoomChatEnabled.ts`.
- Modify: `server/src/app.ts` (remove mount and import), `server/src/routes/openapi.ts` and `server/src/__tests__/openapi-routes.test.ts` (remove `/board/chat*` operations), `ui/src/App.tsx` (remove `board-chat` route), `ui/src/components/Sidebar.tsx` and `Sidebar.test.tsx` (remove Conference Room item), `ui/src/lib/company-routes.ts` (remove `"board-chat"` root), `ui/src/index.css` (remove board-chat-only selectors), `ui/src/components/AgentBubbleActionRow.tsx`, `ChatComposer.tsx`, `IssueChatThread.tsx`, `OnboardingWizardVariant.tsx`, `ui/src/pages/Agents.test.tsx` (remove Board-Chat-only props/branches).
- Modify: `packages/shared/src/validators/instance.ts`, `feature-catalog.ts`, `types/instance.ts`, `server/src/services/instance-settings.ts`, `ui/src/pages/InstanceExperimentalSettings.tsx` (+ tests): retire `enableConferenceRoomChat` exactly as Task 4 retired `enableStreamlinedUi`.
- Keep: `skills/paperclip-board/SKILL.md` (Phase 3 rewrites it for the Assistant).

**Interfaces:**
- Produces: `POST /api/board/chat/stream` returns 404 (`API route not found`).

- [ ] **Step 1: Write failing server test** `server/src/__tests__/board-chat-removed.test.ts` using the same app-construction helper as the deleted `board-chat-route-feature-flag.test.ts` (copy its setup before deleting it):

```ts
it("no longer serves the board chat relay", async () => {
  const res = await request(app).post("/api/board/chat/stream").send({ message: "hi" });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run, expect FAIL** (route exists). `npx vitest run server/src/__tests__/board-chat-removed.test.ts`
- [ ] **Step 3:** Apply deletions and edits. In each UI component listed, remove only the board-chat/conference-room branches (search for `boardChat`, `conferenceRoom`, `board-concierge`).
- [ ] **Step 4: Verify**

Run: `grep -rni "board-chat\|boardchat\|conferenceroom\|board-concierge" ui/src server/src packages/shared/src | grep -v "Deprecated compatibility"`
Expected: only the deprecated schema key line(s) and the new removal test.

Run: `pnpm --filter @paperclipai/shared typecheck && pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/ui typecheck && npx vitest run server/src/__tests__/board-chat-removed.test.ts server/src/__tests__/openapi-routes.test.ts server/src/__tests__/instance-settings-service.test.ts && cd ui && npx vitest run`

- [ ] **Step 5: Commit** `chore: remove the Board Chat relay`

---

### Task 7: Phase verification

- [ ] **Step 1:** `pnpm typecheck` (all workspaces). Expected: clean.
- [ ] **Step 2:** `cd ui && npx vitest run` and `npx vitest run --project server` from the root (if the `--project` filter errors, run `cd server && npx vitest run`). Compare failures with the baseline; any new failure must be fixed in the task that caused it.
- [ ] **Step 3:** `pnpm --filter @paperclipai/ui build`. Expected: success.
- [ ] **Step 4:** Dev server smoke: `/` → company dashboard; `/dashboard` → `/<PREFIX>/dashboard`; sidebar renders; `/<PREFIX>/board-chat` shows the normal not-found page.
- [ ] **Step 5:** Record results in this plan's checklist and commit any fixes.

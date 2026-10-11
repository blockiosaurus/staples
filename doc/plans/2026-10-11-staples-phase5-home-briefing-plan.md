# Staples Phase 5: Home Briefing and In-Page Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a company has agents, the person lands on **Home**: a briefing of what needs them (each item with the source's recommended answer, an inline "Accept recommendation" where safe, and "Ask Assistant"), what is in progress, and what finished recently, with an Assistant composer at the bottom. Task and agent detail pages start simple and reveal advanced sections only when they have content or the person asks.

**Architecture:** A new read endpoint `GET /api/companies/:companyId/briefing` composes the existing attention service (needs-you), the issues service and the live-runs query (in progress), and recently completed issues (done). Recommendations come from pending `ask_user_questions` payloads (options with `recommended: true` / `initialText`) and `request_confirmation` accept labels; nothing calls a model. Inline resolution reuses the existing interaction respond/accept routes. The UI adds `/home` (core surface `nav.home`, company index redirects there; Dashboard becomes a `grows` surface) and an `askAssistant` API on the Assistant provider used by Home and briefing rows. The Assistant gains a read tool `staples_get_briefing`.

**Tech Stack:** Express + Drizzle, Zod (`@paperclipai/shared`), React 19 + TanStack Query v5, Tailwind v4 tokens, Vitest.

Spec: `doc/plans/2026-10-10-staples-adaptive-ux-design.md` (Stage 1, §6 Home briefing, Recommended answers everywhere). Research: `.superpowers/sdd/phase5-research.md` (file:line references for everything below). Phase 4 ledger: `.superpowers/sdd/2026-10-10-staples-phase4-interview-plan/progress.md`.

## Global Constraints

- Hard fork; generic product, no company-specific content.
- Company-scoped: every query filters by `companyId`; the briefing route requires a board user (same guard as `GET /companies/:id/attention`), viewers may read it; agents get 403.
- No model calls to build the briefing. Recommendations are derived only from data already stored on the source item.
- Inline "Accept recommendation" only for `ask_user_questions` where **every** question has a recommendation (single/multi: recommended option ids; text: `initialText`), and for `request_confirmation` without a server-owned `toolAction`/`secretProposal`/`proposedAction` (those keep their own card flow → the row shows "Open"). Approvals, blocked tasks and budget incidents are never resolved inline; they show "Open" + "Ask Assistant".
- Phase 3 security model unchanged: "Ask Assistant" only pre-fills/sends a normal person-authored message with page context; no new Assistant authority except the read tool.
- Token-only UI rule (`DESIGN.md`); run `pnpm check:token-gates` after UI changes.
- Keep contracts in sync: shared types/validators, server route + OpenAPI (`server/src/routes/openapi.ts`, `openapi-routes.test.ts` must pass), UI client.
- Do not change the line counts of `skills/paperclip/SKILL.md` or `skills/paperclip/references/api-reference.md`.
- Bump the Assistant bundle `stockVersion` when its AGENTS.md/skills change (Phase 4 final fixes leave it at "2026-10-11g"; this phase uses "2026-10-11h").
- Commands: single files only, `timeout 600 npx vitest run <file>` from the package dir (server embedded-PG tests add `--no-file-parallelism`); typecheck `pnpm --filter @paperclipai/<pkg> typecheck`. Never run whole suites inside a task.
- Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths.

---

### Task 1: Briefing API

**Files:** `packages/shared/src/types/briefing.ts` (new) + export from `packages/shared/src/index.ts`; `server/src/services/briefing.ts` (new); `server/src/routes/briefing.ts` (new) registered beside `attentionRoutes` in `server/src/app.ts`; `server/src/routes/openapi.ts`; `server/src/__tests__/briefing-service.test.ts` (embedded PG, pattern `attention-service.test.ts`).

**Interfaces (produces):**
```ts
export type BriefingSection = "needsYou" | "inProgress" | "doneRecently";
export type BriefingItemKind =
  | "approval" | "question" | "confirmation" | "blocked_task" | "budget_incident"
  | "review" | "failed_run" | "agent_error" | "active_task" | "live_run" | "done_task";
export interface BriefingRecommendation {
  label: string;                               // e.g. "Developers" or "Accept 3 recommendations"
  inline: boolean;                             // true → Home may resolve it in one click
  answers?: { questionId: string; optionIds?: string[]; text?: string }[]; // ask_user_questions
  accept?: true;                               // request_confirmation accept
}
export interface BriefingItem {
  kind: BriefingItemKind;
  id: string;                                  // source id (interaction/approval/issue/run id)
  title: string;
  subtitle?: string | null;                    // e.g. "TES-12 · Riley"
  href: string;                                // company-relative, e.g. "/issues/TES-12"
  issueId?: string | null;                     // needed to resolve interactions
  recommendation?: BriefingRecommendation;
  createdAt: string;
}
export interface Briefing {
  needsYou: BriefingItem[];     // cap 20, newest first
  inProgress: BriefingItem[];   // cap 20: live runs first, then in_progress tasks
  doneRecently: BriefingItem[]; // status done, completedAt within 7 days, cap 10
  counts: { needsYou: number; inProgress: number; doneRecently: number }; // uncapped totals
  generatedAt: string;
}
```
Service: `briefingService(db).get({ companyId, userId, actor }): Promise<Briefing>`.

- [ ] needsYou: call `attentionService(db).list({ companyId, userId, actor, all: true, allowUnscopedAll: true })` (see research §1). Map kinds: approval → `approval`; issue_thread_interaction → `question` (ask_user_questions) or `confirmation` (request_confirmation) — other interaction kinds map to `confirmation` without recommendation; blocker_attention → `blocked_task`; budget_alert → `budget_incident`; review → `review`; failed_run → `failed_run`; agent_error_alert → `agent_error`; drop kinds not listed. For interactions, load the interaction rows (one query by ids, company-filtered) and derive the recommendation:
  - ask_user_questions (question-set or legacy payload, via the shared projection): for each question, single_select → the one recommended option; multi_select → all recommended options; text → `initialText`. If every question has one → `inline: true`, `answers` filled; label = the option label when there is exactly one question, else `Accept N recommendations`. If some lack one → `inline: false`, label from the first that has one (or no recommendation at all).
  - request_confirmation: if payload has `toolAction`, `secretProposal` or `proposedAction` → no inline (`inline: false`, label = accept label or "Review"); else `{ label: acceptLabel ?? "Confirm", inline: true, accept: true }`.
- [ ] inProgress: live runs (reuse the query from `server/src/routes/agents.ts` live-runs route; extract it to a small exported function in a service file so both use it) → `live_run` items titled by the run's issue title (or agent name), href to the issue (or agent); then issues with status `in_progress` not already represented by a live run → `active_task`.
- [ ] doneRecently: issues `status: "done"`, `completedAt >= now - 7d` (use `updatedSince` filter then filter on `completedAt`), newest first → `done_task`.
- [ ] Route `GET /api/companies/:companyId/briefing`: same auth guard as the attention route (board user; `assertCompanyAccess`); 403 for agent actors. OpenAPI entry with response schema.
- [ ] Tests: each mapping; recommendation derivation (single, multi, text, mixed missing → not inline, confirmation with proposedAction → not inline); company isolation (other company's items absent); agent actor 403; caps and counts; done older than 7 days excluded.
- [ ] Commit.

---

### Task 2: Ask Assistant from anywhere

**Files:** the Assistant provider/context in `ui/src/staples/assistant/` (where the Cmd+J dock state lives), `AssistantDock`, `AssistantConversation.tsx`, `ui/src/components/task-chat/TaskChatThread.tsx` / `TaskChatComposer.tsx` (existing `draftRequest {text, nonce}`), `ui/src/pages/IssueDetail.tsx` (`TaskDetailConversation` threading, research §7), tests.

**Interfaces (produces):**
```ts
// from the Assistant context hook (name the hook after the existing one, e.g. useAssistant())
askAssistant(input: { text: string; send?: boolean; context?: { label: string; href: string } }): void;
```
- [ ] `askAssistant` opens the dock (or, on the Assistant page, uses the page conversation) and passes a pending draft `{ text, nonce }` through to the composer via the existing `draftRequest` path. With `send: true` it submits through the normal person comment path (same as pressing Send, including page context). `context` is appended to the message as a plain line `About: <label> (<href>)`, never as markup.
- [ ] The pending draft is consumed once (nonce) and cleared on company switch.
- [ ] Tests: prefill shows text in composer and focuses it; `send: true` calls the add-comment API once with the text; company switch clears a pending draft.
- [ ] Commit.

---

### Task 3: Home page and navigation

**Files:** `ui/src/staples/home/HomePage.tsx` (new) + `BriefingRow.tsx`; `ui/src/api/briefing.ts` (new) + `queryKeys.briefing(companyId)`; `ui/src/App.tsx` (route `home`, company index → `home`); `packages/shared/src/reserved-route-segments.ts` (add `home`); `ui/src/staples/surfaces/registry.ts` (`nav.home`; Dashboard tier change); tests next to the page.

- [ ] Surface `nav.home`: label "Home", icon `House`, group `top`, tier `core`, first in the top group. `nav.dashboard`: tier `grows`, revealWhen `agents >= 3` (reason "Dashboard appeared because your company has several agents."). Sticky reveal keeps it for people who already visited it. The company index route and the stage-0 → stage-1 switch land on `/home`; unprefixed `/home` redirects like other board roots.
- [ ] HomePage layout (max-width reading column, tokens only):
  1. Header: company name + one-line summary from counts ("2 things need you · 3 in progress").
  2. **Needs you**: `BriefingRow` per item: kind icon, title, subtitle, relative time, recommendation chip ("Recommended: Developers"). Actions: **Accept recommendation** (only when `recommendation.inline`), **Open** (link to href), **Ask Assistant** (`askAssistant({ text: "Help me decide: <title>", context: { label: title, href } })`). Empty state: "Nothing needs you right now."
  3. **In progress**: compact rows (live runs show a pulsing dot). Empty: "Nothing running."
  4. **Done recently**: compact rows. Hidden when empty.
  5. **Ask the Assistant** composer (single-line textarea + Send) → `askAssistant({ text, send: true })`.
- [ ] Accept recommendation: questions → `POST /issues/:issueId/interactions/:id/respond` with `{ answers }` (existing client); confirmations → existing accept client. Optimistically remove the row, invalidate `briefing`, attention and the issue's interactions queries; on error restore the row and show the error inline (do not swallow).
- [ ] Polling: `refetchInterval: 30_000` plus invalidation on live-update events already used for attention (reuse the same invalidation hook if one exists).
- [ ] Tests (pattern `CompanyBriefPage.test.tsx`): renders three sections from a fixture; Accept recommendation posts the right answers and removes the row; error restores the row with a message; Ask Assistant calls `askAssistant` with the item; empty states; registry test: `nav.home` core, dashboard hidden below 3 agents and shown at 3.
- [ ] Commit.

---

### Task 4: Task detail progressive disclosure

**Files:** `ui/src/components/issue-properties/IssueProperties.tsx` (sections Relationships ~2439, Execution ~2618, Workspace ~2739, About ~2908), tests.

- [ ] Always shown: Work (status, assignee, project, labels). Relationships, Execution and Workspace render only when they have a non-default value (any parent/blocked-by/blocking/subtask; any reviewer/approver/monitor/watchdog; any workspace config) — otherwise they collapse into one row **"More fields"** (chevron) that expands all hidden sections in place. About stays visible but compact.
- [ ] Expanded state persists per person per company in `localStorage` key `staples:issue-props-expanded:<companyId>` (wrap in try/catch; default collapsed).
- [ ] Setting a value inside an expanded section keeps it visible afterwards (it now has content).
- [ ] Tests: empty task shows Work + About + "More fields"; a task with a blocker shows Relationships without expanding; expanding reveals all and persists; localStorage throwing doesn't break render.
- [ ] Commit.

---

### Task 5: Agent detail progressive disclosure

**Files:** `ui/src/pages/agent-detail-navigation.ts`, `ui/src/components/AgentContextualSidebar.tsx`, `ui/src/pages/AgentDetail.tsx` (view switch ~1397-1500), tests.

- [ ] The sidebar shows the **Agent** group (overview, instructions, skills) always. **Runtime**, **Governance** and **Audit** groups collapse under one **Advanced** disclosure that is closed by default and opens automatically when the active view is inside it (deep links keep working) or when the person opened it before (`localStorage` `staples:agent-advanced-open`, try/catch).
- [ ] Within Advanced, hide **Channels** and **API keys** items when the agent has none, unless that view is active.
- [ ] Tests: default shows Agent group + collapsed Advanced; navigating to `/agents/:id/permissions` opens Advanced; empty channels hidden; existing agent-detail navigation tests updated.
- [ ] Commit.

---

### Task 6: Assistant uses the briefing

**Files:** `server/src/services/assistant-tools.ts` (tool list + handler), `server/src/built-ins/agents/assistant/AGENTS.md`, `server/src/services/built-in-agents.ts` (stockVersion → "2026-10-11h"), tests in `server/src/__tests__/assistant-tools.test.ts`.

- [ ] Read tool `staples_get_briefing` (no args) returns the person's briefing from `briefingService` with the run's acting person as `userId` (same identity resolution as the other Assistant read tools); company-scoped.
- [ ] AGENTS.md: when asked "what needs me / what's going on", call `staples_get_briefing` and answer in at most 5 lines, linking items; when the person arrives via "Ask Assistant" with an `About:` line, read that item first and give a recommendation with its reason before offering to act.
- [ ] Tests: tool returns items for the acting person only; listed in tools/list; AGENTS.md mentions the tool (existing instruction/tool consistency test).
- [ ] Commit.

---

### Task 7: Phase verification

- [ ] `pnpm typecheck`; UI suite `cd ui && timeout 1800 npx vitest run --testTimeout=60000`; `pnpm --filter @paperclipai/ui build`; server tests touched this phase (single files); `pnpm check:token-gates`.
- [ ] Browser walkthrough on the dev server with screenshots saved to `tmp/screenshots/phase5/` (Home with items in all three sections, Accept recommendation, Ask Assistant opening the dock with the draft, task detail collapsed/expanded, agent detail Advanced closed/open) and sent to the person.
- [ ] Record results in the ledger.

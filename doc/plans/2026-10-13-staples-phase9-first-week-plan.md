# Staples Phase 9: First Week — See It Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a person confirms the Assistant's plan, the first week is legible and trustworthy. The plan card reads like a summary for a person, budgets fit under the hosted cap, Home tells the truth about what is happening and how to fix problems, copy is written for people rather than agents, and the person can see what the agents made and get a weekly update without checking.

**Architecture:** Mostly UI and briefing work on existing data.
- (1) The proposed-action card renders once and hides the raw API request behind a disclosure.
- (2) The plan pins a monthly budget total. Applying it raises the hosted company cap to cover the hires, raise-only and up to an operator ceiling. Home shows spend against budget.
- (3) The briefing gains queued and blocked work, plus plain reasons and fix actions on Needs you items, reusing existing mutations.
- (4) Agent-only instructions move out of person-visible task descriptions, and the connection and agent-detail copy is rewritten.
- (5) Home gets a "What we've made" section built on the artifacts projection.
- (6) The Assistant gains a weekly routine that writes a digest document, surfaced on Home.

**Tech Stack:** TypeScript, React 19 + TanStack Query, Express + Drizzle, Zod in @paperclipai/shared, Vitest.

Research (file:line for every touchpoint): `.superpowers/sdd/2026-10-13-staples-phase9-first-week-plan/research.md`.

## Global Constraints

- Generic product; no company-specific content.
- Token-only UI (DESIGN.md); run `pnpm check:token-gates` after UI changes. Form/wizard footer rule: Cancel/secondary left, primary right, same row.
- Keep contracts synced across db/shared/server/ui (AGENTS.md §5.2); company-scope everything; activity-log mutations.
- Person-facing copy: plain language, no internal terms. Banned in default views: adapter, harness, runtime, session, heartbeat, MCP, identity, lifecycle, API path/JSON. Advanced views keep technical detail behind a disclosure.
- Never weaken governance: plan application stays person-confirmed; budget changes from plans only raise, never lower; hosted cap raises are bounded by an operator ceiling.
- Bump the Assistant `stockVersion` in `server/src/services/built-in-agents.ts` (currently "2026-10-12b") when its AGENTS.md, skills or bundled routine change.
- Subagent watchdog: no single command longer than 4 minutes (`timeout 240`); single test files; `-t` while iterating. Never read `.env.local` or any key. Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths; never `git add -f` under `.superpowers/`; never commit `.claude/launch.json`.

---

### Task 1: The plan card, once and for people

**Files:** `ui/src/components/TaskChatInteractionCard.tsx`, `ui/src/components/IssueThreadInteractionCard.tsx` (ProposedActionCard, ProposedPlanPreview), `ui/src/components/TaskChatThread.tsx`, tests (`ProposedActionCard.test.tsx`, `TaskChatThread.test.tsx`).

- [ ] Render the full proposed-action card once: in the composer takeover while pending. The timeline shows a compact stub while pending ("Plan waiting for your confirmation"), and the outcome line after it is resolved (mirror the toolAction branch). Tests: one "Create plan" button in the DOM for one pending proposal; the stub is in the timeline; the resolved state shows in the timeline.
- [ ] The REQUEST method/path/JSON block moves behind a collapsed "Technical details" disclosure (closed by default) for every proposed action.
- [ ] Agent rows read like a person wrote them:
  - name, the template's display name or title, and a plain role label (reuse `roleLabels`);
  - "Claude (hosted)" or the display name from `getAdapterDisplay` instead of the raw adapter type;
  - needs `<apps>`, asks before `<actions>`, the routine count, and the monthly budget.
  - Never show raw role keys (e.g. "general", "engineer") or raw adapter keys.
- [ ] Tests updated or added; token gates.

### Task 2: Budgets that fit, and spend on Home

**Files:** `packages/shared/src/validators/plan.ts`, `packages/shared/src/types/issue.ts` (+ validators/issue.ts), `server/src/services/{plans.ts,assistant-tools.ts,hosted-inference-access.ts,briefing.ts}`, `packages/shared/src/types/briefing.ts`, `ui/src/components/IssueThreadInteractionCard.tsx` (ProposedPlanPreview), `ui/src/staples/home/*`, tests.

- [ ] Server-computed `planBudget` on the proposal, pinned like `planTemplateSummaries`:
  - `{ hiresMonthlyCents, hostedCapCents|null, hostedCapAfterCents|null, ceilingCents }`.
  - The plan card shows "Monthly budgets: $X across N agents" and, when hosted, either "fits your $Y hosted limit" or "raises your hosted limit from $Y to $X".
- [ ] On apply, when hires use the hosted key, raise the company `hosted_billed_cents` policy to at least the sum of the hosted hires' monthly budgets plus the existing hosted agents' budgets. Raise only, capped at the operator ceiling `STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS` (default 20000 = $200).
  - If the total exceeds the ceiling, raise to the ceiling, and say so on the card and in the apply result.
  - Activity log with the system actor, like the other hosted policies.
  - Doc: `doc/adapters/claude-managed.md` caps section.
- [ ] Briefing gains a `spend` block: this month's spend, the company budget if any, and the hosted cap with its usage if any, reusing `budgets.overview` and dashboard data. Home shows one compact line or meter: "$12 of $90 this month". With no budgets it shows "$12 this month · no limit set" and links to Costs.
- [ ] Tests: total vs cap math; raise-only; ceiling; the card copy; the briefing spend block; Home rendering.

### Task 3: Home tells the truth, with fixes

**Files:** `server/src/services/briefing.ts`, `packages/shared/src/types/briefing.ts`, `ui/src/staples/home/{HomePage.tsx,BriefingRow.tsx,…}`, `ui/src/api/*`, tests.

- [ ] In progress includes live runs, plus assigned `todo` tasks (label "Up next") and `blocked` tasks that are not already in Needs you (label "Waiting on …" with the blocker title), deduped. The empty state reads "Nothing in progress" only when all three are empty, and the header counts match.
- [ ] Find and fix the stale Home mismatch (Home said "Nothing in progress" while the briefing API returned 3 live runs). At minimum, invalidate the briefing query on plan apply, run start/finish and interaction resolution websocket events. Add a test for the invalidation.
- [ ] Needs you items carry `reason` (plain sentence, ≤140 chars, from attention metadata) and an optional `action` `{ kind, label }`. The kinds:
  - `retry_run`: "Try again"
  - `resume_agent`: "Resume"
  - `clear_agent_error`: "Dismiss error"
  - `raise_budget`: "Raise limit", which opens a small inline amount form defaulting to 2× the limit and calls `resolveIncident` with `raise_budget_and_resume`
  - `open_settings`: link
  The UI runs the existing mutations and shows errors inline. Unknown or failed errors fall back to "Ask Assistant".
- [ ] Map common failure codes to plain reasons: out of credit, budget reached, the service is not connected, the agent paused, timed out, and a generic fallback.
- [ ] Tests: server item building, per kind, with reasons; UI actions call the right APIs; empty-state correctness.

### Task 4: Words for people

**Files:** `server/src/services/plan-templates.ts` (connect task specs), `skills/paperclip/SKILL.md` and/or the templated agents' AGENTS.md (where the connect instruction moves), `ui/src/components/ConnectionIntentInteractionBody.tsx`, `ui/src/components/ConnectionSetupFlow.tsx`, `ui/src/pages/AgentDetail.tsx`, `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/agent-config-primitives.tsx`, tests (`AppsConnect.test.tsx`, `AiProviderSetup.test.tsx`, plan-templates tests, agent detail tests).

- [ ] Connect tasks: the description is person-facing only. For example: "Newsletter editor needs one of beehiiv, Resend or Klaviyo to hold your subscriber list and send each issue. It will ask you to connect one here." The instruction to call `connection_request`, and to mark the task done when connected, moves to agent-visible guidance: the paperclip skill's connection section plus a generic line in templated agents' instructions keyed on tasks titled or marked as connect tasks. Prefer marking with an existing issue field (e.g. origin kind or label) so agents can recognise them. Existing connect tasks keep working.
- [ ] Connection card copy:
  - "Connect your identity or reuse an eligible connection" becomes "Sign in to <Service> so <Agent> can use it. Only <Agent> gets access."
  - "Secure MCP sign-in" becomes "Secure sign-in".
  - "Connects as you…" is rewritten plainly.
  - Update the asserting tests.
- [ ] Agent detail default view: rename or hide jargon.
  - "Harness / Runtime" becomes "Runs on"; Adapter becomes "Runs on"; Session becomes "Conversation".
  - Raw status becomes a plain status.
  - "Heartbeat on interval" / "Run heartbeat every" becomes "Check in automatically" / "Check in every".
  - "Run Policy" becomes "When it runs".
  - Keep "Bootstrap prompt (legacy)" and "Extra args" only inside Advanced.
  - Hint text in agent-config-primitives is rewritten plainly.
  - Tests updated.
- [ ] Grep the default (non-Advanced) Home, Assistant, Tasks and Agents views for banned terms (Global Constraints) and fix what is found. List remaining Advanced-only occurrences in the report.

### Task 5: What we've made

**Files:** `ui/src/staples/home/HomePage.tsx` (+ new `MadeRecently` component), `ui/src/components/ArtifactCard.tsx` (reuse), `ui/src/api/artifacts*`, server `company-artifacts.ts` / `companies.ts` (optional `since`), tests.

- [ ] Home section "What we've made" after Done recently.
  - Shows the latest 6 artifacts as cards with previews (reuse `ArtifactCard` / `ArtifactPreview`) and a "See all" link to Artifacts.
  - Hidden when there are none.
  - Previews must not run untrusted scripts; reuse the existing safe preview.
- [ ] The Artifacts nav item stays adaptive. Rename its label to "What we've made" if the registry allows a label per surface; otherwise leave it.
- [ ] Tests: renders previews; hidden when empty; link targets.

### Task 6: A weekly update from the Assistant

**Files:** `server/src/services/built-in-agents.ts` (Assistant bundle routine + stockVersion), `server/src/built-ins/agents/assistant/AGENTS.md` and a new bundled skill `staples-weekly-update` (or a section in an existing Assistant skill), `server/src/services/briefing.ts` + `packages/shared/src/types/briefing.ts` (latest update), `ui/src/staples/home/*`, tests.

- [ ] The Assistant bundle ships a routine, "Weekly update": cron Mondays 09:00 in the company's or person's time zone, using the same zone logic as template routines. It is created for new and existing Assistants on stock upgrade, never duplicated, and does nothing when the company has no other agents.
- [ ] The routine's task asks the Assistant to write a short update and save it as an issue document titled "Weekly update — <date>" on a single recurring "Weekly updates" task, created if missing. The update reads the briefing and spend data with its read-only tools and covers: what shipped (done tasks and artifacts), what's blocked and what it needs from you, spend against budget, and next week. It is read-only, apart from writing its own update document through a governed path.
  - Check how the read-only Assistant writes a document today. If it cannot, add a narrow server-side capability for the routine's run to upsert a document on its own "Weekly updates" issue only (scoped and tested), rather than widening the Assistant's tools.
- [ ] Home shows the latest weekly update as a card at the top: the date, the first few lines, and "Read". It hides after 7 days or when dismissed (per-user preference; reuse the existing dismissal pattern if there is one).
- [ ] An "Update me now" action from Home asks the Assistant (existing ask path) to write one immediately, for testing and impatient people.
- [ ] Tests: routine created once with the correct cron and zone; the scoped document write is allowed only on its own issue; the briefing returns the latest update; the Home card renders and dismisses; the stockVersion is bumped.

### Task 7: Live verification

- [ ] Controller: on the hosted dev server, with the Trailhead Snacks company (or a fresh company):
  - the plan card renders once with no JSON and shows the budget line;
  - the hosted cap is raised on apply;
  - Home shows spend, In progress with queued work, Needs you with reasons and actions;
  - the connect task copy is plain;
  - "What we've made" shows after an agent produces a document;
  - "Update me now" produces a weekly update shown on Home.
  - Screenshots to `tmp/screenshots/phase9/`.
- [ ] Typecheck, touched tests, UI build, token gates; whole-phase review; ledger; push.

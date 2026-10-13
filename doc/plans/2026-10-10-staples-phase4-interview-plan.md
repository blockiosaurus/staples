# Staples Phase 4: The Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new company starts as a full-screen conversation with the Assistant asking "What do you want to build?". The Assistant interviews the person with question cards (every question has a pre-selected recommended answer and an "Accept all recommendations" button), writes a Company Brief, and proposes a plan (goal, agents, starter tasks with dependencies) that one Confirm creates. The onboarding wizard is removed.

**Architecture:** Builds on Phase 3. The Assistant gains `staples_ask_questions` (question-set interactions on its conversation), `staples_get_company_brief` (read; brief edits are governed proposals) and `staples_propose_plan` (a governed proposed action targeting a new composite `POST /api/companies/:id/plans/apply` endpoint executed by the person's browser). The Company Brief is a company-scoped document injected into every agent's wake context. Pocock-derived skills ship in root `skills/` (auto-imported) and are attached to the Assistant. Stage 0 is a UI mode: a company with no staff agents shows only the Assistant, full screen; model connection happens inline in that conversation.

**Tech Stack:** Express + Drizzle, Zod (`@paperclipai/shared`), React 19 + TanStack Query, Vitest.

Spec: `doc/plans/2026-10-10-staples-adaptive-ux-design.md` (Stage 0, The interview, Recommended answers everywhere). Research: `.superpowers/sdd/2026-10-10-staples-phase4-interview-plan/research.md`. Phase 3 ledger (parked items): `.superpowers/sdd/2026-10-10-staples-phase3-assistant-plan/progress.md`.

## Global Constraints

- Hard fork: upstream merge compatibility is not a goal. Generic product: no company-specific content.
- Phase 3 security model is unchanged: the acting person comes from the run row; governed effects only via proposed actions (server-validated allowlist → claim → browser executes → accept); Assistant can't write into conversation issues; page context is untrusted.
- Every question an agent asks must carry a recommendation: `single_select` exactly one option `recommended: true`; `multi_select` with options at least one; `text` questions may set `initialText`. Enforced on create for new interactions only.
- Do not change the line counts of `skills/paperclip/SKILL.md` or `skills/paperclip/references/api-reference.md` (runner capability inventory is keyed to them).
- Bump the Assistant bundle `stockVersion` whenever its AGENTS.md or bundled skills change.
- Third-party skills adapted from `mattpocock/skills` carry an MIT attribution line in each skill file and a NOTICE entry (`skills/THIRD_PARTY_NOTICES.md`).
- Commands: `npx vitest run <paths>` (server embedded-PG tests: `--no-file-parallelism`); typechecks `pnpm --filter @paperclipai/<shared|adapter-utils|db|server|ui> typecheck`; full UI suite `cd ui && npx vitest run --testTimeout=60000`. Known host-only failure: heartbeat-process-recovery Sentry redaction test when `EDITOR=vi` (fixed in Task 1).
- Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths; confirm with `git log --oneline -1`.

---

### Task 1: Carry-over cleanup from Phase 3

**Files:** `server/src/services/built-in-agents.ts` (`reinheritAssistantAdapter` ~2266-2296, `defaultProvisionInput`), `server/src/services/heartbeat/run-failure-diagnostics.ts` (or wherever `PUBLIC_ENV_KEYS` lives), `packages/shared/src/reserved-route-segments.ts`, `server/src/built-ins/agents/assistant/AGENTS.md`, `ui/src/components/AgentMultiSelect.tsx` (+ consumers), tests.

- Re-inheritance: skip (no write) when the model lookup times out or fails; perform the never-ran check and the config write inside one transaction with `SELECT … FOR UPDATE` on the Assistant row; keep it best-effort and never block the hire.
- Redaction: add `EDITOR`, `VISUAL`, `PAGER`, `SHELL`, `TERM`, `LANG`, `LC_*`, `HOME`, `USER`, `LOGNAME`, `PWD`, `TMPDIR` to the public env keys AND ignore inherited env values shorter than 8 characters; the Sentry redaction test passes with `EDITOR=vi`.
- Reserved route segments: add `runs`, `budgets`, `status-cards` (real company routes) to the board roots; registry reserved-roots test still passes.
- AGENTS.md: re-join the low-risk tools list (move the "never post in chats" paragraph after the list).
- `AgentMultiSelect`: restore the Assistant for non-assignee consumers (connections, email access, inbox policy, skills, profile wizard, app permissions) — exclude it only where the select assigns work.
- Tests for each.

---

### Task 2: Recommended answers everywhere

**Files:** `packages/shared/src/validators/issue.ts` (paperclipQuestionSchema / question-set validation), `packages/shared/src/question-set.ts` (projection keeps `recommended`), legacy `askUserQuestionsQuestionSchema` (add optional `recommended` on options so the projection can carry it), `server/src/onboarding-assets/first-task/opening-question.json` (mark a recommended option), `ui/src/components/task-chat/QuestionForm.tsx`, `ui/src/components/IssueThreadInteractionCard.tsx` (legacy layout), tests.

- Validation on create (route + service + native runner `request_human_input` path): a question set where a `single_select` question doesn't have exactly one recommended option, or a `multi_select` question with options has none, is rejected with a message telling the agent to mark its recommendation. Legacy `questions`-only payloads: same rule if they carry options (`selectionMode` single/multi). Existing stored interactions are unaffected.
- Projection keeps `recommended` in both directions.
- QuestionForm: recommended options are pre-selected when the form initializes (unless a saved draft exists); text questions prefill `initialText` (already); add a primary **Accept all recommendations** button that submits immediately with every question answered by its recommendation (text: initialText; questions without a recommendation must already be answered or the button is disabled with a tooltip). Same in the legacy layout.
- Tests: validator cases; projection round-trip; pre-selection; accept-all submits the right answers; draft wins over pre-selection.

---

### Task 3: Company Brief

**Files:** `packages/db/src/schema/company_documents.ts` (new join table, template `routine_documents.ts`) + generated migration, `server/src/services/company-brief.ts`, `server/src/routes/company-brief.ts` (+ OpenAPI + openapi-routes map), `server/src/services/heartbeat/run-preparation.ts` (wake payload), `packages/adapter-utils/src/server-utils.ts` (prompt rendering), `packages/shared` (types/validators), UI page `ui/src/staples/brief/CompanyBriefPage.tsx` (+ route `company/brief`, registry surface `nav.brief`), tests.

- Storage: `company_documents(company_id, key, document_id, created_at, updated_at)` unique (company_id, key); the brief is key `brief`, a normal `documents` row with revisions.
- API: `GET /api/companies/:id/brief` → `{ body: string, revisionId, updatedAt } | null`; `PUT /api/companies/:id/brief` `{ body, baseRevisionId? }` (board members except viewers; 409 on revision conflict); activity logged `company.brief_updated`.
- Assistant brief edits are governed (controller decision after review): proposed action category `brief` targeting `PUT /api/companies/:id/brief`; read tool `staples_get_company_brief`.
- Injection: every agent's wake payload carries `companyBrief` (first 4,000 chars + "(truncated — read the full brief at /company/brief)") rendered as a "Company brief:" block in the prompt, only when a brief exists. Bracket/line safety like page context isn't needed (it's company-authored), but cap length.
- UI: `/company/brief` page with the existing markdown document editor (find the component issue documents use), revision history if trivially reusable; registry surface `nav.brief` (label "Company brief", icon `BookOpen`, group `org`, tier `grows`, revealWhen: a brief exists — add `hasBrief: boolean` to `CompanySignals`), and a "Company brief" link in the Assistant page header.
- Tests: route CRUD + conflict + viewer 403; tool; wake payload + prompt rendering; UI page; signal.

---

### Task 4: Assistant question tool

**Files:** `server/src/services/assistant-tools.ts`, tests, `server/src/built-ins/agents/assistant/AGENTS.md` (replace "no question tool"), stockVersion bump.

- `staples_ask_questions({ title?, questions: PaperclipQuestion[] (1..8) })` — write-tier (viewers excluded); creates an `ask_user_questions` interaction with a `questionSet` (schema `paperclip.question_set.v1`) on the run's Assistant conversation issue, `addresseeUserId` = the person, `continuationPolicy: "wake_assignee"`, idempotency key derived from run id + a hash of the questions; validation from Task 2 applies (tool error lists which question lacks a recommendation).
- The answer flows back via the existing question-response delivery; confirm the Assistant's continuation wake renders the answers (add a test).
- AGENTS.md: ask with `staples_ask_questions` (rounds of the currently answerable questions, numbered, each with a recommendation worded so accepting it is "yes").

---

### Task 5: Pocock-derived skills for the Assistant

**Files:** `skills/staples-interview/SKILL.md`, `skills/staples-company-brief/SKILL.md`, `skills/staples-plan/SKILL.md`, `skills/staples-questionnaire/SKILL.md`, `skills/staples-wayfinder/SKILL.md`, `skills/THIRD_PARTY_NOTICES.md`, `server/src/services/built-in-agents.ts` (attach the five keys to the Assistant's desired skills on ensure/reconcile — follow how bundled keys are written to `adapterConfig.paperclipSkillSync`), tests.

Adapt (don't copy) from `mattpocock/skills` (local copy: `/private/tmp/claude-501/-Users-kelliott-Metaplex-staples/0e6f9dde-474d-462b-8890-e7b3dc16a0da/scratchpad/pocock/skills/`):
- `staples-interview` ← productivity/grilling: decision tree, rounds = frontier, ask via `staples_ask_questions`, every question has a recommendation ("yes" accepts), facts looked up with tools not asked, done only when no open decisions remain and the person confirms shared understanding; then hand off to staples-plan.
- `staples-company-brief` ← engineering/domain-modeling: maintain the Company Brief (mission, glossary of terms, key decisions, constraints); challenge fuzzy terms; keep a working draft of the brief in the conversation as terms resolve and propose it (governed, category `brief`) at natural checkpoints — during the first interview it is proposed together with the plan via `plans/apply`; brief contains no implementation chatter.
- `staples-plan` ← engineering/to-spec + to-tickets: turn the settled interview into goal, agent roles (allowlisted hire fields, non-CEO), and 3–12 starter tasks as tracer-bullet slices with blocking edges; present via `staples_propose_plan`.
- `staples-questionnaire` ← productivity/to-questionnaire: when the person can't answer, draft a questionnaire for someone else as a task document (create a task with the questionnaire as description, assigned to nobody).
- `staples-wayfinder` ← engineering/wayfinder: for big initiatives, a decision map as a parent task with child decision tasks and blockers; resolve one decision at a time with the person.
Each SKILL.md: frontmatter (`name`, `description`), ≤ 150 lines, attribution line "Adapted from <skill> in mattpocock/skills (MIT)". Tests: bundled import picks them up; the Assistant's desired skills include all five after ensure; other agents unaffected.

---

### Task 6: Plan proposals and `plans/apply`

**Files:** `packages/shared/src/validators/plan.ts` (new), `server/src/routes/plans.ts` + `server/src/services/plans.ts` (new; OpenAPI + openapi-routes map), `server/src/services/assistant-proposed-actions.ts` (new category `plan` + pattern + body validation), `server/src/services/assistant-tools.ts` (`staples_propose_plan`), UI `ProposedActionCard` plan preview, tests.

```ts
// shared
export const applyPlanSchema = z.object({
  brief: z.object({ body: z.string().min(1).max(20_000), baseRevisionId: z.string().uuid().nullable() }).optional(),
  goal: z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).optional() }).optional(),
  project: z.object({ name: z.string().min(1).max(120), description: z.string().max(4000).optional() }).optional(),
  agents: z.array(z.object({
    clientKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80), role: z.string(), title: z.string().max(80).optional(),
    capabilities: z.string().max(1000).optional(), adapterType: z.string(),
    budgetMonthlyCents: z.number().int().min(0).max(10_000_000).optional(),
    reportsToClientKey: z.string().optional(),
  }).strict()).max(8).default([]),
  tasks: z.array(z.object({
    clientKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: z.string().min(1).max(200), description: z.string().max(8000).optional(),
    assigneeClientKey: z.string().optional(), assigneeAgentId: z.string().uuid().optional(),
    parentClientKey: z.string().optional(), blockedByClientKeys: z.array(z.string()).max(10).default([]),
  }).strict()).min(1).max(25),
}).strict();
```

- `POST /api/companies/:id/plans/apply` (board session; non-viewer): validates references (client keys exist, no cycles in parent/blocked edges, assignees exist in company and aren't the Assistant), roles non-privileged (reuse Phase 3 role rule), adapterType in the proposable hire set; then in one transaction (or ordered with compensation if hiring can't be transactional — document): write the brief if present (same base-revision rule as PUT /brief; stale → 409 before anything is created), create goal (level `company` if the company has no company-level goal, else `task`), project (linked to goal), hire agents (agent-hire path, honoring `requireBoardApprovalForNewAgents` — if approvals are required, created agents stay pending and tasks are still created assigned to them), create tasks (topological order like suggest_tasks `buildTaskCreationOrder`; goal/project attached; blockers resolved to ids). Response: created ids by clientKey. Activity logged `plan.applied`.
- Governed allowlist: category `plan`, pattern `POST /api/companies/:id/plans/apply`, body validated with `applyPlanSchema` + the same checks (so the claim re-validation covers it).
- Tool `staples_propose_plan(plan, summary)` → creates the proposed action (category `plan`).
- UI: for category `plan`, the card shows a structured preview (Brief (collapsed markdown preview); Goal; Project; Agents: name — role (adapter); Tasks as an ordered list with "after: <titles>" and assignee) above the raw Request, and Confirm reads "Create plan".
- Tests: schema; cycle detection; privileged role refused; apply happy path creates everything with correct links; approval-required company; allowlist + claim; UI preview.

---

### Task 7: Stage 0 and connecting a model

**Files:** `server/src/routes/assistant.ts` (GET /assistant gains `setup`), new `POST /api/companies/:id/assistant/setup` (configures the Assistant's adapter), `ui/src/staples/assistant/{AssistantSetupCard.tsx, StageZeroShell.tsx}`, `ui/src/components/Layout.tsx`, `ui/src/staples/assistant/AssistantPage.tsx`, tests.

- `GET /assistant` returns `setup: { state: "ready" | "starting" | "needs_model" | "error", message?: string, adapterType }`: `needs_model` when the lifecycle failed with an auth/command/engine check (map `harness_test_failed` + last test checks: `*_auth_required`, `*_command_unresolvable`, `adapter_engine_unavailable`), `starting` when preparing/verifying without error, `error` otherwise with the lifecycle error.
- `POST /assistant/setup` `{ adapterType (runtime set), adapterConfig?, aiConnectionId? }` (board, non-viewer): updates the Assistant's adapter config (engine `cli` automatically when ACP prerequisites fail — reuse the env test result), binds the AI connection via `runtimeConfig.aiConnection` if given, retries the lifecycle. Not gated by `enableBuiltInAgents`.
- `AssistantSetupCard` (shown in the Assistant conversation — page and dock — instead of the composer when setup ≠ ready): adapter choice limited to the runtime set the host can run (probe each with test-environment in parallel; show "Installed" / "Not installed"); reuse `AgentProviderConnection` for login/API key; on connected → `POST /assistant/setup` → poll until ready. `starting` shows a spinner; `error` shows the message + Retry.
- Stage 0: when the selected company has zero staff agents (signals.agents === 0), the company layout renders `StageZeroShell`: no sidebar, top bar with company switcher + account menu, full-screen `AssistantConversation`; when the thread is empty, a client-rendered opening bubble from the Assistant: "Hi — I'm your Assistant. What do you want to build?" with 3 example chips that fill the composer ("A marketing team for my product", "Research and write a weekly newsletter", "Triage and fix bugs in my repo"). Once a staff agent exists, normal shell (the Phase 2 stage-1 sidebar).
- Tests: setup state mapping; setup endpoint (adapter change + lifecycle retry + viewer 403); card flows (mock AgentProviderConnection); stage 0 renders without sidebar for 0 agents and normal shell for ≥1; opening bubble + chips.

---

### Task 8: Retire the onboarding wizard

**Files:** everything listed under "Wizard-only (delete)" and "Edit when retiring" in the research notes; new `ui/src/staples/start/StartCompanyPage.tsx` (route `/start`).

- `/start` (and `/onboarding`, `/:prefix/onboarding` → redirect to `/start` or the company's Assistant): one field "Name your company" + Create; on success navigate to `/:prefix/assistant` (stage 0). Respect cloud-managed (no create; redirect to the existing company) and authenticated mode rules that the wizard respected.
- Layout auto-open for zero companies → navigate to `/start`. Dashboard agentless offer → removed (stage 0 covers it). Company menu "New company" → `/start`.
- Delete wizard-only files and their tests; remove DialogContext onboarding state; keep shared pieces used by AgentProviderConnection / NewAgentSetup.
- Server: leave `onboardingFirstAgent`/`onboardingFirstTask` and the cloud seed in place (unused by this UI).
- Tests: start page create flow; redirects; no references to deleted modules (`grep`); full UI suite.

---

### Task 9: Assistant instructions for the interview

**Files:** `server/src/built-ins/agents/assistant/AGENTS.md`, `stockVersion` bump, tests that snapshot instructions.

- When the company has no staff agents (use `staples_company_signals`) or the person asks to start something new: follow `staples-interview`, draft the Company Brief via `staples-company-brief`, finish with `staples-plan` → `staples_propose_plan` (brief + plan in one Confirm); after the plan is created, tell the person what happens next and where to look.
- Otherwise: the Phase 3 behaviour (what's up, questions, help, governed proposals).
- Keep ≤ 250 lines.

---

### Task 10: Phase verification

- [ ] Typechecks; full UI suite; touched server test files serially; UI build.
- [ ] One end-to-end test (stubbed adapter, real routes): company with no staff agents → Assistant run calls `staples_ask_questions` → person accepts all recommendations → continuation → `staples_propose_plan` (with brief) → claim → browser-executed `plans/apply` → accept → goal/agents/tasks exist with blockers → signals.agents ≥ 1 → stage 0 ends.
- [ ] Browser: `/start` → name company → stage 0 full-screen Assistant with the opening bubble; setup card appears (this host can't run models) with installed/not-installed adapters; the Company brief page; a seeded question card shows pre-selected recommendations and "Accept all recommendations"; a seeded plan card shows the structured preview.
- [ ] Ledger update.

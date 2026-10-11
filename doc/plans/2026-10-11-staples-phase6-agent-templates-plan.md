# Staples Phase 6: Agent Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can hire a ready-made agent (Researcher, Content creator, Email secretary, Newsletter, Support triage, Social media manager, Website builder, Bookkeeper, Coding agent) through the Assistant or a marketplace page; it arrives with instructions, skills, routines, service-connection steps and approval-first outward actions with per-category autopilot.

**Architecture:** Templates are single-agent `agentcompanies/v1` packages in `packages/teams-catalog/catalog/optional/staples/<slug>/` with a typed `staples.template.json` sidecar. A server `agentTemplates` service lists, resolves and renders them. The Assistant's governed `plans/apply` gains `agents[].templateRef` + `templateAnswers`: it imports skills, hires through the real hire route with rendered instructions, creates routines and starter tasks (including "Connect <service>" tasks), seeds per-agent approval rules, and records the installed template. Autopilot toggles per-agent `allow` rules scoped to a connection and `write` risk. UI adds a marketplace at `/agents/new`, a plan-card access summary, and an agent Autopilot panel.

**Tech Stack:** Express + Drizzle, Zod (`@paperclipai/shared`), React 19 + TanStack Query v5, Tailwind v4 tokens, Vitest.

Spec: `doc/plans/2026-10-11-staples-phase6-agent-templates-design.md` (read the "Revisions after code research" section — it overrides earlier sections). Verified code locations: `.superpowers/sdd/phase6-research.md` (cite it in every task).

## Global Constraints

- Hard fork; generic product, no company-specific content in templates.
- Templates are installed **only** through `plans/apply` (governed proposal → claim → browser executes → accept). Do not use or change the teams-catalog import route for templates.
- Templates cannot grant more than a normal hire: no extra permissions, no access rule looser than `require_approval` at install. Destructive risk can never be put on autopilot.
- Every setup question carries a recommendation (single_select exactly one `recommended: true`; multi_select ≥1; text questions use `initialText`).
- Setup answers are untrusted person-typed text: substituted as plain text, each answer ≤ 500 chars, never interpreted as instructions to the platform.
- Placeholders: `{{answers.<questionId>}}`, `{{company.name}}`, `{{person.name}}` only; unknown placeholders fail validation.
- Template version is pinned at proposal; apply uses the pinned version.
- Gmail cannot send (blocked platform-wide): Email secretary drafts in Gmail; it sends only through AgentMail.
- Templates whose dependencies aren't end-to-end ready are `"preview": true` and hidden from the marketplace and the Assistant.
- Keep contracts in sync (shared types/validators, server routes + OpenAPI `server/src/routes/openapi.ts` + `openapi-routes.test.ts`, UI clients).
- Token-only UI (`DESIGN.md`); run `pnpm check:token-gates` after UI changes.
- Do not change line counts of `skills/paperclip/SKILL.md` or `skills/paperclip/references/api-reference.md`.
- Bump the Assistant bundle `stockVersion` (currently "2026-10-11i") when its AGENTS.md or bundled skills change; this phase uses "2026-10-12a".
- The teams catalog's `generated/catalog.json` is committed and validated; regenerate it whenever catalog files change, and update `shipped-catalog.test.ts` expectations.
- Commands: single test files only — server `timeout 600 npx vitest run <file> --no-file-parallelism` (from `server/`), UI `cd ui && timeout 600 npx vitest run <file> --testTimeout=60000`, packages `timeout 600 npx vitest run <file>` from the package dir. Typecheck `pnpm --filter @paperclipai/<pkg> typecheck`. Never run whole suites inside a task. Don't start/stop the dev server on port 3100.
- If embedded-Postgres tests fail with libicu errors, run `node scripts/hydrate-symlinks.js` in the `@embedded-postgres` darwin-arm64 package dir under `node_modules/.pnpm`.
- Commit after each task; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths.

---

### Task 1: Template format, loader and validator

**Files:**
- Create: `packages/shared/src/types/agent-template.ts`, `packages/shared/src/validators/agent-template.ts` (export both from the package indexes)
- Modify: `packages/teams-catalog/src/catalog-builder.ts`, `packages/teams-catalog/src/types.ts` (carry the sidecar into catalog entries), `packages/teams-catalog/src/shipped-catalog.test.ts`
- Create: `server/src/services/agent-templates.ts`, `server/src/__tests__/agent-templates.test.ts`
- Create one fixture template for tests only under the test directory (not shipped).

**Interfaces (produces):**
```ts
// packages/shared/src/types/agent-template.ts
export type AgentTemplateCategory = "communication" | "content" | "operations" | "engineering" | "finance" | "research";
export interface AgentTemplateRequiredApp { capability: string; anyOf: string[]; why: string; optional?: boolean }
export interface AgentTemplateOutwardAction { capability: string; label: string; destructiveLabel?: string }
export interface AgentTemplateSidecar {
  version: string;                 // semver
  tagline: string;                 // ≤ 80 chars
  icon: string;                    // lucide icon name
  marketplaceCategory: AgentTemplateCategory;
  requiredApps: AgentTemplateRequiredApp[];
  setupQuestions: PaperclipQuestion[];   // existing shared question type
  outwardActions: AgentTemplateOutwardAction[];  // keyed by requiredApps capability
  recommendedAdapterType?: string;
  defaultBudgetMonthlyCents?: number;
  preview?: boolean;
}
export interface AgentTemplateSummary {   // card data
  ref: string;                     // "staples/<slug>"
  slug: string; name: string; tagline: string; icon: string;
  marketplaceCategory: AgentTemplateCategory; version: string;
  needs: { capability: string; anyOf: string[]; optional: boolean; why: string }[];
  asksBefore: string[];            // outwardActions labels
  routines: { title: string; schedule: string; timezone: string }[];
  defaultBudgetMonthlyCents: number | null;
}
export interface AgentTemplateDetail extends AgentTemplateSummary {
  description: string;             // TEAM.md body (markdown)
  setupQuestions: PaperclipQuestion[];   // context placeholders resolved
}
export interface RenderedAgentTemplate {
  ref: string; version: string;
  agent: { name: string; role: string; title: string; instructionsMarkdown: string; skills: string[] };  // skills = slugs as in AGENTS.md
  vendoredSkills: { slug: string; files: Record<string, string> }[];
  routines: { title: string; description: string; cronExpression: string; timezone: string }[];
  starterTasks: { title: string; description: string }[];
  requiredApps: AgentTemplateRequiredApp[];
  outwardActions: AgentTemplateOutwardAction[];
  defaultBudgetMonthlyCents: number | null;
  recommendedAdapterType: string | null;
}
```
```ts
// server/src/services/agent-templates.ts
export function agentTemplatesService(deps?: { catalog?: ... }): {
  list(opts?: { includePreview?: boolean }): Promise<AgentTemplateSummary[]>;
  get(ref: string, ctx: { companyName: string; personName: string }): Promise<AgentTemplateDetail>;  // 404 unknown or preview
  render(ref: string, version: string | null, answers: Record<string, string | string[]>, ctx: { companyName: string; personName: string; personTimezone: string }): Promise<RenderedAgentTemplate>; // 422 on bad/missing answers, 409 on version mismatch
};
export function validateAgentTemplatePackage(files: Record<string, string>, appSlugs: Set<string>): string[]; // error messages
```

- [ ] Shared zod schema for `staples.template.json` matching the types above; `setupQuestions` reuse the existing question validator plus the Phase 4 recommendation rule (`missingQuestionRecommendations`).
- [ ] Catalog builder: discover `optional/staples/<slug>/` like any optional category (research §1), read `staples.template.json` when present into the catalog entry (`staplesTemplate` field), and include it in `generated/catalog.json`. Regenerate the manifest; update `shipped-catalog.test.ts` only for the fixture-free state (no shipped templates yet in this task).
- [ ] TASK.md: accept optional `schedule` (5-field cron) and `timezone` (`person` or IANA) frontmatter; `recurring: true` requires `schedule` for templates.
- [ ] `validateAgentTemplatePackage`: sidecar schema; all questions have recommendations; every placeholder in AGENTS.md/TASK.md bodies is `answers.<existing id>`, `company.name` or `person.name`; `requiredApps[].anyOf` slugs exist in app definitions (`packages/shared/src/app-definitions/*.json` filenames) or are listed in an exported `AGGREGATOR_APP_SLUGS` allowlist (`linkedin`, `x`, `reddit`, `youtube`, `instagram`, `facebook`, `tiktok`) per research §11; every `outwardActions[].capability` matches a requiredApps capability; cron valid; timezone valid; AGENTS.md skills reference either a vendored skill in the package or a known skills-catalog slug (research §13).
- [ ] `render`: substitutes placeholders as plain text (answers trimmed, ≤ 500 chars, single-select answers map to the option **label**; multi_select joined with ", "); `timezone: person` → `ctx.personTimezone`; rejects missing required answers and unknown question ids (422); pins version (409 when `version` given and differs).
- [ ] Tests: validator cases (missing recommendation, unknown placeholder, unknown app slug, bad cron, outward capability not in requiredApps); render substitutes and escapes nothing beyond plain text (an answer containing `{{answers.x}}` is inserted literally, not re-expanded); preview templates hidden from list/get; version mismatch 409.
- [ ] Commit.

---

### Task 2: Templates batch 1 — Researcher, Content creator, Email secretary, Newsletter, Support triage

**Files:** `packages/teams-catalog/catalog/optional/staples/{researcher,content-creator,email-secretary,newsletter,support-triage}/` (TEAM.md, `staples.template.json`, `agents/<slug>/AGENTS.md`, `skills/*/SKILL.md`, `tasks/*/TASK.md`), regenerated `generated/catalog.json`, `shipped-catalog.test.ts`, a server test that runs `validateAgentTemplatePackage` over every shipped template (`server/src/__tests__/agent-templates-shipped.test.ts`).

Content requirements (generic, no company-specific material; plain second-person instructions; each AGENTS.md 60–150 lines):

| Template | requiredApps | Setup questions (all with recommendations) | Routines (schedule) | Starter tasks | outwardActions |
|---|---|---|---|---|---|
| researcher | none | focus area (text, initialText from company brief hint "your market"), report day (single: Monday ✓/Friday), depth (single: brief ✓/deep-dive) | "Weekly market brief" `0 9 * * {{day}}` → use answers to choose cron | "Learn the business from the Company Brief and propose 3 research questions" | none |
| content-creator | optional: social (`linkedin`,`x`), cms (`webflow`) | audience (text), tone (single: friendly ✓/professional/playful), cadence (single: 2/week ✓, 1/week, daily) | "Weekly content plan" Mon 09:00 | "Draft a 4-week content calendar from the Company Brief" | social → "Publishing posts", cms → "Publishing to your site" |
| email-secretary | email: `agentmail`,`gmail`; optional calendar: `google-calendar` (only if that slug exists; else omit) | what to call you (text, initialText `{{person.name}}`), sweep time (single: 8am weekdays ✓/7am/9am), what counts as urgent (text, initialText "customers, money, deadlines") | "Morning inbox sweep" weekdays at chosen time; "Daily digest" weekdays 17:00 | "Learn my inbox: summarize the last 2 weeks and propose filing rules" | email → "Sending email" (AgentMail only; Gmail drafts), destructiveLabel "Deleting email" |
| newsletter | newsletter: `beehiiv`,`resend`,`klaviyo` | topic (text), cadence (single: weekly ✓/biweekly/monthly), send day (single: Tuesday ✓/Thursday) | "Research and draft the issue" 2 days before send; "Schedule the issue" on send day | "Propose a name, format and first 3 issue outlines" | newsletter → "Sending to your list" |
| support-triage | inbox: `agentmail`,`gmail`,`slack` | product summary (text), escalation contact (text, initialText `{{person.name}}`), response tone (single: warm ✓/concise) | "Support triage" `0 */2 * * *` | "Build a FAQ from past support messages" | inbox → "Replying to customers" |

Each template has 1–2 vendored skills with concrete procedures (e.g. `inbox-triage`, `digest-writing`, `newsletter-issue`, `support-reply`, `market-brief`, `content-calendar-planning`); skills follow the existing SKILL.md format in `packages/skills-catalog/catalog`. Every AGENTS.md states: what to do with no service connected yet (start the "Connect <service>" task by calling `connection_request`), that outward actions wait for approval unless autopilot is on, and to report results as task documents.

- [ ] Write the five packages.
- [ ] Regenerate the catalog manifest; update `shipped-catalog.test.ts` expected keys/counts.
- [ ] `agent-templates-shipped.test.ts`: every shipped template passes `validateAgentTemplatePackage`, renders with its recommended answers, and has ≥1 routine except where the table says none.
- [ ] Commit.

---

### Task 3: Templates batch 2 — Social media manager, Website builder, Bookkeeper, Coding agent

**Files:** `packages/teams-catalog/catalog/optional/staples/{social-media-manager,website-builder,bookkeeper,coding-agent}/`, regenerated manifest, `shipped-catalog.test.ts`.

| Template | requiredApps | Setup questions | Routines | Starter tasks | outwardActions | preview |
|---|---|---|---|---|---|---|
| social-media-manager | social: `linkedin`,`x` (aggregator) | platforms (multi: LinkedIn ✓, X), voice (single: friendly ✓/expert/bold), posts per week (single: 3 ✓/5/7) | "Weekly post plan" Mon 10:00; "Engagement check" daily 16:00 | "Audit current profiles and propose a 2-week plan" | social → "Posting" | `true` unless an aggregator-backed connection test passes in the existing connection tests — default `true` |
| website-builder | hosting: `vercel`,`netlify`,`webflow` | what the site is for (text), style (single: clean ✓/bold/playful), domain (text, initialText "use the free host address for now") | "Weekly site check" Mon 08:00 | "Build a one-page landing site and share a preview link" | hosting → "Deploying to your live site" | `false` |
| bookkeeper | payments: `stripe`; optional accounting: `xero` | report day (single: Monday ✓/Friday), currency (text, initialText "USD") | "Weekly revenue and spend summary"; "Monthly close notes" `0 9 1 * *` | "Summarize the last 30 days of revenue and AI spend" | none (read-only; instructions forbid creating charges, refunds, payouts or transfers) | `false` |
| coding-agent | code: `github` | repository (text), branch policy (single: open PRs, never push main ✓ / push small fixes to main), test command (text, initialText "detect from the repo") | "Daily issue triage" weekdays 09:00; "Weekly dependency and health check" Mon 09:00 | "Read the repository and write a short architecture note" | code → "Merging and pushing to the default branch" (destructiveLabel "Deleting branches or closing issues") | `false` |

Coding agent references skills-catalog skills by bare slug in AGENTS.md (`github-pr-workflow`, `issue-triage`, `qa-acceptance` — research §13) and vendors none with those names. Bookkeeper's instructions include an explicit prohibition on any money-moving tool.

- [ ] Write the four packages; regenerate the manifest; update shipped tests; the Task 2 shipped-validator test now covers nine templates (preview ones validated too).
- [ ] Commit.

---

### Task 4: Plans support templates (proposal pinning + apply)

**Files:** `packages/shared/src/validators/plan.ts` (agents[] gains `templateRef?: string` and `templateAnswers?: Record<string, string | string[]>`; plan agent `instructions` remain disallowed), shared plan types incl. `ApplyPlanResult`, `server/src/services/assistant-proposed-actions.ts` (`pinPlanProposalBody`), `server/src/services/assistant-tools.ts` (`planHireConnectionsFor` display data → also `planTemplateSummaries`), `server/src/services/plans.ts`, `server/src/routes/plans.ts`, `ui/src/components/IssueThreadInteractionCard.tsx` (plan card block), tests `server/src/__tests__/plans-apply-routes.test.ts`, `server/src/__tests__/assistant-proposed-actions.test.ts`, UI plan card test.

**Interfaces:**
- Consumes: `agentTemplatesService().render/get` (Task 1).
- Produces: plan agent entry `{ clientKey, name?, role?, title?, adapterType?, templateRef?, templateAnswers?, budgetMonthlyCents? }` (name/role/title default from the template); proposal payload display field `planTemplateSummaries: { clientKey, ref, name, needs: string[], asksBefore: string[], routineCount, budgetMonthlyCents }[]` (server-computed, not hashed, not read by apply — same contract as `planHireConnections`); `ApplyPlanResult` gains `routines: { id, title, agentClientKey }[]` and per-agent `templateRef`.

- [ ] Proposal pinning: for each templated agent, render with the given answers (422 surfaces as a proposal refusal with the message), pin `templateVersion` into the stored body (hashed), and compute `planTemplateSummaries`.
- [ ] Apply (inside the existing lease/fence/idempotency flow, research §5–§10):
  1. Import vendored skills into the company library and install referenced skills-catalog skills (reuse the company-skills / portability helpers named in research §5); skip ones already present.
  2. Hire via `planHireBody` passing `instructionsBundle` (AGENTS.md entry = rendered instructions), `desiredSkills`, `budgetMonthlyCents` (plan value ?? template default), `adapterType` (plan ?? template recommended if proposable ?? existing rules), plus Phase-5 inherited connection logic unchanged.
  3. Seed a `require_approval` tool-access rule for the new agent: `selectors.agentId`, `riskLevels: ["write","destructive"]`, priority 50 (pattern: `tool-access.ts:13839`, research §10) — only if the template declares outwardActions.
  4. Create routines with a schedule trigger (cron, timezone) assigned to the agent; if the hire is `pending_approval`, create them paused (research §8). Log activity like the routines route does.
  5. Create starter tasks assigned to the agent (pending-approval hires: unassigned in backlog, as today). For each non-optional requiredApp capability with no existing usable connection in the company for any `anyOf` slug, create a first task `Connect <app display name>` whose description tells the agent to call `connection_request` for one of the `anyOf` apps and explains `why`; other starter tasks are blocked by it.
  6. Record `metadata.staplesTemplate = { ref, version, outwardActions, requiredApps }` on the agent (server-written; not settable via agent PATCH — add it to the same protected-key handling as the built-in marker).
- [ ] Plan card: per templated hire, one line "Email secretary · needs AgentMail or Gmail · asks before: sending email · 2 routines · $20/mo", rendered from `planTemplateSummaries`.
- [ ] Tests: templated plan creates agent with rendered instructions + skills + routines (with triggers) + starter tasks + connect task blocking others + require_approval rule + metadata; re-apply idempotent (no duplicate routines/skills/rules); version pin mismatch fails the proposal; bad answers refused at proposal; pending-approval hire → paused routines; untemplated plans unchanged; agent PATCH cannot set `staplesTemplate`.
- [ ] Commit.

---

### Task 5: Assistant uses templates

**Files:** `server/src/services/assistant-tools.ts` (read tools), `server/src/built-ins/agents/assistant/AGENTS.md`, `skills/staples-plan/SKILL.md`, `skills/staples-interview/SKILL.md` (only if it lists example businesses), `server/src/services/built-in-agents.ts` (stockVersion "2026-10-12a"), `ui/src/staples/assistant/AssistantOpening.tsx` (chips), tests incl. the existing `assistant-instructions-tools.test.ts`.

- [ ] Read tools: `staples_list_templates` → `AgentTemplateSummary[]` (non-preview); `staples_get_template { ref }` → `AgentTemplateDetail` with `{{person.name}}`/`{{company.name}}` resolved from the run's person and company. Both company-scoped like other read tools.
- [ ] AGENTS.md: when a hire matches a template, use it; ask its setup questions with `staples_ask_questions` (recommendations included); put `templateRef` + `templateAnswers` on the plan agent; after apply, mention "Connect <service>" tasks and Autopilot. When the person arrives with "Set up <Template name>" (marketplace hand-off), go straight to that template's setup questions.
- [ ] `staples-plan` skill: prefer templates; never write instructions for templated hires; templated hire fields.
- [ ] Opening chips: "An assistant for my inbox", "A weekly newsletter", "A landing page for my idea" (replace the three current chips).
- [ ] Tests: tools listed and return data; preview templates excluded; consistency test passes; chips render.
- [ ] Commit.

---

### Task 6: Autopilot API

**Files:** `server/src/services/agent-autopilot.ts` (new), `server/src/routes/agent-autopilot.ts` (new, registered in `app.ts`), OpenAPI, shared types/validators `packages/shared/src/types/agent-autopilot.ts`, tests `server/src/__tests__/agent-autopilot.test.ts`.

**Interfaces (produces):**
```ts
export interface AgentAutopilotCategory {
  capability: string; label: string; destructiveLabel: string | null;
  connection: { id: string; appSlug: string; displayName: string } | null; // the company connection satisfying the capability for this agent, if any
  mode: "ask" | "auto";        // auto = an allow rule exists for this agent+connection+write
  canToggle: boolean;          // false when no connection yet
}
// GET  /api/agents/:agentId/autopilot → { categories: AgentAutopilotCategory[] }
// PUT  /api/agents/:agentId/autopilot/:capability { mode: "ask" | "auto" } → AgentAutopilotCategory
```
- [ ] Auth: board user with `agent_config:update` on the agent (same check as agent configuration); company-scoped; activity logged (`agent.autopilot_changed`).
- [ ] Categories come from `metadata.staplesTemplate.outwardActions`; the connection is the first company connection whose app slug is in that capability's `anyOf` and is usable by the agent.
- [ ] `auto` creates (idempotently) an `allow` rule: `selectors: { agentId, connectionId }`, `riskLevels: ["write"]`, priority 60 (above the install-time require_approval at 50 — verify ordering semantics in `tool-access-policy.ts` and choose the value that makes allow win for write only); `ask` deletes it. Destructive risk is never included; a request that would allow destructive is impossible by construction (no input field for it).
- [ ] Tests: GET lists categories with modes; PUT auto creates exactly one rule and a write tool call by that agent on that connection no longer needs approval while a destructive call still does (use the tool gateway decision function, research §10); PUT ask removes it; canToggle false without connection → 409; other company/agent → 403/404; non-templated agent → empty categories.
- [ ] Commit.

---

### Task 7: Marketplace page and plan-card hand-off

**Files:** `ui/src/staples/marketplace/MarketplacePage.tsx` (new), `TemplateCard.tsx`, `TemplateDetailSheet.tsx`, `ui/src/api/agentTemplates.ts` (new client for a new board route), `server/src/routes/agent-templates.ts` (new: `GET /api/companies/:companyId/agent-templates` and `GET /api/companies/:companyId/agent-templates/:slug` → board-only read, using the Task 1 service), OpenAPI, `ui/src/App.tsx` (`/agents/new` → MarketplacePage; existing `NewAgentSetup` moves to `/agents/new/custom`, research §12), surface registry entry `nav.hire` ("Hire an agent", icon `UserPlus`, group `org`, tier `core` when an Assistant exists), tests.

- [ ] Page: heading "Hire an agent"; category sections in order communication, content, research, operations, engineering, finance; cards show icon, name, tagline, "Needs: …" (or "Works right away"), "Asks before: …". A "Build your own" link to `/agents/new/custom`.
- [ ] Detail sheet: description (markdown), routines with human schedule text, services and access, setup questions preview (read-only), **Hire** button → `askAssistant({ text: "Set up <name>", send: true })` and opens the dock; if `askAssistant` returns false, show the Phase-5 unavailable notice.
- [ ] Existing links to `/agents/new` keep working (they now land on the marketplace).
- [ ] Tests: grid renders categories from fixture; detail sheet shows needs/asks/routines; Hire calls askAssistant with the right text; unavailable path; route test for `/agents/new/custom`; server route tests (board-only, preview hidden).
- [ ] Commit.

---

### Task 8: Agent page — template chip and Autopilot panel; Home roll-up

**Files:** `ui/src/pages/agent-detail-navigation.ts` (add view `autopilot` to the Agent group, research §12), `ui/src/components/AgentContextualSidebar.tsx` (show Autopilot only for templated agents), `ui/src/pages/AgentDetail.tsx` (render), `ui/src/staples/autopilot/AutopilotPanel.tsx` (new), `ui/src/api/agentAutopilot.ts`, agent header chip "From template: <name> v<version>", `server/src/services/briefing.ts` + `ui/src/staples/home/*` (Done recently roll-up), tests.

- [ ] Autopilot panel: one row per category: label, connection name or "Connect <app> first" link to `/apps`, segmented control "Ask first / Send without asking" (disabled when `canToggle` false), destructive label row "Always asks" without control. Errors surface inline.
- [ ] Approval cards for this agent's outward tool actions: existing "remember" checkbox label reads "Always allow <category label> for this agent" when the agent is templated (copy change only; behavior is the existing remember → trust rule).
- [ ] Home Done recently: per templated agent, one roll-up row per day when it completed outward write actions: "<Agent> sent 3 emails" (count tool invocations with risk write, status succeeded, last 24h; wording "<Agent> took 3 actions in <App>" when the category isn't email).
- [ ] Tests: panel rows/modes/toggle calls/disabled/destructive row; nav shows Autopilot only for templated agents; briefing roll-up count and company isolation.
- [ ] Commit.

---

### Task 9: End-to-end and verification

- [ ] Server e2e (`server/src/__tests__/agent-template-install-e2e.test.ts`, pattern: `assistant-interview-plan-e2e.test.ts`): Assistant proposes a plan with `templateRef: "staples/researcher"` and recommended answers → person claims and applies → agent exists with rendered instructions and skills, the weekly routine has a schedule trigger, starter task exists, no connect task; second template `staples/email-secretary` with no email connection → connect task blocks the others and a require_approval rule exists.
- [ ] `pnpm typecheck`; `pnpm check:token-gates`; UI suite `cd ui && timeout 1800 npx vitest run --testTimeout=60000`; `pnpm --filter @paperclipai/ui build`; teams-catalog tests; server tests touched this phase (single files).
- [ ] Browser walkthrough with screenshots in `tmp/screenshots/phase6/`: marketplace grid, detail sheet, Hire → Assistant dock with "Set up Researcher", agent page with template chip and Autopilot panel, Home with a connect task under Needs you. Send them to the person.
- [ ] Record results in the ledger.

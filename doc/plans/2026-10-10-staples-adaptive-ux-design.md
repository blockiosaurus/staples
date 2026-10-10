# Staples: adaptive UI and in-app Assistant (design)

Status: approved design, pending spec review
Date: 2026-10-10
Branch: `staples/adaptive-ux`

## Context

Staples is a hard fork of Paperclip (`paperclipai/paperclip`). We are free to
delete, rename and reshape UI routes and APIs; upstream merges are not a goal.
This spec is generic product work. Company-specific tuning and rebranding
(name, logo, strings) are out of scope.

Today a new user lands on a multi-step wizard, then a shell with 12 sidebar
controls, ~60 company routes and two parallel UI shells (streamlined and
legacy) selected by an instance flag. Every existing visibility mechanism is
instance-wide (experimental flags), operator policy (hidden settings) or
browser-local (localStorage). Nothing adapts per user or per company state.

## Goals

1. A new company starts at nothing: a conversation with an Assistant that asks
   what you want to build.
2. The UI grows in complexity only when the company's state calls for it, with
   per-user overrides.
3. An Assistant acts as the intermediary between the person and the company on
   every page: answers questions, explains how to do things, and acts on the
   person's behalf within tiered authority.

## Non-goals

- Rebranding to "Staples" in product strings or assets.
- External chat channels (Slack, Teams) for the Assistant. The existing chat
  connector pipeline can carry it later.
- Assistant-generated recommendations for items whose source did not supply
  one (a later "brief me" action).
- Undo controls for Assistant writes beyond the activity log.

## Experience

### Stage 0: empty company

- Creating a company (or opening one with no agents other than built-ins) shows a full-screen
  Assistant conversation. No sidebar; only the company switcher and account
  menu.
- The existing onboarding wizard is removed. Its company-name step becomes the
  only pre-chat input (the name is required to create the company row).
- The Assistant needs a runtime. The server auto-detects available local
  adapters (Claude Code first). When none is usable, the conversation opens
  with an inline "Connect a model" card reusing the current model-source
  components; the interview starts once a model is connected.
- The Assistant runs the **interview** (see below), then proposes a plan as
  one confirmation card: company goal, agents to hire, starter tasks with
  blocking edges, and the Company Brief document. Confirming creates all of it.

### Stage 1: first agent working

- A slim sidebar appears: **Home, Assistant, Tasks, Agents**.
- **Home** is a briefing:
  1. *Needs you*: pending approvals, agent questions, blocked tasks, budget
     incidents. Each shows the source's recommended answer and an **Ask
     Assistant** action.
  2. *In progress*: active tasks and live runs.
  3. *Done recently*.
  4. The Assistant composer.

### Growth

Surfaces appear when their signal fires. Initial rules (tunable constants):

| Surface | Reveal when |
|---|---|
| Projects | projects >= 2, or tasks >= 25 |
| Decisions | any approval or agent question has ever existed |
| Goals | goals >= 2 |
| Routines | routines >= 1 |
| Artifacts | artifacts >= 1 |
| Skills | company skills beyond the bundled set >= 1, or an agent requested a skill |
| Connectors | any connection exists or was requested |
| Costs | a budget is set, or month spend > 0 with budgets enabled |
| Inbox | the person has >= 1 unread assigned item that is not on Home |

On reveal, the item shows a "new" badge until first visit, with a one-line
reason ("Projects appeared because you now have 2 projects"). The Assistant
mentions newly revealed surfaces in its next reply.

**Advanced surfaces** never reveal automatically: Workspaces, Cases,
Pipelines, Status cards, Audit/Activity, Instance admin, and plugin pages.
They appear when the person pins them, asks the Assistant ("show me
routines"), or turns on **Show everything** in Settings.

The same rules apply inside pages. Example: agent detail starts as summary plus
chat; Runs, Configuration, Permissions and Instructions tabs reveal when the
agent has runs, when the person opens configuration from the Assistant, or via
Show everything.

### Assistant everywhere

- A docked panel on every page, toggled with Cmd/Ctrl+J, and a full page at
  `/:prefix/assistant`.
- Each message carries page context (route, entity type and id) so "why is
  this blocked?" works on a task page without naming the task.

## The interview (Pocock skills)

We vendor and adapt MIT-licensed skills from `mattpocock/skills` into the
skills catalog under `staples/`, with attribution in each skill and the
catalog README.

| Source skill | Staples skill | Use |
|---|---|---|
| grilling | `staples/interview` | New-company interview and any "help me think this through" request |
| domain-modeling | `staples/company-brief` | Maintain the Company Brief document |
| to-spec + to-tickets | `staples/plan` | Turn an interview into goal, agents and starter tasks |
| wayfinder | `staples/wayfinder` | Decision map for large initiatives (advanced, on request) |
| to-questionnaire | `staples/questionnaire` | Draft a questionnaire for someone else when the person cannot answer |
| chief-of-staff | Assistant instructions | Standing posture: tactical help plus suggestions to improve how the company operates |

Adaptations:

- **Rounds become question cards.** Each grilling round is one
  `ask_user_questions` interaction. Every question has exactly one option with
  `recommended: true`, pre-selected, worded so accepting it means "yes". The
  card adds an **Accept all recommendations** action.
- **Facts vs decisions.** The Assistant looks up facts itself (company data,
  connected sources) and only asks the person for decisions.
- **Done means confirmed.** The interview ends when no open decisions remain
  and the person confirms shared understanding. Only then does
  `staples/plan` propose the plan card.
- **Glossary lives in the company.** `GLOSSARY.md` becomes the Company Brief
  company document (mission, glossary, key decisions). All agents receive it
  in their run context.
- **Tracker is Paperclip.** Ticket and map skills target Paperclip issues,
  sub-issues and blockers, not GitHub or local files.

### Recommended answers everywhere

Every agent question must carry a recommendation:

- The interaction validator requires exactly one `recommended: true` option
  for `single_select` questions and at least one for `multi_select` questions
  that have options. Text questions may supply `initialText` as the
  recommendation.
- The bundled `paperclip` agent skill instructs agents to always recommend.
- Existing stored interactions are unaffected (validation applies on create).

Home then shows recommendations without extra model calls.

## Architecture

### 1. Surface registry (UI)

Location: `ui/src/staples/surfaces/`.

```ts
type SurfaceTier = "core" | "grows" | "advanced";
type SurfaceSlot = "nav" | "home" | "pageTab" | "panel";

interface Surface {
  id: string;                 // e.g. "nav.projects", "agent.tab.runs"
  slot: SurfaceSlot;
  tier: SurfaceTier;
  label: string;              // i18n key
  to?: string;                // route (company-prefixed)
  revealWhen?: (s: CompanySignals) => boolean; // "grows" only
  reason?: (s: CompanySignals) => string;      // i18n key + params
}
```

- `useSurface(id)` returns `{ visible, isNew, pinned, hidden, reason }`.
- Visibility: `hidden` override wins, then `pinned`, then Show everything,
  then tier (`core` always, `grows` when `revealWhen` is true or the surface
  was previously revealed, `advanced` never).
- Once revealed, a `grows` surface stays visible even if the signal drops
  (no flicker when the last routine is deleted).
- Sidebar, command palette, mobile bottom nav and page tab bars read from the
  registry. Hard-coded nav arrays are deleted.
- **Hidden never blocks a URL.** All routes stay reachable. Visiting a hidden
  surface's route reveals it.

### 2. Signals API (server)

`GET /api/companies/:companyId/signals` returns cheap counts:

```ts
interface CompanySignals {
  agents: number; tasks: number; openTasks: number; blockedTasks: number;
  projects: number; goals: number; routines: number; artifacts: number;
  extraSkills: number; connections: number; connectionRequests: number;
  approvalsEver: number; questionsEver: number;
  budgetSet: boolean; monthSpendCents: number;
  liveRuns: number;
}
```

- One query per count, all `count(*)` on indexed company-scoped columns.
- Invalidated in the UI through the existing live-updates events for the
  affected entities.
- Board-only route. Requires company membership.

### 3. Per-user UI preferences

New table `user_company_ui_preferences`:

| column | type |
|---|---|
| user_id | text, pk part |
| company_id | uuid, pk part, fk companies |
| pinned | text[] |
| hidden | text[] |
| revealed | jsonb `{ surfaceId: isoTimestamp }` |
| seen | jsonb `{ surfaceId: isoTimestamp }` (clears "new") |
| show_everything | boolean default false |
| updated_at | timestamptz |

Routes extend the existing `sidebar-preferences` module:
`GET/PATCH /api/companies/:companyId/ui-preferences/me`. The Assistant updates
`pinned` via a tool when the person asks to see something.

### 4. The Assistant agent

- A new built-in agent definition `assistant` alongside the existing built-ins
  (`server/src/services/built-in-agents.ts`), with instructions at
  `server/src/built-ins/agents/assistant/AGENTS.md`.
- Provisioned automatically when a company is created. It does not appear in
  the org chart and cannot be assigned regular tasks; it is excluded from
  agent counts in signals.
- It becomes each person's default primary agent for the company when they
  have none.
- Adapter: auto-detected at provisioning (Claude Code preferred). Re-detected
  on demand from the "Connect a model" card.
- Conversations reuse Agent Chat (issue-backed conversations, comment
  delivery, wakeups, live transcripts, interaction cards). `enableAgentChat`
  is removed; chat is always on.
- Page context is stored on the user's comment as structured metadata and
  rendered into the conversation prompt by run preparation.
- Desired skills: `paperclip` (operating guide), `staples/interview`,
  `staples/company-brief`, `staples/plan`, `staples/questionnaire`,
  `staples/wayfinder`, and `paperclip-board` rewritten to use MCP tools
  instead of curl.

### 5. Authority and tools

Tiers:

| Tier | Examples | Execution |
|---|---|---|
| Read | Any company data the person can see | Direct |
| Low-risk write | Create/edit tasks, comment, reassign, answer an agent question on the person's behalf, pin a surface, update the Company Brief | Direct, on behalf of the person, activity-logged with `via: assistant` |
| Governed | Approvals, hire/terminate agents, budgets, secrets, connections/OAuth grants, anything outbound or published, deleting anything | Confirmation card; the person's click executes it |

Tools:

- Assistant conversation runs receive a person-scoped MCP endpoint, injected
  next to the existing runtime MCP endpoints in heartbeat runtime execution.
- The endpoint reuses the public-MCP capability layer
  (`createMcpApiDispatch`) with the actor derived from the run's
  `onBehalfOfUserId`, restricted to read and low-risk-write capabilities by an
  explicit allowlist. All existing route authorization and activity logging
  apply.
- A `propose_action` tool creates a `request_confirmation` interaction whose
  payload holds the exact proposed API call (`method`, `path`, `body`) plus a
  human summary and the entity version it was based on.
- On **Confirm**, the browser executes the stored call with the person's own
  session, so `assertBoard` and every governance check run against the person.
  Before executing, the client re-fetches the target entity; if its version
  changed, the card shows what changed and asks again.
- The result (success or error) is posted back to the conversation so the
  Assistant can continue.

### 6. Home briefing

`GET /api/companies/:companyId/briefing` returns:

```ts
interface Briefing {
  needsYou: BriefingItem[];   // approvals, interactions, blocked tasks, budget incidents
  inProgress: BriefingItem[]; // active tasks, live runs
  doneRecently: BriefingItem[]; // last 7 days, capped
}
interface BriefingItem {
  kind: string; id: string; title: string; href: string;
  recommendation?: { label: string; optionId?: string };
  createdAt: string;
}
```

It reuses the decision-queue aggregation. Items with a recommendation can be
resolved inline ("Accept recommendation") through the existing interaction and
approval routes.

### 7. Pruning

Delete:

- Legacy shell: `Layout.production.tsx`, `Sidebar.production.tsx`, all
  `*.production.tsx` pages, and the `enableStreamlinedUi` flag and its route
  branches.
- UxLab and preview pages and their routes, plus standalone preview entry
  points (`wizard-preview-main.tsx`, `connect-flow-preview-main.tsx`,
  `connect-model-preview-main.tsx`) and their Vite config.
- Board Chat ("Conference Room"): `BoardChat.tsx`, `server/src/routes/board-chat.ts`,
  `enableConferenceRoomChat`, and its tests.
- The onboarding wizard (`OnboardingWizard.tsx` and the onboarding step
  components not reused by the connect-a-model card).

Convert to advanced surfaces (instance admins can still disable them):
Cases, Pipelines, Status cards, Isolated workspaces, Chat connectors.

Fix while restructuring routes: unprefixed company paths (for example
`/dashboard`) must redirect to the selected company instead of resolving the
segment as a company prefix.

### 8. Failure handling

- No usable adapter: the conversation shows the Connect-a-model card; nothing
  else is blocked.
- Assistant run fails: the error is shown inline with Retry (reuses the
  conversation retry path).
- Signals request fails: the UI shows `core` surfaces plus anything previously
  revealed (from preferences), never an empty shell.
- Preferences request fails: same fallback, overrides not applied, retry on
  focus.
- Confirmation execution fails: the card shows the error and remains
  actionable; the error is posted to the conversation.

## Testing

- **UI unit:** registry visibility rules against signal fixtures (each tier,
  overrides, sticky reveal, Show everything); recommendation pre-selection and
  Accept-all on question cards.
- **Server:** signals counts per entity and company isolation; preferences
  CRUD and membership checks; briefing aggregation; recommendation validation
  on interaction create; Assistant provisioning on company create; MCP
  allowlist rejects governed calls; confirmation payload round-trip.
- **E2E (Playwright):** create company -> Assistant interview round -> accept
  recommendations -> plan card confirmed -> stage-1 sidebar shows Home,
  Assistant, Tasks, Agents -> creating a second project reveals Projects with
  a "new" badge. Uses a stub adapter so no model is needed in CI.

## Delivery order

Each phase ships working software:

1. Pruning and route fixes (removes the second shell before building on it).
2. Surface registry, signals and preferences (adaptive nav with the current
   pages).
3. Assistant agent, chat-everywhere panel and authority tiers.
4. Pocock-derived skills, the interview, recommendation enforcement and the
   plan card; replace onboarding with the Stage 0 conversation.
5. Home briefing and in-page progressive disclosure for task and agent detail.

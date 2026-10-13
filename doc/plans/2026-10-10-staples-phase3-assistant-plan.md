# Staples Phase 3: The Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every company gets an Assistant agent that each person can chat with from a full page or a docked panel on any page. The Assistant knows what page the person is on, acts on their behalf for reads and low-risk writes, and turns governed actions into Confirm cards that the person's browser executes.

**Architecture:** The Assistant is a built-in agent (`key: "assistant"`) provisioned automatically for every company. Conversations reuse Agent Chat (issue-backed, one per agent and person), which becomes always-on. Page context rides on the person's chat comment as structured metadata and is rendered into the prompt as untrusted display data. Assistant runs get a person-scoped MCP endpoint (`/api/mcp/assistant-tools`) that synthesizes a board actor for the run's responsible user and dispatches through the existing public-MCP capability layer, restricted to an allowlist. Governed actions become `request_confirmation` interactions with a server-owned `proposedAction` payload (exact method/path/body plus a hash); on Confirm the browser performs the call with the person's own session and reports the result.

**Tech Stack:** Express + Drizzle, Zod (`@paperclipai/shared`), React 19 + TanStack Query, Vitest (UI tests: `// @vitest-environment jsdom`, `createRoot` + `flushSync`).

Spec: `doc/plans/2026-10-10-staples-adaptive-ux-design.md` (sections "Assistant everywhere", Architecture 4-5). Research notes with exact file locations: `.superpowers/sdd/2026-10-10-staples-phase3-assistant-plan/research.md`.

## Global Constraints

- Hard fork: upstream merge compatibility is not a goal.
- The Assistant is infrastructure, not staff: it never appears in the org chart, agent lists, the sidebar Agents section, assignee pickers, or signal counts, and it cannot be assigned regular tasks.
- Authority tiers (spec): reads → direct; low-risk writes (create/edit tasks, comment, reassign, answer an agent question on the person's behalf, pin a nav surface) → direct, on behalf of the person, activity-logged; governed actions (approvals, hire/terminate/pause agents, budgets, secrets, connections/OAuth grants, anything outbound or published, deleting anything) → Confirm card executed by the person's browser session.
- The run's acting person is always derived from the database run row (`responsibleUserId`), never from tool arguments or page context.
- Page context is untrusted display data: never an authorization input.
- Mutating actions keep activity logging; Assistant-performed writes must be attributable (activity rows show the person as actor and the Assistant run as the source).
- Commands: single tests `npx vitest run <path>`; full UI suite `cd ui && npx vitest run --testTimeout=60000` (host is heavily loaded; `CompanyEnvironments.test.tsx` is a known pre-existing flake); typechecks `pnpm --filter @paperclipai/<shared|db|server|ui> typecheck`. Embedded-Postgres server tests: run only the files you touch.
- Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths; confirm with `git log --oneline -1`.

---

### Task 1: Agent Chat always on

**Files:** `packages/shared/src/{validators/instance.ts,types/instance.ts,feature-catalog.ts}` (+ tests), `server/src/services/instance-settings.ts`, every server reader of `enableAgentChat` (`routes/issues.ts` ~16229, 18050, 18061, 18094, 19247; `wake-queue/adapters/postgres.ts:1193`; `services/heartbeat.ts:2197`; `services/heartbeat/queue.ts:2140`; `services/chat-completion-delivery.ts:175`; `services/recovery/service.ts:4439`; `services/issues.ts:12537`), UI readers (`ui/src/hooks/useAgentChatEnabled.ts` and its callers, `InstanceExperimentalSettings.tsx`), `ui/src/staples/surfaces/registry.ts` (`nav.chat`).

**Interfaces — Produces:** `enableAgentChat` is in `RETIRED_FEATURE_KEYS` (same mechanism as `enableConferenceRoomChat`); every former check behaves as enabled; `useAgentChatEnabled` is deleted. `nav.chat` becomes tier `grows` with `revealWhen: signals.agents >= 2` and reason "Chat appeared because you have more than one agent." (it has no `available` function any more).

- [ ] Step 1: Failing tests: shared retired-key tests include `enableAgentChat`; a server route test that `GET /companies/:id/chats` works with stored `enableAgentChat: false`; registry test for the new `nav.chat` rule.
- [ ] Step 2: Collapse every server and UI branch to the enabled side; delete the hook and its test; remove the settings toggle.
- [ ] Step 3: `grep -rn "enableAgentChat\|useAgentChatEnabled" server/src ui/src packages/shared/src` shows only the deprecated schema/type lines and retired-key tests.
- [ ] Step 4: Typechecks; touched tests; full UI suite. Commit `refactor: make Agent Chat always on`.

---

### Task 2: Assistant built-in agent and provisioning

**Files:** `server/src/services/built-in-agents.ts`, new `server/src/built-ins/agents/assistant/AGENTS.md` (placeholder content; Task 7 writes the real instructions), `server/src/services/companies.ts` (create path already calls `autoProvisionBundledAgents`), new route in `server/src/routes/built-in-agents.ts` or a new `server/src/routes/assistant.ts`, `server/src/routes/openapi.ts` + openapi-routes test map, UI agent-list filters, tests.

**Interfaces — Produces:**
- Definition `assistant`: displayName "Assistant", defaultRole "general", defaultTitle "Assistant", `defaultAdapterType: "claude_local"`, `allowedAdapterTypes` = the local CLI adapters that support local agent JWTs (`claude_local`, `codex_local`, `cursor_local`, `gemini_local`, `grok_local`, `kimi_local`, `opencode_local`, `pi_local` — use their exact registry type strings), `defaultStatus: "idle"`, `defaultManager: null`, `defaultBudgetMonthlyCents: 0`, with a bundle whose instructions entry is `AGENTS.md`.
- Provisioning: `"assistant"` is added to `AUTO_PROVISION_ON_COMPANY_CREATE_KEYS`, and startup reconcile provisions it for existing companies. It ignores `enableBuiltInAgents` and `requireBoardApprovalForNewAgents` (it goes through `ensure`, never through an approval). Adapter: if the company already has a non-terminated agent with an allowed local adapter, copy that adapter type (existing `defaultProvisionInput` behaviour); otherwise `claude_local`.
- Helper `isAssistantAgent(agent: { metadata?: unknown }): boolean` in `@paperclipai/shared` (reads the `paperclipBuiltInAgent.key === "assistant"` marker) used by server and UI.
- `GET /api/companies/:companyId/assistant` (board only, company access): ensures the Assistant exists (provision if missing) and returns `{ agent: { id, name, urlKey, adapterType, status }, conversationIssueId: string | null }` where `conversationIssueId` is the caller's existing chat issue with the Assistant, if any.
- Exclusions: the Assistant is filtered out of the Agents page list, org chart data, `SidebarAgents`, assignee pickers (NewIssueDialog, issue properties), and agent mentions/autocomplete; server rejects assigning a non-conversation issue to it (400 "The Assistant can't be assigned tasks"). `company-signals` already excludes built-ins.

- [ ] Step 1: Failing tests: creating a company provisions exactly one Assistant (no approval created even when `requireBoardApprovalForNewAgents`); provisioning is idempotent; `GET /assistant` returns it; assigning a regular issue to it returns 400; `isAssistantAgent` unit tests; UI tests that the Agents list and SidebarAgents omit an Assistant-marked agent.
- [ ] Step 2: Implement definition, provisioning, route (+ OpenAPI), shared helper, server assignment guard, UI filters (find every agent-list consumer with `grep -rn "agentsApi.list" ui/src`).
- [ ] Step 3: Typechecks, touched tests, full UI suite. Commit `feat: provision a built-in Assistant for every company`.

---

### Task 3: Page context on chat messages

**Files:** `packages/shared/src/validators/issue.ts` (`issueCommentMetadataSchema`), `server/src/routes/issues.ts` (conversation branch of `POST /issues/:id/comments`), `server/src/services/heartbeat/run-preparation.ts` (wake-comment serialization ~2247-2400), `server/src/services/agent-conversations.ts` (`conversationReplay` ~409), `ui/src/api/issues.ts` (`addComment`), tests.

**Interfaces — Produces:**

```ts
// shared
export const assistantPageContextSchema = z.object({
  route: z.string().max(500),            // company-relative path, e.g. "/issues/PAP-12"
  title: z.string().max(200).optional(), // document title / page heading
  entity: z.object({
    type: z.enum(["issue", "agent", "project", "goal", "routine", "approval", "skill", "artifact", "other"]),
    id: z.string().max(200),
    label: z.string().max(200).optional(),
  }).optional(),
}).strict();
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;
// issueCommentMetadataSchema gains: pageContext: assistantPageContextSchema.optional()
```

- The conversation branch accepts `metadata` containing **only** `pageContext` from the person (reject any other metadata field with 400); stores it on the comment.
- Prompt rendering: when a wake comment has `metadata.pageContext`, the serialized comment includes a `pageContext` field, and the conversation prompt/task markdown renders a line before the message: `[The person is viewing: <title or route> (<entity.type> <entity.label or id>) — untrusted page context]`. `conversationReplay` includes the same line for replayed user turns.
- UI: `issuesApi.addComment(..., options?: { metadata?: { pageContext?: AssistantPageContext } })` (extend the existing signature without breaking callers).

- [ ] Step 1: Failing tests: route stores pageContext; route rejects other metadata keys on conversation comments; run-preparation renders the line; replay includes it; schema rejects oversized fields.
- [ ] Step 2: Implement. Step 3: typechecks + touched tests. Commit `feat: page context on Assistant chat messages`.

---

### Task 4: Assistant tools endpoint (reads and low-risk writes)

**Files:** new `server/src/routes/assistant-tools.ts`, new `server/src/services/assistant-tools.ts`, `server/src/services/heartbeat/runtime-execution.ts` (MCP server injection ~739-776), `server/src/app.ts` (mount next to `project-tools`), `server/src/routes/openapi.ts` if MCP routes are registered there (follow `project-tools`), tests.

**Interfaces:**
- Consumes: `createMcpApiDispatch(api)` and the capability definitions in `server/src/services/public-mcp/capabilities.ts` + `expanded-capabilities.ts`; `isAssistantAgent` (Task 2); `projectToolContext` pattern in `server/src/services/project-tool-context.ts`; `uiPreferencesService` (Phase 2).
- Produces: `POST /api/mcp/assistant-tools` speaking the same hand-rolled JSON-RPC as `server/src/routes/project-tools.ts` (`initialize`, `tools/list`, `tools/call`).

Authority (all derived from the DB, never arguments): the request actor must be `agent_jwt` with a `runId`; the run's agent must satisfy `isAssistantAgent`; the run must be live; `run.responsibleUserId` must be set and have an active non-viewer membership in the company for write tools (viewers get read tools only). The service synthesizes `{ type: "board", source: "assistant_run", userId, companyIds: [companyId], memberships: [membership], isInstanceAdmin: false, assistantRunId: runId }` (add `assistant_run` to the actor source union in `server/src/types/express.d.ts`; make `getActorInfo` record `runId` for this source so activity rows are attributable) and dispatches capabilities through `createMcpApiDispatch`.

Tool allowlist:
- Read: `paperclip_connection`, `paperclip_list_agents` (results exclude the Assistant), `paperclip_list_projects`, `paperclip_search_tasks`, `paperclip_read_task`, `paperclip_list_deliverables`, `paperclip_read_document`, `paperclip_list_document_revisions`, `paperclip_pending_approvals`, `paperclip_get_agent`, `paperclip_get_project`, `paperclip_list_skills`, `paperclip_get_skill`, plus new `staples_company_signals` (returns `companySignalsService.get`) and `staples_briefing_inputs` (pending approvals + open interactions awaiting this person + blocked tasks; reuse existing services, cap 20 each).
- Low-risk write: `paperclip_create_task`, `paperclip_add_comment`, `paperclip_update_task` restricted to title/description/status/priority/assignee/project/parent fields (reject anything else), new `staples_answer_question` (responds to an `ask_user_questions` interaction addressed to this person via the existing respond route), new `staples_pin_surface` (`{ surfaceId }` → ui-preferences `pin`, validated against `surfaceIdSchema`).
- Not exposed: `paperclip_call_api`, `paperclip_search_api`, every configure-scope capability, finish/block/delete, file transfer tools. Governed actions go through Task 5's `staples_propose_action`.

Injection: in `runtime-execution.ts`, when the agent `isAssistantAgent` and an `authToken` exists, unshift `{ name: "Staples assistant", url: \`${paperclipApiBaseUrl()}/api/mcp/assistant-tools\`, token: authToken, connectionId: "staples-assistant-tools" }`.

- [ ] Step 1: Failing tests (server, mocked dispatch where practical + one embedded-Postgres integration test): non-Assistant agent JWT → 403; missing responsible user → 403; viewer gets read tools only in `tools/list` and 403 on write `tools/call`; `paperclip_update_task` with a disallowed field → error; `staples_pin_surface` updates the person's preferences; dispatched actor is a board actor for the run's user (assert on a captured `req.actor`); activity row for a created task records the person and the run; injection adds the server only for Assistant runs.
- [ ] Step 2: Implement. Step 3: typechecks + touched tests. Commit `feat: person-scoped Assistant tools`.

---

### Task 5: Proposed actions (governed Confirm cards)

**Files:** `packages/shared/src/validators/issue.ts` (request_confirmation payload/result), `server/src/services/assistant-tools.ts` (new tool), `server/src/services/assistant-proposed-actions.ts` (allowlist + hashing), `server/src/routes/issues.ts` (create guard + accept handling), `ui/src/components/IssueThreadInteractionCard.tsx` (new card variant), `ui/src/pages/IssueDetail.tsx` (accept wiring) or the conversation surface's equivalent, `ui/src/api/issues.ts`, tests.

**Interfaces — Produces:**

```ts
// shared: request_confirmation payload gains (server-owned, rejected on direct create like toolAction)
proposedAction?: {
  version: 1;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;                 // must start with "/api/"
  body: unknown | null;         // JSON, ≤ 20KB serialized
  summary: string;              // human sentence shown on the card, ≤ 500
  category: "approval" | "agent_lifecycle" | "budget" | "secret" | "connection" | "outbound" | "delete" | "other_governed";
  hash: string;                 // sha256 of canonical JSON {method,path,body}
  staleCheck?: { path: string; field: "updatedAt"; expected: string }; // GET path whose updatedAt must still equal expected
}
// result gains
proposedAction?: { status: "executed" | "failed" | "stale"; httpStatus?: number; message?: string };
```

- Tool `staples_propose_action({ method, path, body, summary, category, staleCheck? })` on the assistant-tools endpoint: validates the path against a governed allowlist built from route patterns (approvals approve/reject/request-revision, agent create/terminate/pause/resume, budget policy create/update, company budget update, secrets create/update/delete, connection grants/OAuth, any DELETE under `/api/companies/:companyId/...` or `/api/issues/...` for this company), checks the path's company matches the run's company, computes the hash, and creates a `request_confirmation` interaction on the Assistant conversation issue addressed to the person, with `acceptLabel: "Confirm"`, `rejectLabel: "Cancel"`, `detailsMarkdown` showing method, path and a pretty-printed body.
- Accept: `POST .../interactions/:id/accept` for a `proposedAction` interaction requires a body `{ proposedActionResult: { status, httpStatus?, message?, hash } }`; the server checks `hash` equals the stored hash and the caller is the addressee, then records the result and wakes the Assistant (continuation) so it can continue the conversation. Reject works as today.
- UI card (`ProposedActionCard`): shows summary, category chip, method + path, collapsible body; **Confirm** → if `staleCheck`, GET it and compare `updatedAt` (mismatch → show "Changed since the Assistant proposed this" and require a second Confirm); then perform the call through the app's `api` client (person's session); then call accept with the result (executed/failed + http status + short message); show success/error inline. **Cancel** → reject.

- [ ] Step 1: Failing tests: shared schema; tool rejects non-allowlisted paths, other-company paths and oversized bodies; direct interaction create with `proposedAction` → 400; accept without/with wrong hash → 400; accept records result and wakes; UI card executes the call via the api client, reports executed/failed, stale flow requires second confirm, cancel rejects.
- [ ] Step 2: Implement. Step 3: typechecks + touched tests + full UI suite. Commit `feat: Assistant proposed actions with browser-executed confirmation`.

---

### Task 6: Assistant page, nav surface and dock

**Files:** new `ui/src/staples/assistant/{AssistantPage.tsx,AssistantDock.tsx,AssistantProvider.tsx,useAssistant.ts,pageContext.ts}` (+ tests), `ui/src/App.tsx` (route `assistant`), `ui/src/components/Layout.tsx` (mount dock + provider), `ui/src/hooks/useKeyboardShortcuts.ts`, `ui/src/components/KeyboardShortcutsCheatsheet.tsx`, `ui/src/staples/surfaces/registry.ts` (`nav.assistant`), `ui/src/components/MobileBottomNav.tsx`, `packages/shared/src/reserved-route-segments.ts` (`assistant` is already a board root — confirm).

**Interfaces — Produces:**
- `useAssistant()` → `{ agent, conversationIssueId, ensureConversation(): Promise<string>, loading }` backed by `GET /api/companies/:id/assistant` and the existing `agentChatsApi.ensure`.
- `AssistantPage` at `/:prefix/assistant`: full-page conversation, reusing the same conversation rendering as `ui/src/pages/AgentChat.tsx` (`TaskDetailSurface` with the `conversation` prop) bound to the Assistant agent.
- `AssistantDock`: a right-hand docked panel (its own host beside `PropertiesPanel`, width 400px, resizable if `ResizablePropertiesPanel` is reusable, full-screen sheet on mobile) rendering a compact conversation view of the same issue. If `TaskDetailSurface` can't render compactly, extract the thread + composer into a `ConversationThread` component used by both page and dock (document the choice).
- Page context: `currentPageContext()` derives `AssistantPageContext` from the router location (company-relative route), `document.title`, and the route params (issues → `{type:"issue", id: issueId}`, agents, projects, goals, routines, approvals, skills); messages sent from the dock or page attach it via Task 3's `metadata.pageContext`. The dock header shows "Seeing: <label>" with an × to drop context for the next message.
- Shortcut: Cmd/Ctrl+J toggles the dock from anywhere, including text inputs (register before the text-input guard; `preventDefault`); listed in the cheatsheet. Dock open state persists in localStorage (`staples:assistant-dock-open`, try/catch).
- `nav.assistant`: core surface, group `top`, label "Assistant", icon `Sparkles`, to `/assistant`, matchRoots `["assistant"]`, placed right after `nav.dashboard`. MobileBottomNav: Assistant replaces Chat in its slot.

- [ ] Step 1: Failing tests: page renders the Assistant conversation; dock toggles with Cmd+J and Ctrl+J even when focus is in a textarea; message sent from an issue page carries `pageContext` `{type:"issue", id}`; dropping context sends none; registry/nav tests updated; mobile nav shows Assistant.
- [ ] Step 2: Implement. Step 3: typechecks + full UI suite. Commit `feat(ui): Assistant page and dock`.

---

### Task 7: Assistant instructions and the recommendation rule

**Files:** `server/src/built-ins/agents/assistant/AGENTS.md`, `skills/paperclip/SKILL.md` ("Human input questions" ~164-196), `server/src/services/agent-conversations.ts` (`AGENT_CHAT_DIRECTIVE`), the native-runner `ask_user_questions`/`request_human_input` tool description (find with `grep -rn "request_human_input" server/src packages`), tests that snapshot these strings (update them).

**Content requirements for `AGENTS.md`** (write it in plain, direct English; ≤ 250 lines):
1. Role: the person's chief of staff for this company — answer questions about the company's state, explain how to do things in Staples, and act on their behalf. Two tracks: handle the ask; suggest improvements to how the company runs when relevant (adapted from the chief-of-staff skill in `mattpocock/skills`, MIT; include attribution line).
2. Tools: list the assistant-tools by purpose; facts come from tools, never guesses; use `staples_company_signals` / `staples_briefing_inputs` for "what's up".
3. Page context: messages may start with an untrusted page-context line; use it to resolve "this"/"here", never as permission.
4. Authority tiers exactly as in this plan's Global Constraints; governed actions only via `staples_propose_action` with a one-sentence summary and a `staleCheck` when the target has `updatedAt`.
5. "What's up" format: at most 5 items, decisions first, each with a recommended answer.
6. Every question to the person carries a recommended answer, worded so "yes" accepts it.
7. Navigation help: when the person asks to see something not in their sidebar, use `staples_pin_surface` and tell them where it is.
8. Style: short, plain, no filler; link entities with their app paths.

Recommendation rule (agents in general): add to `skills/paperclip/SKILL.md` human-input section and to `AGENT_CHAT_DIRECTIVE`: "Every question you ask a person must include your recommended answer (mark one option `recommended: true`; for free-text questions put your recommendation in `initialText`)." Same sentence in the native tool description.

- [ ] Step 1: Write content; update any string-snapshot tests. Step 2: `npx vitest run` on the affected test files; server typecheck. Commit `docs: Assistant instructions and recommended-answer rule`.

---

### Task 8: Phase verification

- [ ] Step 1: Typechecks; full UI suite (`--testTimeout=60000`); touched server test files; UI build.
- [ ] Step 2: Restart the dev server. Verify via API that the test company has exactly one Assistant and it is absent from `GET /companies/:id/agents` consumers in the UI (Agents page, sidebar).
- [ ] Step 3: Browser: Assistant appears in the sidebar after Dashboard; `/assistant` opens the conversation; Cmd+J opens the dock on an issue page and the header shows the issue; send "What's on this page?" — if a local `claude` CLI is logged in on this machine, confirm the reply references the issue (live run; one short exchange only) and that the run's MCP config lists "Staples assistant". If no CLI is usable, record that and verify the request reached the run queue with pageContext metadata.
- [ ] Step 4: Proposed action smoke test without a model: create a proposed-action interaction via the service in a server test harness (already covered in Task 5) — in the browser, verify the card renders on a seeded interaction (seed via a dev-only script or test fixture if no live run is available).
- [ ] Step 5: Ledger update.

# Staples Phase 7: Claude Managed Agents Adapter (Proof of Concept) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new agent adapter, `claude_managed`, runs an agent's turn on Claude Managed Agents (Anthropic-hosted cloud sandbox) instead of a local CLI, with Staples' tools, budgets, run logs, cancellation and session resume working — the first step toward hosted Staples with first-party inference.

**Architecture:** A new package `packages/adapters/claude-managed`, modeled on `packages/adapters/cursor-cloud` (remote vendor API + durable remote session id). A thin HTTP client talks to the Managed Agents beta API (`https://api.anthropic.com/v1`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: managed-agents-2026-04-01`). Per Staples agent the adapter upserts a Managed Agent definition (system prompt = rendered instructions; built-in toolset; Staples tools as **custom tools**) and creates or resumes a session in a cloud environment. Staples tools are **proxied**: the adapter lists tools from the run's runtime MCP servers (`ctx.runtimeMcp.getServers()`, run-scoped bearer tokens), registers them as custom tools, and answers `agent.custom_tool_use` events by calling the Staples MCP endpoint locally — so the sandbox never needs network access to Staples and no credentials leave the server. Usage (`session.usage.list_cost`) flows into Staples cost events and budgets; `user.interrupt` handles cancellation.

**Tech Stack:** TypeScript, Node fetch + SSE parsing, Vitest with a local fake Managed Agents server. No new runtime dependency unless `@anthropic-ai/sdk` already supports the beta and is already a workspace dependency.

Research: `/Users/kelliott/Metaplex/staples/.superpowers/sdd/2026-10-12-staples-managed-agents-poc-plan/research.md` (Staples adapter contract, file:line) and the API notes in `.superpowers/sdd/2026-10-12-staples-managed-agents-poc-plan/api-notes.md` (copied from the docs review). Decision record: hosted tier uses Managed Agents first (memory: staples-long-term-goals).

## Global Constraints

- Generic product; no company-specific content.
- Credentials: the API key comes from `adapterConfig.env.ANTHROPIC_API_KEY` (plain or company secret binding, resolved by the existing secrets path) or the server's `process.env.ANTHROPIC_API_KEY`. Never log or return the key; never send Staples run tokens to Anthropic (tools are proxied).
- All Managed Agents requests carry the beta header `managed-agents-2026-04-01`; base URL is configurable (`adapterConfig.apiBaseUrl`, default `https://api.anthropic.com/v1`) so tests point at a fake server.
- Budgets: the adapter reports numeric cost (`costUsd`, `costStatus: "reported"`, `billingType: "api"`, `provider`/`biller: "anthropic"`, model, tokens) incrementally via `onUsage` and in the final result; when the agent has a remaining budget, the session is created with a `budget.max_list_cost` cap.
- Cancellation: honor `ctx.signal`; call `onCancellationReady()` before remote work and `onDispatch()` before the first remote request; on abort send `user.interrupt` and return a settled result.
- Adapters must not run `git push` or rely on a git remote (packages/adapters/AUTHORING.md).
- Verify every API detail against the live docs (https://platform.claude.com/docs/en/managed-agents/*) before coding it; where the docs are silent, isolate the assumption in one function and note it.
- Commands: single test files only, `timeout 240` per command (a watchdog stops subagents after ~10 min without progress). Typecheck touched packages. Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths; never `git add -f` under `.superpowers/`.

---

### Task 1: Managed Agents client and fake server

**Files:** `packages/adapters/claude-managed/` (package.json, tsconfig, `src/client.ts`, `src/sse.ts`, `src/types.ts`, `src/testing/fake-managed-agents-server.ts`, tests), workspace wiring like cursor-cloud.

- [ ] `ManagedAgentsClient({ apiKey, baseUrl, fetch? })` with: `createAgent`, `updateAgent` (or new version), `getAgent`, `createEnvironment`/`getEnvironment` (verify the environments API in the docs), `createSession({ agent, environment_id, budget? })`, `getSession`, `sendEvents(sessionId, events)`, `streamEvents(sessionId, { signal })` (async iterable of typed events from SSE), `archiveSession`. Typed event union for `agent.message`, `agent.tool_use`, `agent.custom_tool_use`, `agent.mcp_tool_use`, `session.status_running`, `session.status_idle` (with stop_reason), `session.usage`, `session.error`; unknown events pass through as `{ type, raw }`.
- [ ] Errors: non-2xx → typed error with status + API error type, no key in messages; retries with backoff on 429/5xx (max 3) for non-streaming calls.
- [ ] Fake server (`node:http`) that records requests, validates required headers, and plays scripted SSE event sequences per session (including a custom tool call that waits for `user.custom_tool_result`, usage events, idle/budget stop, interrupt).
- [ ] Tests: headers present on every request; SSE parsing (multi-line data, keep-alives, reconnect not required); retry behavior; key never appears in thrown messages.

### Task 2: The adapter (execute, tools proxy, usage, cancel, resume)

**Files:** `packages/adapters/claude-managed/src/server/{execute,tools-proxy,session,test-environment,index}.ts` + tests (fake server end-to-end).

- [ ] Session codec storing `{ managedAgentId, managedAgentVersion, fingerprint, environmentId, sessionId }`; resume when the fingerprint (instructions + model + tool names + config) is unchanged and the session isn't archived/deleted; otherwise create a new agent version/session.
- [ ] Agent definition: name `Staples: <agent name>`, model from `adapterConfig.model` (default a current Claude model id per the docs), system = rendered instructions bundle, tools = built-in `agent_toolset_20260401` + custom tools from the proxy.
- [ ] Tools proxy: for each `ctx.runtimeMcp.getServers()` entry, JSON-RPC `tools/list` with its bearer token; register each as a custom tool named `<server-slug>__<tool>` (≤64 chars, sanitized) with its input schema; on `agent.custom_tool_use`, call `tools/call` on the right server and send `user.custom_tool_result` (errors returned as tool errors, not thrown). Cap result size (e.g. 100 KB, truncated with a note).
- [ ] Turn: send the wake/task prompt as `user.message`; stream events; map `agent.message` text and tool activity to `onLog` JSON lines the UI transcript understands (follow cursor-cloud's log line format) and `onEvent` run events; on `session.usage` compute cost from `list_cost` (US cents) and call `onUsage`; finish on `session.status_idle` (`end_turn` → success; `budget_reached` → result marked budget-stopped with a clear summary; `session.error` → failure with message).
- [ ] Budget cap: if the agent's remaining monthly budget is known in the run context, create the session with `budget: { type: "limit", max_list_cost: { amount, currency: "USD" } }`.
- [ ] Cancellation per Global Constraints; a cancelled run returns promptly and leaves the remote session idle (interrupted), not deleted.
- [ ] `testEnvironment`: checks key presence (without revealing it) and a cheap authenticated call (e.g. list agents with limit 1); maps 401/403/429/network to plain-language check codes.
- [ ] Tests (fake server): first run creates agent+environment+session and returns sessionParams; second run resumes the same session; changed instructions → new version; custom tool round trip hits a fake Staples MCP server with the run token and the token never reaches the fake Managed Agents server; usage → onUsage + final costUsd; budget_reached; session.error; cancellation mid-stream sends `user.interrupt`.

### Task 3: Staples registration, config UI and docs

**Files:** per research §8: `packages/shared/src/constants.ts` (`AGENT_ADAPTER_TYPES`), `server/src/adapters/registry.ts` + `builtin-adapter-types.ts`, session management lists (`packages/adapter-utils/src/session-compaction.ts`), `server/src/services/agent-identity.ts` (supportsManagedAgentIdentity if applicable), `supportsLocalAgentJwt: true` so run-scoped MCP servers exist, UI adapter module + display registry + icon + credential field (`ui/src/adapters/*`, `AdapterMark.tsx`, `agent-setup-fields.ts`), package.json workspace deps (server, ui, cli), release manifest, `doc/adapters/claude-managed.md`.

- [ ] Config fields: API key (secret binding, like other adapters' key fields), model, optional environment id, optional API base URL (advanced).
- [ ] The adapter appears in agent creation/config as "Claude (hosted)" with a short description: "Runs in Anthropic's cloud sandbox. Uses your Anthropic API key; billed per use."
- [ ] Not added to the Assistant's runtime list yet (PoC).
- [ ] Tests: registry lists it; config form renders fields; adapter display; existing registry/OpenAPI/telemetry allowlist tests updated.

### Task 4: Live smoke script and verification

- [ ] `packages/adapters/claude-managed/scripts/smoke.ts` (+ package script `smoke`): reads `ANTHROPIC_API_KEY` from the environment, creates a throwaway agent/environment/session, runs one turn that calls one proxied custom tool served by an in-process fake Staples MCP server, prints events, cost and the session id, then archives the session. Exits non-zero with a plain message when the key is missing. Documented in `doc/adapters/claude-managed.md` ("Run the live smoke test").
- [ ] Verification: typecheck; adapter package tests; server registry/OpenAPI tests touched; UI tests touched; `pnpm check:token-gates`.
- [ ] The person runs the live smoke test with their own key (the controller never handles API keys).

# Staples Phase 8: Hosted Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The built-in Assistant can run on `claude_managed` (Claude hosted on Anthropic Managed Agents). When the operator provides a server-level `ANTHROPIC_API_KEY` ("hosted inference"), a brand-new company's Assistant works immediately with no model setup; otherwise a person can pick "Claude (hosted)" on the setup card and enter their own API key.

**Architecture:** (1) The adapter delivers Staples skills natively by uploading each runtime skill as a Managed Agents custom skill (`POST /v1/skills`, deduplicated by content hash) and attaching it to the agent definition, and returns the full final message as the run summary so chat replies aren't truncated. (2) The server adds `claude_managed` to the Assistant's runtime allowlists and conversation adapter types, teaches Assistant setup about an API-key-based adapter, and — when the hosted key is present — provisions new Assistants on `claude_managed` by default. A single helper reports `hostedInferenceAvailable` (never the key) to health, GET /assistant and the adapters endpoint. (3) The setup card shows a "Claude (hosted)" option (hidden when hosted inference is already available).

**Tech Stack:** TypeScript, Express + Drizzle, React 19 + TanStack Query, Vitest.

Research: `.superpowers/sdd/2026-10-12-staples-hosted-assistant-plan/research.md` (file:line for every touchpoint) and `.superpowers/sdd/2026-10-12-staples-managed-agents-poc-plan/api-notes.md` (Managed Agents API). Skills API: agent `skills: [{type:"custom", skill_id, version}]`; upload `POST /v1/skills` multipart (SKILL.md + files) → `skill_*` id + `latest_version_id`; 500 skills/session; https://platform.claude.com/docs/en/managed-agents/skills (verify exact shapes before coding).

## Global Constraints

- Never store, log, return or render the server's `ANTHROPIC_API_KEY`; expose only a boolean. The hosted default uses the default API base URL (the adapter only uses the server key with the default URL).
- A person's own key (setup card) is stored as a company secret binding, the same way other adapter keys are; never in plain adapterConfig.
- Existing Assistants keep their adapter (no silent migration).
- Assistant security model unchanged (tools proxied, run-scoped tokens stay on the server, governed proposals).
- Bump the Assistant bundle `stockVersion` if its AGENTS.md or bundled skills change (currently "2026-10-12a").
- Token-only UI; `pnpm check:token-gates` after UI changes.
- Subagent watchdog: never run a single command longer than 4 minutes (`timeout 240`); single test files; `-t` while iterating. Never read `.env.local` or any key. Commit after each task with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; explicit `git add` paths; never `git add -f` under `.superpowers/`.

---

### Task 1: Adapter — native skills and full replies

**Files:** `packages/adapters/claude-managed/src/{client.ts,types.ts}`, `src/server/{execute.ts,skills.ts (new),index.ts}`, fake server, tests, `scripts/smoke.ts` (new `skills` scenario), docs.

- [ ] Client: `uploadSkill({ displayTitle, files })` (multipart: SKILL.md + supporting files), `listSkills({ limit, after })`, `getSkill(id)`; verify shapes against the live docs first.
- [ ] Skills sync: read `config.paperclipRuntimeSkills` entries (same reader claude_local uses: `readPaperclipRuntimeSkillEntries` in packages/adapter-utils) — each entry's source dir → files (SKILL.md + references/, capped e.g. 2 MB per skill, text files only). Content hash per skill; display title `staples-<runtimeName>-<hash8>`. Reuse an existing uploaded skill whose title/metadata matches the hash (list once per run, cached in-process by hash); otherwise upload. Attach `{ type: "custom", skill_id, version: <pinned version id> }` to the agent definition. Skill set is part of the agent fingerprint → new agent version when skills change (tools-only update path unchanged).
- [ ] Fallback: if the skills API refuses (unsupported/forbidden), append a skills manifest + SKILL.md bodies to the system prompt (bounded, e.g. 60 KB total, truncation note) and log a warning once.
- [ ] `listSkills`/`syncSkills` adapter hooks if the registry needs them (mirror cursor-cloud/claude-local minimal stubs).
- [ ] Summary: result `summary` = the full final assistant message text (not first line); keep a short `summaryPreview` if the UI needs one. Test with a multi-line reply.
- [ ] Tests (fake server gains `/v1/skills`): first run uploads, second run reuses (no re-upload), changed SKILL.md uploads a new skill and bumps the agent version, refusal → prompt fallback, summary is full text.
- [ ] Smoke `skills` scenario: upload one tiny test skill that instructs the agent to answer a code word; assert the agent uses it.

### Task 2: Server — Assistant on claude_managed + hosted default

**Files (research §1, §2, §4, §6):** `server/src/services/assistant-identity.ts`, `ui/src/api/assistant.ts` (allowlist mirror only), `server/src/services/conversation-continuation.ts` (CONVERSATION_ADAPTER_TYPES), `server/src/services/assistant-setup.ts`, `server/src/services/built-in-agents.ts` (`defaultProvisionInput`, assistant definition `allowedAdapterTypes`), `server/src/routes/{health,assistant,agents}.ts`, new `server/src/services/hosted-inference.ts`, tests.

- [ ] `hostedInference()` helper: `{ available: boolean, adapterType: "claude_managed", model: "claude-opus-5-5" }` from `process.env.ANTHROPIC_API_KEY` presence (and an opt-out env `STAPLES_HOSTED_INFERENCE=off`). Health and GET /assistant include `hostedInferenceAvailable`.
- [ ] Allowlists: add `claude_managed` to ASSISTANT_RUNTIME_ADAPTER_TYPES (+ UI mirror) and CONVERSATION_ADAPTER_TYPES; update dependent tests.
- [ ] Provisioning: when hosted inference is available and no Assistant exists yet, `defaultProvisionInput` chooses `claude_managed` with `{ model }` (complete config without any key) — precedence over sibling inheritance. Existing Assistants untouched.
- [ ] Assistant setup: adapters endpoint lists `claude_managed` with availability = hosted available OR the company has a usable Anthropic key secret; no CLI command lookup for it; setup accepts `{ adapterType: "claude_managed", model?, apiKeySecretId? | apiKey? }` where a plain key is stored as a company secret (reuse the existing secret-creation path used by other adapters' key fields) and bound into `adapterConfig.env.ANTHROPIC_API_KEY`; `claude_managed_api_key_missing` / `claude_managed_auth_invalid` map to needs_model with plain reasons ("Add an Anthropic API key to use Claude (hosted)." / "That Anthropic API key was rejected.").
- [ ] Verification: harness verification passes via the adapter's testEnvironment (no hello probe) — add a test.
- [ ] Tests: hosted present → new company Assistant is claude_managed and `lifecycle` reaches ready with the fake adapter env; absent → claude_local as before; setup with a key stores a secret binding (key never in responses/activity); allowlists.

### Task 3: UI — setup card and hosted signal

**Files:** `ui/src/staples/assistant/{AssistantSetupCard.tsx,setup-reasons.ts,StageZeroShell.tsx}`, `ui/src/api/{health.ts,assistant.ts}`, tests.

- [ ] When `hostedInferenceAvailable` and the Assistant is ready, stage 0 shows no setup card (chat works immediately).
- [ ] Otherwise the card adds a "Claude (hosted)" tile: "Runs in Anthropic's cloud. Needs an Anthropic API key." Selecting it shows a password field + "Connect" (calls setup with the key; the field clears after submit; errors inline). Tiles for local CLIs unchanged.
- [ ] setup-reasons: labels/copy for claude_managed codes.
- [ ] Tests: hosted available → no card; tile flow submits once, never echoes the key, shows errors.

### Task 4: Live verification

- [ ] Controller: start the dev server with the hosted key in the server environment (launch config that sources `.env.local` without printing it), create a fresh company via `/start`, confirm the Assistant is `claude_managed` and ready, send "Set up a Researcher" on the Assistant chat, and confirm a real reply that uses Staples tools (template tools/questions). Screenshots to `tmp/screenshots/phase8/`.
- [ ] Run `smoke --scenario skills` live.
- [ ] Typecheck, touched tests, UI build, token gates; ledger.

---

### Task 5: Hosted hires with caps, and a persisted run-token secret (added after live verification)

Decisions (2026-10-12, person): hosted hires use the operator key with caps; auto-generate the run-token signing secret.

- [ ] **Hosted hires.** When hosted inference is available:
  - `claude_managed` becomes a proposable hire adapter (PROPOSABLE_HIRE_ADAPTER_TYPES, plan validator, plan skill/AGENTS.md guidance, templates' `recommendedAdapterType` resolution) and the default for plan hires that don't specify one (`{ adapterType: "claude_managed", adapterConfig: { model } }`).
  - The server key may be used by any `claude_managed` agent in the company that has no own key, but only after the server ensures (idempotently, at point of use, like the Assistant) an active agent-scope monthly hard-stop policy (default `STAPLES_HOSTED_AGENT_BUDGET_CENTS` = 2000) AND an active company-scope monthly hard-stop policy (default `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` = 5000; never lowers an existing operator/person-set company budget; explicit env 0 = uncapped). Ensure failure → server key withheld. `STAPLES_HOSTED_INFERENCE_ALL_AGENTS` is retired (remove; document).
  - Agents with their own key binding never use the server key and get no forced caps.
  - Tests: plan with a templated hire in hosted mode → hire is claude_managed + model, policies exist before first run; company cap respected; own-key hire unaffected; non-hosted mode unchanged (claude_managed not proposable without hosted unless the company has a key — keep today's behavior).
  - Bump the Assistant `stockVersion` if AGENTS.md/skills change.
- [ ] **Run-token secret.** On server start, if neither `PAPERCLIP_AGENT_JWT_SECRET` nor `BETTER_AUTH_SECRET` is set, read `<instance data dir>/secrets/agent-jwt-secret` or generate 32 random bytes (hex) into it (mode 0600, directory 0700), set `process.env.PAPERCLIP_AGENT_JWT_SECRET`, and log once that a local secret was generated (never the value). Configured secrets always win. Tests with a temp data dir: generated once, reused on restart, not overwriting env, file permissions.
- [ ] Live: restart the hosted dev server WITHOUT the launch-config secret, confirm tools work, and complete "Set up a Researcher" end to end (plan card → Researcher hired on claude_managed with caps → its first run uses the Researcher skills).

# Claude (hosted) adapter (`claude_managed`)

Status: proof of concept (2026-10-12). **The full [live smoke suite](#live-smoke-test)
(`--scenario all`) passed against the Managed Agents API on 2026-10-12**, $0.48
total: basic run, resume across runs (same session, per-run cost deltas sum to
the session total), cancellation (acknowledged, provider stopped, session idle),
a $0.01 budget cap (stopped with `budget_reached`), tool errors, a truncated
~250 KB tool result, two tools on two MCP servers, limited networking
(allowed host fetched, other host blocked), `claude-sonnet-5-5` and
`claude-haiku-5-5`, and the connection test.

Cost granularity: the API reports session cost in whole cents, so a single small
run can show $0.00 while the next shows the rounded-up cent; per-run deltas
always sum to the session's total.

## What it is

`claude_managed` runs an agent in Anthropic's cloud sandbox through the Claude
Managed Agents API (beta header `managed-agents-2026-04-01`). Nothing runs on the
Staples host except the adapter itself: Anthropic hosts the model, the agent
loop and a sandbox with a shell, files and web access.

In the UI it appears as **Claude (hosted)**: "Runs in Anthropic's cloud sandbox.
Uses your Anthropic API key; billed per use."

Per run, the adapter:

1. Lists the run's Staples tools (project tools, runtime tools, connected tool
   gateways) from the run-scoped MCP servers.
2. Creates or reuses a Managed Agents environment, agent and session. The
   session id is stored as the task session, so later heartbeats on the same
   task continue the same conversation.
3. Sends the heartbeat prompt as a `user.message` and streams the session's
   events into the run log as `claude_managed.*` JSON lines, which the run
   transcript UI and the CLI render.
4. Answers the agent's Staples tool calls (see the security model) and reports
   cost and tokens as they arrive.

Package: `packages/adapters/claude-managed`.

## Configuration

| Field | Where | Notes |
| --- | --- | --- |
| `env.ANTHROPIC_API_KEY` | Agent setup credential field, or Environment variables | A company secret binding (recommended) or a plain value. When empty, and only when `apiBaseUrl` is the default: with hosted inference on, the server's `STAPLES_HOSTED_ANTHROPIC_API_KEY` is used under hard-stop monthly caps the server sets first (see [Hosted inference](#hosted-inference)); with hosted inference off, the server's plain `ANTHROPIC_API_KEY` is used with no forced caps (the behaviour before hosted inference). |
| `model` | Model picker | Default `claude-opus-5-5`. Any Managed Agents model id can be typed. |
| `environmentId` | Configuration | Optional. An existing Managed Agents environment. When empty, Staples creates one per agent. |
| `instructionsFilePath` | Instructions | Used as the agent's system prompt. |
| `apiBaseUrl` | Advanced | Default `https://api.anthropic.com/v1`. Tests point it at a fake server. A custom URL requires the agent's own `env.ANTHROPIC_API_KEY`. |
| `inactivityTimeoutSec` | Advanced | Default `900` (15 minutes). A run with no session events for this long fails and interrupts the session. |
| `networkingMode` | Advanced | `unrestricted` (default) or `limited`. |
| `networkAllowedHosts` | Advanced, when limited | Hosts the sandbox may reach, one per line. |
| `networkAllowPackageManagers` | Advanced, when limited | Also allow package registries (npm, PyPI, ...). |

The connection test (**Test** in agent setup) checks that a key is present and
calls `GET /v1/agents?limit=1`; it never echoes the key.

## Hosted inference

Hosted inference is turned on only by a dedicated server variable,
`STAPLES_HOSTED_ANTHROPIC_API_KEY` (and `STAPLES_HOSTED_INFERENCE` not set to
`off`). A plain `ANTHROPIC_API_KEY` in the server environment never turns it on:
many local users export that variable for other tools, and it does not change
Assistant provisioning, hire defaults, setup-card availability or
`hostedInferenceAvailable`.

When hosted inference is on, new companies' Assistants run on Claude (hosted)
with no setup, and the Assistant may hire staff agents on Claude (hosted) too.
In such a company plan hires default to `claude_managed` with the Assistant's
model, and template recommendations resolve to it. Without hosted inference,
`claude_managed` is proposable for hires only when the company's Assistant runs
on it with its own key (a company secret); the hires then inherit that key
binding.

Which server key a `claude_managed` agent without its own key uses:

| Server env | Key used | Caps |
| --- | --- | --- |
| `STAPLES_HOSTED_ANTHROPIC_API_KEY` set, hosted inference on | The hosted key, once the server allows it for the run | Hard-stop monthly caps (below), ensured first; if they cannot be set, no key is used |
| No hosted key, or `STAPLES_HOSTED_INFERENCE=off` | The server's plain `ANTHROPIC_API_KEY`, if set | None forced (the behaviour before hosted inference) |

`STAPLES_HOSTED_INFERENCE=off` disables only the hosted key path. Either server
key is sent only to the default API base URL, and neither is ever logged or
returned.

The hosted key pays for every agent that uses it, so before its first use (at
hire, and again at every run and connection test) the server ensures active
hard-stop monthly budget policies:

| Scope | Metric | Env var | Default |
| --- | --- | --- | --- |
| The Assistant | `billed_cents` | `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS` | `2000` ($20) |
| Any other agent on hosted inference | `billed_cents` | `STAPLES_HOSTED_AGENT_BUDGET_CENTS` | `2000` ($20) |
| The company's hosted spend | `hosted_billed_cents` | `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` | `5000` ($50) |
| Ceiling for a plan's raise of the company's hosted cap | — | `STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS` | `20000` ($200) |

Each value is an integer number of cents; an explicit `0` leaves that scope
uncapped, and an invalid value uses the default. An existing active hard-stop
policy is kept at its amount (an existing hosted company cap is never lowered);
a disabled, soft or zeroed one is re-activated as a hard stop. The server
records these policy writes in the activity log with a system actor
(`hosted_inference`). Agents with their own key binding never use the server
key and get no forced caps.

An agent's cap amount comes only from a person or the operator: a hire from
a confirmed plan gets the plan's monthly budget as its hard-stop cap (at most
the ceiling below, written with the system actor), a person can change it on
the agent's budget, and otherwise the agent default applies. The agent's own
`budgetMonthlyCents` field is never read for a hosted cap. An agent may not
change any agent's monthly budget (`PATCH /agents/:id` refuses it), and an
agent creating a hosted agent cannot give it a cap above the agent default.

**Plans raise the company cap to fit their hosted hires.** When an applied
plan hires agents on the hosted key (Claude (hosted) with no key of its own,
hosted inference on), the server raises the company's `hosted_billed_cents`
cap to at least the monthly budgets of every agent on the hosted key (the
Assistant included; an agent without a budget counts the default above), at
most `STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS`. It only ever raises: a cap
already high enough, or already above the ceiling, is kept. When the budgets
come to more than the ceiling, the cap is raised to the ceiling and the plan
card and the apply result (`hostedLimit`, with `limited: true`) say so.
An explicit `STAPLES_HOSTED_COMPANY_BUDGET_CENTS=0` (uncapped) is never raised
or changed, and the card then says nothing about the hosted limit; a ceiling
of `0` means plans never raise the cap. Hires on a local adapter or on the
company's own key never raise it. Each agent counts its agent cap (above), at
most the ceiling; hires still awaiting approval do not count until a person
approves them, and approving a hosted hire raises the cap then by the same
rules. If the raise fails (a database error), the plan is still applied and
the result says so (`hostedLimit: { failed: true, fromCents }`): the limit stays
where it was. The raise is logged like the other hosted
policy writes (`budget.policy_upserted`, system actor `hosted_inference`).
Before the person confirms, the plan card shows the hires' monthly budgets and
whether they fit the hosted limit or raise it (server-computed `planBudget`
on the proposal).

**The company cap counts hosted spend only.** Cost events of a run that used
the hosted key are marked (`cost_events.hosted_inference`), and the
`hosted_billed_cents` policy counts only those. A company with local agents
and their past spend gets the hosted cap like any other, and local spend never
counts toward it. When the cap is reached, only runs that would use the hosted
key are refused ("This company reached its monthly spending cap for hosted
inference ..."); the company is not paused, and local agents keep working. A
person-set company budget (`billed_cents`) keeps its meaning: it counts all
spend and pauses the company as before, and the hosted cap never changes it.

`STAPLES_HOSTED_INFERENCE_ALL_AGENTS` is retired: every `claude_managed` agent
without its own key may use hosted inference, always under the caps above.

## Security model

- **Tools are proxied.** Staples tools are declared to Managed Agents as custom
  tools. When the agent calls one, the session pauses; the adapter, running on
  the Staples host, calls the Staples MCP server with the run's token and sends
  the result back as `user.custom_tool_result`.
- **No Staples credentials in the sandbox.** The run JWT and gateway tokens stay
  on the host. They are never sent to Anthropic, never written to the run log,
  and never put in the sandbox environment. The adapter registers with
  `supportsLocalAgentJwt: true` only so the host-side proxy can authenticate to
  the project-tools and runtime-tools MCP servers.
- **Because tools are called from the host,** `PAPERCLIP_API_URL` does not need
  to be reachable from the internet for this adapter.
- **The Anthropic API key** is resolved through the normal secrets path, sent
  only to the configured API base URL, and never logged or returned. The
  hosted key (`STAPLES_HOSTED_ANTHROPIC_API_KEY`) is granted by the server per
  run, never from agent config: any `claude_managed` agent without its own key
  may use it, but only after the server has ensured its hard-stop monthly caps
  (see [Hosted inference](#hosted-inference)). If a cap cannot be set, the key
  is withheld, and the plain `ANTHROPIC_API_KEY` is not used in its place.
  Without hosted inference the plain `ANTHROPIC_API_KEY` fallback works as it
  did before hosted inference existed. Either server key is used only with the
  default base URL (`https://api.anthropic.com/v1`). `apiBaseUrl` is per-agent
  config, so an agent with a custom base URL must carry its own key; otherwise a
  board user could point an agent at their own host and capture a server key.
  The run and the connection test fail with a message that says so.
- **Tool results are scrubbed.** The run token is redacted from tool results
  (successful and failed) before they are sent to Anthropic, in case a tool
  echoes its request headers.
- **Resource ownership.** Managed Agents agents, environments and sessions carry
  metadata `staples_agent_id`, `staples_company_id` and `staples_instance_id`.
  The instance id is `PAPERCLIP_INSTANCE_ID` (default `default`). The adapter
  uses an existing resource only when all three match:
  - adoption (a new task picking up the agent's existing agent or environment)
    filters on them;
  - ids stored in the task session (`sessionParams`) are re-checked after they
    are fetched; a stored environment, agent or session owned by someone else is
    treated as not found, so the adapter adopts or creates its own and never
    resumes, updates or interrupts the other one.

  A worktree or fork instance that copied the database (same company, agent and
  stored session ids) therefore creates its own resources rather than driving
  the original instance's. The one exception is an operator-configured
  **Environment ID**, which is used as given.

### Networking

The default is **unrestricted** egress, set explicitly when Staples creates the
environment. Under `limited` networking the allowed-hosts list also gates the
built-in web search and web fetch tools, so an empty list leaves them with
nothing to reach. A generic agent cannot list the sites it will need in advance.
This default is acceptable because the sandbox holds no Staples credentials.

To limit egress, set **Sandbox networking** to *Limited to allowed hosts* and
list the hosts, for example `api.github.com`. Turn on **Allow package
registries** if the agent installs packages. A changed networking setting
creates a new environment and therefore a new session. MCP server egress stays
off: the adapter declares no MCP servers on the agent.

Networking settings apply only to environments Staples creates. When
**Environment ID** is set, that environment's own networking is used.

## Budgets and cost

- Each run reports `costUsd` from Anthropic's `session.usage` list cost (the
  change for this run, not the session total), with `costStatus: "reported"`,
  `billingType: "api"` and provider/biller `anthropic`. Usage is reported
  incrementally while the run is in progress, so budget hard stops see spend as
  it happens.
- **Per-session spending limit.** The server sets
  `context.paperclipBudgetRemainingUsd` for every run to the smallest remaining
  amount of the run's active hard-stop policies: the agent's, its project's and
  its company's `billed_cents` policies, plus the hosted company cap when the
  run uses the hosted key (at least one cent; absent when no hard-stop policy
  applies; a value in the wake context is ignored). The adapter sends it as the
  session's `budget.max_list_cost`: a new session is capped at it, and a resumed
  session's cap is moved to its spend so far plus that amount (if the API
  refuses the change, the run starts a new session instead). The session then
  stops with `budget_reached` and the run fails with
  `errorCode: "budget_reached"`. Concurrent runs each get the full remaining
  amount, so together they can still overshoot it by up to one run's cap.
- **Out of credit.** When Anthropic reports that the account cannot pay (HTTP
  402, a `billing_error`, or a "credit balance is too low" message, on an API
  call or a `session.error`), the run fails with
  `errorCode: "claude_managed_out_of_credit"`, the non-retryable
  `configuration` error family and the message "Needs attention: the Anthropic
  account is out of credit ...". It is not retried.

## Skills and replies

- **Skills.** The agent's enabled skills (the server-resolved
  `paperclipRuntimeSkills` entries selected by its desired-skills preference)
  are uploaded to the Anthropic workspace as custom skills through the Skills
  API (`POST /v1/skills`, multipart `files[]` + `display_name`) and attached to
  the Managed Agents agent with a pinned version id
  (`{ type: "custom", skill_id, version }`). Each upload holds `SKILL.md` and the
  skill's other text files (binaries and dotfiles are skipped; 2 MB and 200
  files per skill). The display name is `staples-<runtimeName>-<sha256>`, with
  the full 64-character hash over every file, so identical content is reused:
  the adapter lists the workspace's custom skills once per server process and
  reuses an exact title match, otherwise it uploads. The full hash matters
  because every company on the hosted key shares one workspace: a short prefix
  could be brute-forced so that another company's agent attaches crafted
  content. Skills uploaded under the earlier 8-character titles are not reused;
  each is uploaded once more under its new title. Old skill versions are never
  deleted.
- **Skills change the agent.** The pinned skill set is part of the agent
  fingerprint, so a changed skill creates a new agent version and the next run
  starts a new session. Tool-only changes still update the session in place.
- **Fallback.** When the Skills API refuses (403 or 404/405/501 on any call, or a
  400 on the listing call saying the feature or beta is not enabled), runs inline
  the skills into the system prompt instead (a manifest plus each `SKILL.md`
  body, bounded to 60 KB with a truncation note). The refusal is remembered for
  10 minutes per API key and the warning is logged once per refusal window. An
  upload rejected with 400/413/422 (for example a `SKILL.md` frontmatter `name`
  with a reserved word) inlines only that skill.
- **Stale skill cache.** If the agent API rejects a cached skill id (it was
  deleted in the Console), the adapter forgets its listing, re-syncs the skills
  and retries the agent write once.
  Server errors, rate limits and auth failures fail the run
  (`claude_managed_skills_failed`) instead of switching modes.
- **Library manifest.** Like `claude_local`, the system prompt lists the company
  skill library and marks which skills are enabled for this agent.
- **Full replies.** The run `summary` (and `resultJson.summary`) is the full final
  assistant message, so conversation replies are posted whole;
  `resultJson.summaryPreview` holds a one-line preview.

## Limitations

- **Session caps are per run, not shared.** The server passes the remaining
  budget (see [Budgets and cost](#budgets-and-cost)) and each session is capped
  at it, but concurrent runs each get the whole remaining amount, and a hosted
  company cap that is reached refuses new hosted runs without cancelling ones
  already running. Updating a resumed session's cap is not yet verified against
  the live API; if it is refused, the run starts a new session.
- **Model and instructions are fixed per session.** Changing the model or the
  instructions starts a new session (the conversation does not carry over).
  Tool changes are applied to the existing session in place.
- **Stuck runs time out.** A run fails (`claude_managed_inactive`) and
  interrupts its session after `inactivityTimeoutSec` (default 15 minutes)
  without a session event. A `requires_action` stop that names events other
  than this run's Staples tool calls (for example a built-in tool confirmation,
  if a permission policy ever asks for one) fails the run at once
  (`claude_managed_unsupported_action`) and interrupts the session, rather than
  waiting forever.
- **No stream reconnect.** If the event stream drops, the run fails as a
  transient upstream error, the session is interrupted, and the next run resumes
  it.
- **Instructions bundle files.** Only the instructions file's text is sent;
  relative file references in an instructions bundle cannot be resolved in the
  sandbox.
- **No workspace sync.** The sandbox does not see the Staples project
  workspace; the agent works through Staples tools and its own sandbox files.
- **Unsettled sessions are abandoned.** If a previous session can't be settled, it's
  interrupted and archived on a best-effort basis; any spend it incurs after that
  isn't attributed to a Staples run or budget.
- **Sessions rotated by host compaction are left idle.** When the host's session
  compaction rotates a task to a new session, the old Managed Agents session is
  left idle on Anthropic; it is not archived. It costs nothing while idle, but it
  stays listed in the Console until you archive it.
- **Resumed-session cost baseline (unverified).** A resumed run bills the change
  in the session's `list_cost` since the session resource was read at the start.
  If the API's session resource omits cost totals, resumed sessions may
  double-count; verify with the smoke test's `resume` scenario.
- **Budget-capped sessions are kept.** A session that stopped with
  `budget_reached` is kept. The next run on that task raises the session's cap
  to its spend plus the new remaining budget (or starts a new session if the
  API refuses), so it continues once the budget allows.
- **Not offered as the Assistant's runtime** during the proof of concept.
- **Not published to npm** yet (`publishFromCi: false` in the release manifest).

## Live smoke test

A script that runs the real adapter against your own Anthropic account:

```sh
export ANTHROPIC_API_KEY=...        # your key; never commit it
pnpm --filter @paperclipai/adapter-claude-managed smoke                       # basic only
pnpm --filter @paperclipai/adapter-claude-managed smoke --scenario all --json # every scenario
```

Optional: `MANAGED_AGENTS_MODEL` (default is the adapter's default model),
`MANAGED_AGENTS_BASE_URL`, and `MANAGED_AGENTS_MODELS` (comma list for the
`models` scenario; default `claude-sonnet-5-5,claude-haiku-5-5`). Without a key
the script exits 1 and tells you to set one.

`--scenario <name>` is repeatable and accepts comma lists and `all`; the default
is `basic`. Each scenario calls `execute()` with a minimal run context and
in-process fake Staples MCP servers, prints a compact transcript, its own
`PASS`/`FAIL` (or `INFO`) line, a cost line and its session, agent and
environment ids, and archives every session it started:

| Scenario | What it checks |
| --- | --- |
| `basic` | One turn; the agent calls `echo_note` once through the tools proxy. |
| `resume` | Two runs with the same `runtime.sessionParams`. The second run must resume the same session (`resumed true` on init), repeat the note from the first run, and report a per-run cost delta (at most the session total from `getSession` minus the first run's cost, plus one cent; never the cumulative total). Prints both runs' cost and the session total. |
| `cancel` | A long multi-step task, aborted after the first tool call (or 8s). The result must have `exitCode` null, `errorCode` `cancelled`, `resultJson.executionCancellation.state` `acknowledged`, and `executionRecovery` when the session was seen going idle; `getSession` must then show `idle`. |
| `budget` | `context.paperclipBudgetRemainingUsd` = 0.01. The session must be created with a spending cap (printed) and the run must stop with `budget_reached` (`exitCode` 1, `errorCode` `budget_reached`). The API may overshoot the cap by about one request; the script prints the session total. |
| `tool-error` | The MCP tool returns an error result (`isError: true`); the agent must get an error tool result and the run must still complete. |
| `big-result` | The MCP tool returns about 250 KB of text; the adapter must truncate it, the agent must report the truncation note, and the run must complete. |
| `multi-tool` | Two tools on two MCP servers; both must be called and mapped back to the right server and tool name. |
| `networking-limited` | Limited networking with `allowedHosts: ["example.com"]`; the agent web-fetches example.com and wikipedia.org. Informational: `PASS` when example.com worked and wikipedia.org was blocked, otherwise `INFO`; the observations are printed either way. Creates a second environment (different networking fingerprint). |
| `models` | `basic` once per model in `MANAGED_AGENTS_MODELS`, each as its own agent sharing the default environment. Per-model `PASS`/`FAIL`; a model the API refuses before a session starts prints the API error type and makes the scenario `INFO`, not `FAIL`. |
| `test-environment` | Calls the adapter's `testEnvironment()` with the key and prints the check codes (never the key). |
| `skills` | Writes a tiny runtime skill (`staples-smoke-codeword`: "When asked for the Staples code word, answer BANANA-7") and runs its own agent (`smoke-agent-skills`) with it enabled. `PASS` when the reply contains `BANANA-7`; prints whether the agent reports the skill attached (0 means it was inlined on fallback). Leaves the uploaded skill in the workspace (later runs reuse it). |

At the end the script prints a summary table and the cumulative cost;
`--json` also prints a machine-readable summary (scenario to status, message,
cost and ids, plus the total). The exit code is 0 when every scenario is `PASS`
or `INFO`.

Safety: session ids are printed as soon as sessions start, so they are known even
if the process is killed. Each scenario is cancelled after 5 minutes
(`SMOKE_TIMEOUT_MS` overrides it). Ctrl-C cancels the current scenario (the
adapter interrupts the session), still archives its sessions, and skips the
remaining scenarios; press Ctrl-C twice to exit at once without cleanup (the
script prints the session ids to archive by hand).

Cost: `basic` is a few cents. `--scenario all` costs about $0.50 in total and
creates up to 2 environments (default and limited networking) and 3 agents (one
per model: the default plus the two in `MANAGED_AGENTS_MODELS`).

Cleanup: sessions are archived automatically. Agents and environments are kept
(the adapter reuses them on later runs); the script prints their ids so you can
archive or delete them in the Anthropic Console if you want.

To exercise the script without a key, add `--fake`: every scenario runs against
the package's local fake Managed Agents server (`--fake --scenario all` is covered
by `scripts/smoke.test.ts`). `SMOKE_FAKE_SCENARIO=never_idle` with `--fake` makes
`basic` hang, to check the timeout path. With `--fake`, a model name containing
`unsupported` in `MANAGED_AGENTS_MODELS` simulates a model the API refuses.

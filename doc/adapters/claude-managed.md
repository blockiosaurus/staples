# Claude (hosted) adapter (`claude_managed`)

Status: proof of concept (2026-10-12).

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
| `env.ANTHROPIC_API_KEY` | Agent setup credential field, or Environment variables | A company secret binding (recommended) or a plain value. When empty, the server's `ANTHROPIC_API_KEY` is used. |
| `model` | Model picker | Default `claude-opus-5-5`. Any Managed Agents model id can be typed. |
| `environmentId` | Configuration | Optional. An existing Managed Agents environment. When empty, Staples creates one per agent. |
| `instructionsFilePath` | Instructions | Used as the agent's system prompt. |
| `apiBaseUrl` | Advanced | Default `https://api.anthropic.com/v1`. Tests point it at a fake server. |
| `networkingMode` | Advanced | `unrestricted` (default) or `limited`. |
| `networkAllowedHosts` | Advanced, when limited | Hosts the sandbox may reach, one per line. |
| `networkAllowPackageManagers` | Advanced, when limited | Also allow package registries (npm, PyPI, ...). |

The connection test (**Test** in agent setup) checks that a key is present and
calls `GET /v1/agents?limit=1`; it never echoes the key.

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
  only to the configured API base URL, and never logged or returned.
- **Resource ownership.** Managed Agents agents and environments carry metadata
  `staples_agent_id`, `staples_company_id` and `staples_instance_id`. A new task
  adopts an existing agent or environment only when all three match. The
  instance id is `PAPERCLIP_INSTANCE_ID` (default `default`), so a worktree or
  fork instance that copied the database (same company and agent ids) creates its
  own resources rather than adopting the original instance's.

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
- The adapter can cap a new session at the agent's remaining budget
  (`budget.max_list_cost`); the session then stops with `budget_reached` and the
  run fails with `errorCode: "budget_reached"`.

## Limitations

- **No budget cap from the host yet.** The host does not pass the remaining
  budget to adapters. The adapter reads an optional
  `context.paperclipBudgetRemainingUsd` that nothing sets today, so sessions run
  without an Anthropic-side cap. Staples budgets still apply after each usage
  checkpoint. A resumed session keeps the cap it was created with.
- **Model and instructions are fixed per session.** Changing the model or the
  instructions starts a new session (the conversation does not carry over).
  Tool changes are applied to the existing session in place.
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
- **Not offered as the Assistant's runtime** during the proof of concept.
- **Not published to npm** yet (`publishFromCi: false` in the release manifest).

## Live smoke test

A script that runs the real adapter once against your own Anthropic account:

```sh
export ANTHROPIC_API_KEY=...        # your key; never commit it
pnpm --filter @paperclipai/adapter-claude-managed smoke
```

Optional: `MANAGED_AGENTS_MODEL` (default is the adapter's default model) and
`MANAGED_AGENTS_BASE_URL`. Without a key the script exits 1 and tells you to set one.

What it does:

- Starts one in-process fake Staples MCP server exposing a tool `echo_note`.
- Calls `execute()` with a minimal run context; the prompt asks the agent to call
  `echo_note` exactly once.
- Prints a compact transcript (messages, tool calls and results, usage), the cost,
  and the session, environment and agent ids. It fails unless `echo_note` was
  called through the tools proxy.
- Archives the session at the end (best effort).

Cost: it creates one small agent, one environment and one short session; expect a
few cents.

Cleanup: the session is archived automatically. The agent and environment are kept
(the adapter reuses them on later runs); the script prints their ids so you can
archive or delete them in the Anthropic Console if you want.

To exercise the script without a key, add `--fake`: it runs the same flow against the
package's local fake Managed Agents server.

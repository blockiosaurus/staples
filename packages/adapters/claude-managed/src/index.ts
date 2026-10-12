export const type = "claude_managed";
export const label = "Claude (hosted)";
export const description = "Runs in Anthropic's cloud sandbox. Uses your Anthropic API key; billed per use.";

/**
 * Models offered in the picker; any Managed Agents model id can still be typed in
 * the agent config. Verified 2026-10-12 against the docs: Managed Agents "Define your
 * agent" says Claude 4.5 and later models are supported and uses claude-opus-5-5 in
 * every example; the Models overview lists claude-opus-5-5, claude-sonnet-5-5 and
 * claude-haiku-5-5 as current Claude API ids. Not yet exercised live.
 */
export const models = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

export const agentConfigurationDoc = `# claude_managed agent configuration

Adapter: claude_managed ("Claude (hosted)")

Use when:
- You want the agent to run in Anthropic's cloud sandbox (Claude Managed Agents) instead of on this machine
- You have an Anthropic API key and accept per-use API billing

Core fields:
- env.ANTHROPIC_API_KEY (secret binding or plain, optional): Anthropic API key; falls back to the server's ANTHROPIC_API_KEY only when apiBaseUrl is the default
- model (string, optional): Claude model id (default claude-opus-5-5)
- environmentId (string, optional): existing Managed Agents environment to run in; Staples creates one when empty
- instructionsFilePath (string, optional): instructions file used as the agent's system prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template

Advanced fields:
- apiBaseUrl (string, optional): Managed Agents API base URL (default https://api.anthropic.com/v1); a custom URL requires env.ANTHROPIC_API_KEY
- inactivityTimeoutSec (number, optional): fail and interrupt the session after this many seconds without events (default 900)
- networkingMode ("unrestricted" | "limited", optional): sandbox egress (default unrestricted)
- networkAllowedHosts (string, optional): hosts the sandbox may reach when networkingMode is limited, one per line
- networkAllowPackageManagers (boolean, optional): also allow package registries when limited

Notes:
- Staples tools are proxied from the Staples server; no Staples credentials enter the sandbox.
- The Managed Agents session is reused across heartbeats for the same task.
- Cost is reported by Anthropic per run and counts against the agent's budget.
- Enabled skills are uploaded as Anthropic custom skills and attached to the agent (inlined into the system prompt if the Skills API is unavailable).
`;

export {
  ManagedAgentsClient,
  ManagedAgentsApiError,
  budgetFromUsd,
  listCostToUsd,
  normalizeSessionUsage,
  parseApiErrorBody,
} from "./client.js";
export type { ListPage, ListParams, ManagedAgentsClientOptions, RequestOptions, RetryPolicy, StreamOptions, UpdateSessionParams } from "./client.js";
export * from "./types.js";

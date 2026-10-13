/**
 * Types for the Claude Managed Agents HTTP API (beta `managed-agents-2026-04-01`).
 *
 * Shapes follow https://platform.claude.com/docs/en/managed-agents/* and the
 * `@anthropic-ai/sdk` beta typings (verified 2026-10-12). Only the fields this
 * adapter reads or writes are typed; everything else is kept on `raw`.
 */

export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MANAGED_AGENTS_BASE_URL = "https://api.anthropic.com/v1";

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** Whole US cents written as a string, e.g. `{ amount: "125", currency: "USD" }` = $1.25. */
export interface MonetaryAmount {
  amount: string;
  currency: string;
}

export interface BudgetLimit {
  type: "limit";
  max_list_cost: MonetaryAmount;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  [key: string]: unknown;
}

export interface AgentToolsetConfig {
  type: "agent_toolset_20260401";
  configs?: Array<Record<string, unknown>>;
  default_config?: Record<string, unknown> | null;
}

export interface CustomToolDefinition {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AgentTool = AgentToolsetConfig | CustomToolDefinition | { type: string; [key: string]: unknown };

export interface CreateAgentParams {
  name: string;
  model: string | ModelConfig;
  system?: string | null;
  description?: string | null;
  tools?: AgentTool[];
  mcp_servers?: Array<Record<string, unknown>>;
  skills?: AgentSkillRef[];
  metadata?: Record<string, string>;
}

/**
 * An entry in the agent's `skills` array (managed-agents/skills docs). For custom
 * skills `version` is a skill version id (`skver_...`) or `latest` (default).
 */
export interface AgentSkillRef {
  type: "custom" | "anthropic";
  skill_id: string;
  version?: string;
}

export interface UpdateAgentParams extends Partial<Omit<CreateAgentParams, "metadata">> {
  metadata?: Record<string, string | null> | null;
  /** Optimistic concurrency: the agent's current version. Omit to update unconditionally. */
  version?: number;
}

export interface ManagedAgent {
  id: string;
  type: "agent";
  name: string;
  version: number;
  model: ModelConfig;
  system: string | null;
  tools: AgentTool[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Skills (POST/GET /v1/skills, documented 2026-10-12)
// ---------------------------------------------------------------------------

export interface ManagedSkill {
  id: string;
  type: "skill";
  /** Single-line label (max 255 chars); not unique. Derived from SKILL.md `name` when omitted. */
  display_name: string;
  /** The newest version id (`skver_...`), what `latest` resolves to. */
  latest_version_id: string;
  source: { type: "custom" | "anthropic" | "anthropic_example" | "plugin" | string };
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/** One file of a skill upload. `path` includes the skill's top-level directory, e.g. `my-skill/SKILL.md`. */
export interface SkillUploadFile {
  path: string;
  content: string | Uint8Array;
}

export interface UploadSkillParams {
  /** Sent as the multipart `display_name` field. */
  displayName?: string;
  files: SkillUploadFile[];
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface CloudNetworking {
  type: "limited" | "unrestricted";
  allowed_hosts?: string[];
  allow_package_managers?: boolean;
  allow_mcp_servers?: boolean;
}

export interface CloudEnvironmentConfig {
  type: "cloud";
  networking?: CloudNetworking;
  packages?: Partial<Record<"apt" | "cargo" | "gem" | "go" | "npm" | "pip", string[]>>;
}

export interface CreateEnvironmentParams {
  name: string;
  config?: CloudEnvironmentConfig | { type: string; [key: string]: unknown } | null;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface ManagedEnvironment {
  id: string;
  type: "environment";
  name: string;
  config: CloudEnvironmentConfig | { type: string; [key: string]: unknown };
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionAgentRef =
  | string
  | { type: "agent"; id: string; version?: number }
  | { type: "agent_with_overrides"; id: string; version?: number; [key: string]: unknown };

export interface CreateSessionParams {
  agent: SessionAgentRef;
  environment_id: string;
  budget?: BudgetLimit;
  vault_ids?: string[];
  metadata?: Record<string, string>;
  title?: string | null;
  initial_events?: UserEventParams[];
}

export interface SessionUsageTotals {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  list_cost?: MonetaryAmount | null;
  active_seconds?: number;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
}

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export interface ManagedSession {
  id: string;
  type: "session";
  status: SessionStatus;
  environment_id: string;
  agent: Record<string, unknown>;
  budget: BudgetLimit | null;
  usage: SessionUsageTotals;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Events we send
// ---------------------------------------------------------------------------

export interface UserMessageEventParams {
  type: "user.message";
  content: ContentBlock[];
}

export interface UserInterruptEventParams {
  type: "user.interrupt";
}

export interface UserCustomToolResultEventParams {
  type: "user.custom_tool_result";
  /** The `id` of the `agent.custom_tool_use` event being answered. */
  custom_tool_use_id: string;
  content?: ContentBlock[];
  is_error?: boolean | null;
}

export interface UserToolConfirmationEventParams {
  type: "user.tool_confirmation";
  tool_use_id: string;
  result: "allow" | "deny";
}

export type UserEventParams =
  | UserMessageEventParams
  | UserInterruptEventParams
  | UserCustomToolResultEventParams
  | UserToolConfirmationEventParams;

// ---------------------------------------------------------------------------
// Events we receive (stream)
// ---------------------------------------------------------------------------

interface EventBase {
  id: string;
  processed_at?: string;
  /** The decoded JSON object as received, for logging/forwarding. */
  raw: Record<string, unknown>;
}

export interface AgentMessageEvent extends EventBase {
  type: "agent.message";
  content: ContentBlock[];
}

export interface AgentToolUseEvent extends EventBase {
  type: "agent.tool_use";
  name: string;
  input: Record<string, unknown>;
}

export interface AgentCustomToolUseEvent extends EventBase {
  type: "agent.custom_tool_use";
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolUseEvent extends EventBase {
  type: "agent.mcp_tool_use";
  name: string;
  mcp_server_name: string;
  input: Record<string, unknown>;
}

export interface SessionStatusRunningEvent extends EventBase {
  type: "session.status_running";
}

export type SessionStopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; event_ids: string[] }
  | { type: "retries_exhausted" }
  | { type: "budget_reached" }
  | { type: string; [key: string]: unknown };

export interface SessionStatusIdleEvent extends EventBase {
  type: "session.status_idle";
  stop_reason: SessionStopReason;
}

export interface SessionStatusTerminatedEvent extends EventBase {
  type: "session.status_terminated";
}

export interface SessionDeletedEvent extends EventBase {
  type: "session.deleted";
}

export interface SessionUsageEvent extends EventBase {
  type: "session.usage";
  usage: SessionUsageTotals;
  budget: BudgetLimit | null;
}

export interface SessionErrorDetail {
  type: string;
  message: string;
  retry_status?: { type: "retrying" | "exhausted" | "terminal" | string };
  [key: string]: unknown;
}

export interface SessionErrorEvent extends EventBase {
  type: "session.error";
  error: SessionErrorDetail;
}

/** Any event type this client does not model; the original `type` is kept in `eventType`. */
export interface UnknownManagedAgentsEvent {
  type: "unknown";
  eventType: string;
  id: string | null;
  raw: Record<string, unknown>;
}

export type ManagedAgentsEvent =
  | AgentMessageEvent
  | AgentToolUseEvent
  | AgentCustomToolUseEvent
  | AgentMcpToolUseEvent
  | SessionStatusRunningEvent
  | SessionStatusIdleEvent
  | SessionStatusTerminatedEvent
  | SessionDeletedEvent
  | SessionUsageEvent
  | SessionErrorEvent
  | UnknownManagedAgentsEvent;

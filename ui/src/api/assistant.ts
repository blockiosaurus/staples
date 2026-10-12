import type { AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { api } from "./client";

/** Adapters the Assistant can run on (server: ASSISTANT_RUNTIME_ADAPTER_TYPES). */
export const ASSISTANT_RUNTIME_ADAPTER_TYPES = ["claude_local", "codex_local", "gemini_local", "kimi_local", "claude_managed"] as const;
export type AssistantRuntimeAdapterType = (typeof ASSISTANT_RUNTIME_ADAPTER_TYPES)[number];

export interface AssistantSetup {
  /** ready: can answer; starting: being verified; needs_model: connect a model; error: see message. */
  state: "ready" | "starting" | "needs_model" | "error";
  message?: string;
  /** Fixed copy from the last failed connection test's check codes. */
  reason?: string;
  adapterType: string;
}

/** Cheap host detection for one runtime adapter (no model calls). */
export interface AssistantAdapterAvailability {
  adapterType: AssistantRuntimeAdapterType;
  installed: boolean;
  available: boolean;
  engine: "cli" | null;
  signedIn: boolean | null;
  hint?: string;
  /** Display name, e.g. "Claude (hosted)". Absent from older servers. */
  label?: string;
  /** claude_managed only: true when the server has no hosted key, so a person's own Anthropic key is needed. */
  needsKey?: boolean;
}

export interface AssistantSummary {
  agent: {
    id: string;
    name: string;
    urlKey: string;
    adapterType: string;
    status: string;
  };
  conversationIssueId: string | null;
  /** Absent from older servers: treat as ready. */
  setup?: AssistantSetup;
  /** False for viewers: they cannot connect a model. */
  canConfigure?: boolean;
  /** The server can run the Assistant on Claude (hosted) with its own key. Absent from older servers. */
  hostedInferenceAvailable?: boolean;
}

export interface AssistantSetupRequest {
  adapterType: AssistantRuntimeAdapterType;
  adapterConfig?: { model?: string; engine?: "cli" | "acp"; env?: Record<string, unknown> };
  aiConnection?: AiRuntimeConnectionBinding;
  applyStoredClaudeLogin?: boolean;
  /** claude_managed only: shorthand for adapterConfig.model. */
  model?: string;
  /** claude_managed only: a person's Anthropic API key, stored as a company secret (never echoed back). */
  apiKey?: string;
}

export const assistantApi = {
  /** Ensures the company Assistant exists and returns it with the caller's conversation id. */
  get: (companyId: string) => api.get<AssistantSummary>(`/companies/${companyId}/assistant`),
  /** The runtime adapters this host can run, from cheap detection. */
  adapters: (companyId: string) =>
    api.get<{ adapters: AssistantAdapterAvailability[] }>(`/companies/${companyId}/assistant/adapters`),
  /** Connects a model for the Assistant and restarts its setup. */
  setup: (companyId: string, data: AssistantSetupRequest) =>
    api.post<Pick<AssistantSummary, "agent" | "setup">>(`/companies/${companyId}/assistant/setup`, data),
};

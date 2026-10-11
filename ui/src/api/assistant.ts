import type { AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { api } from "./client";

/** Adapters the Assistant can run on (server: ASSISTANT_RUNTIME_ADAPTER_TYPES). */
export const ASSISTANT_RUNTIME_ADAPTER_TYPES = ["claude_local", "codex_local", "gemini_local", "kimi_local"] as const;
export type AssistantRuntimeAdapterType = (typeof ASSISTANT_RUNTIME_ADAPTER_TYPES)[number];

export interface AssistantSetup {
  /** ready: can answer; starting: being verified; needs_model: connect a model; error: see message. */
  state: "ready" | "starting" | "needs_model" | "error";
  message?: string;
  adapterType: string;
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
}

export interface AssistantSetupRequest {
  adapterType: AssistantRuntimeAdapterType;
  adapterConfig?: { model?: string; engine?: "cli" | "acp"; env?: Record<string, unknown> };
  aiConnection?: AiRuntimeConnectionBinding;
  applyStoredClaudeLogin?: boolean;
}

export const assistantApi = {
  /** Ensures the company Assistant exists and returns it with the caller's conversation id. */
  get: (companyId: string) => api.get<AssistantSummary>(`/companies/${companyId}/assistant`),
  /** Connects a model for the Assistant and restarts its setup. */
  setup: (companyId: string, data: AssistantSetupRequest) =>
    api.post<Pick<AssistantSummary, "agent" | "setup">>(`/companies/${companyId}/assistant/setup`, data),
};

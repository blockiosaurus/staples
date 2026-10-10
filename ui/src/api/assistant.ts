import { api } from "./client";

export interface AssistantSummary {
  agent: {
    id: string;
    name: string;
    urlKey: string;
    adapterType: string;
    status: string;
  };
  conversationIssueId: string | null;
}

export const assistantApi = {
  /** Ensures the company Assistant exists and returns it with the caller's conversation id. */
  get: (companyId: string) => api.get<AssistantSummary>(`/companies/${companyId}/assistant`),
};

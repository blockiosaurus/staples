import type { AgentTemplateDetail, AgentTemplateSummary } from "@paperclipai/shared";
import { api } from "./client";

/** The "Hire an agent" marketplace (server/src/routes/agent-templates.ts). Board read only; hiring goes through the Assistant. */
export const agentTemplatesApi = {
  list: (companyId: string) => api.get<AgentTemplateSummary[]>(`/companies/${companyId}/agent-templates`),
  get: (companyId: string, slug: string) =>
    api.get<AgentTemplateDetail>(`/companies/${companyId}/agent-templates/${encodeURIComponent(slug)}`),
};

import type { Briefing } from "@paperclipai/shared";
import { api } from "./client";

export const briefingApi = {
  get: (companyId: string) => api.get<Briefing>(`/companies/${companyId}/briefing`),
};

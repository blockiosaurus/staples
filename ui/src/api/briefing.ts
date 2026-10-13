import type { Briefing } from "@paperclipai/shared";
import { api } from "./client";

export const briefingApi = {
  get: (companyId: string, signal?: AbortSignal) =>
    api.get<Briefing>(`/companies/${companyId}/briefing`, signal ? { signal } : undefined),
};

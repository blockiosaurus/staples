import type { CompanySignals } from "@paperclipai/shared";
import { api } from "./client";

export const companySignalsApi = {
  get: (companyId: string) => api.get<CompanySignals>(`/companies/${companyId}/signals`),
};

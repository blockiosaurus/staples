import type { CompanyBrief, UpdateCompanyBrief } from "@paperclipai/shared";
import { api } from "./client";

export const companyBriefApi = {
  get: (companyId: string) => api.get<CompanyBrief | null>(`/companies/${companyId}/brief`),
  update: (companyId: string, input: UpdateCompanyBrief) => api.put<CompanyBrief>(`/companies/${companyId}/brief`, input),
};

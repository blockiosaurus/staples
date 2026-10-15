import type { BrandStarterStatus } from "@paperclipai/shared";
import { api } from "./client";

export const brandStarterApi = {
  get: (companyId: string) => api.get<BrandStarterStatus>(`/companies/${companyId}/brand-starter`),
};

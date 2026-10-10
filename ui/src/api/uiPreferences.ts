import type { PatchUiPreferences, UiPreferences } from "@paperclipai/shared";
import { api } from "./client";

export const uiPreferencesApi = {
  get: (companyId: string) => api.get<UiPreferences>(`/companies/${companyId}/ui-preferences/me`),
  patch: (companyId: string, patch: PatchUiPreferences) =>
    api.patch<UiPreferences>(`/companies/${companyId}/ui-preferences/me`, patch),
};

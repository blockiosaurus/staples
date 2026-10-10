import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_UI_PREFERENCES,
  applyUiPreferencesPatch,
  type PatchUiPreferences,
  type UiPreferences,
} from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { uiPreferencesApi } from "../api/uiPreferences";
import { queryKeys } from "../lib/queryKeys";

function sameIgnoringUpdatedAt(a: UiPreferences, b: UiPreferences) {
  const { updatedAt: _a, ...restA } = a;
  const { updatedAt: _b, ...restB } = b;
  return JSON.stringify(canonical(restA)) === JSON.stringify(canonical(restB));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function useUiPreferences(companyId: string | null | undefined): {
  preferences: UiPreferences;
  loaded: boolean;
  failed: boolean;
  update: (patch: PatchUiPreferences) => void;
} {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId;
  const queryKey = useMemo(
    () => queryKeys.uiPreferences(companyId ?? "__none__", userId ?? "__anon__"),
    [companyId, userId],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => uiPreferencesApi.get(companyId!),
    enabled: Boolean(companyId && userId),
  });

  const mutation = useMutation({
    mutationFn: (patch: PatchUiPreferences) => uiPreferencesApi.patch(companyId!, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<UiPreferences>(queryKey);
      queryClient.setQueryData<UiPreferences>(
        queryKey,
        applyUiPreferencesPatch(previous ?? DEFAULT_UI_PREFERENCES, patch, new Date().toISOString()),
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      else queryClient.removeQueries({ queryKey, exact: true });
    },
    onSuccess: (serverPreferences) => {
      queryClient.setQueryData(queryKey, serverPreferences);
    },
  });

  const mutate = mutation.mutate;
  const update = useCallback(
    (patch: PatchUiPreferences) => {
      if (!companyId || !userId) return;
      const current = queryClient.getQueryData<UiPreferences>(queryKey) ?? DEFAULT_UI_PREFERENCES;
      const next = applyUiPreferencesPatch(current, patch, new Date().toISOString());
      if (sameIgnoringUpdatedAt(current, next)) return;
      mutate(patch);
    },
    [companyId, userId, queryClient, queryKey, mutate],
  );

  return {
    preferences: query.data ?? DEFAULT_UI_PREFERENCES,
    loaded: query.isSuccess,
    failed: query.isError,
    update,
  };
}

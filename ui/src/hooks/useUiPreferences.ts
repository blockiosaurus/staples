import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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

type PendingPatch = { id: number; patch: PatchUiPreferences };
type PrefState = {
  /** Last value known from the server; null until the initial fetch completes. */
  base: UiPreferences | null;
  pending: PendingPatch[];
  /** Patches requested before the initial fetch completed. */
  queued: PatchUiPreferences[];
};

const statesByClient = new WeakMap<QueryClient, Map<string, PrefState>>();
let patchSequence = 0;

function getState(queryClient: QueryClient, queryKey: readonly unknown[]): PrefState {
  let states = statesByClient.get(queryClient);
  if (!states) {
    states = new Map();
    statesByClient.set(queryClient, states);
  }
  const id = JSON.stringify(queryKey);
  let state = states.get(id);
  if (!state) {
    state = { base: null, pending: [], queued: [] };
    states.set(id, state);
  }
  return state;
}

/** Accept a server value only if it is not older than what we already hold. */
function acceptServer(state: PrefState, server: UiPreferences) {
  const base = state.base;
  if (!base?.updatedAt || (server.updatedAt ?? "") >= base.updatedAt) state.base = server;
}

function display(state: PrefState): UiPreferences {
  const now = new Date().toISOString();
  let value = state.base ?? DEFAULT_UI_PREFERENCES;
  for (const entry of state.pending) value = applyUiPreferencesPatch(value, entry.patch, now);
  return value;
}

type MutationVars = {
  id: number;
  patch: PatchUiPreferences;
  companyId: string;
  queryKey: readonly unknown[];
};

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
    queryFn: async () => {
      const server = await uiPreferencesApi.get(companyId!);
      const state = getState(queryClient, queryKey);
      // A GET that started before a PATCH ack can resolve after it; never let it
      // resurrect older state.
      acceptServer(state, server);
      // Keep not-yet-acknowledged optimistic patches on top of fresh server data.
      return display(state);
    },
    enabled: Boolean(companyId && userId),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    scope: { id: `ui-preferences:${companyId}:${userId}` },
    mutationFn: (vars: MutationVars) => uiPreferencesApi.patch(vars.companyId, vars.patch),
    onSuccess: (server, vars) => {
      const state = getState(queryClient, vars.queryKey);
      state.pending = state.pending.filter((entry) => entry.id !== vars.id);
      acceptServer(state, server);
      queryClient.setQueryData(vars.queryKey, display(state));
    },
    onError: (_error, vars) => {
      const state = getState(queryClient, vars.queryKey);
      state.pending = state.pending.filter((entry) => entry.id !== vars.id);
      queryClient.setQueryData(vars.queryKey, display(state));
    },
  });

  const mutate = mutation.mutate;
  const apply = useCallback(
    (patch: PatchUiPreferences) => {
      if (!companyId || !userId) return;
      const state = getState(queryClient, queryKey);
      if (!state.base) {
        state.queued.push(patch);
        return;
      }
      const current = display(state);
      const next = applyUiPreferencesPatch(current, patch, new Date().toISOString());
      if (sameIgnoringUpdatedAt(current, next)) return;
      const id = ++patchSequence;
      state.pending.push({ id, patch });
      // Synchronous optimistic write so same-tick callers observe it.
      queryClient.setQueryData(queryKey, display(state));
      mutate({ id, patch, companyId, queryKey });
    },
    [companyId, userId, queryClient, queryKey, mutate],
  );

  const loaded = query.isSuccess;
  useEffect(() => {
    if (!loaded || !companyId || !userId) return;
    const state = getState(queryClient, queryKey);
    if (!state.base || state.queued.length === 0) return;
    const queued = state.queued;
    state.queued = [];
    for (const patch of queued) apply(patch);
  }, [loaded, companyId, userId, queryClient, queryKey, apply]);

  return {
    preferences: query.data ?? DEFAULT_UI_PREFERENCES,
    loaded,
    failed: query.isError,
    update: apply,
  };
}

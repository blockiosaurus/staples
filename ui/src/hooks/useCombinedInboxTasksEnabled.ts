import { useContext } from "react";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** On only when opted in. */
export function resolveCombinedInboxTasksEnabled(
  settings: Partial<Pick<InstanceExperimentalSettings, "enableCombinedInboxTasks">> | null | undefined,
): boolean {
  return settings?.enableCombinedInboxTasks === true;
}

const MAX_TRANSIENT_RETRIES = 3;

/**
 * App holds the gated board routes on this read. Signed-out visitors and
 * nonmembers get a 401/403 that will not change on retry, so settle at once
 * (flag off) and let CloudAccessGate route them, instead of waiting ~7s of
 * React Query's default backoff on "Loading…".
 */
export function shouldRetryExperimentalSettings(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < MAX_TRANSIENT_RETRIES;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Combined Inbox + Task List (Settings > Experimental): Inbox becomes views
 * inside Tasks — no Inbox nav row, the unread badge on Tasks, a Views menu on
 * /issues and /inbox/* redirects. Off by default — and off when rendered outside a query
 * client, as the app root is in some harnesses — so every surface renders as
 * before until an instance opts in.
 */
export function useCombinedInboxTasksEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
      retry: shouldRetryExperimentalSettings,
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveCombinedInboxTasksEnabled(query.data),
    loaded: query.isFetched,
  };
}

import { useContext } from "react";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** On only when opted in. */
export function resolveCombinedInboxTasksEnabled(
  settings: Partial<Pick<InstanceExperimentalSettings, "enableCombinedInboxTasks">> | null | undefined,
): boolean {
  return settings?.enableCombinedInboxTasks === true;
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
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveCombinedInboxTasksEnabled(query.data),
    loaded: query.isFetched,
  };
}

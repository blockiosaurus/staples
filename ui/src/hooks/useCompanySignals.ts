import { useQuery } from "@tanstack/react-query";
import type { CompanySignals } from "@paperclipai/shared";
import { companySignalsApi } from "../api/companySignals";
import { queryKeys } from "../lib/queryKeys";

export function useCompanySignals(companyId: string | null | undefined): {
  signals: CompanySignals | null;
  loaded: boolean;
  failed: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.signals(companyId ?? "__none__"),
    queryFn: () => companySignalsApi.get(companyId!),
    enabled: Boolean(companyId),
    // Live activity refreshes signals through a throttle; avoid extra refetches on mount/focus.
    staleTime: 30_000,
    // The company shell waits on signals at first load: retry once, then fall back.
    retry: 1,
  });
  return {
    signals: query.data ?? null,
    loaded: query.isSuccess,
    failed: query.isError,
  };
}

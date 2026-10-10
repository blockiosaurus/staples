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
  });
  return {
    signals: query.data ?? null,
    loaded: query.isSuccess,
    failed: query.isError,
  };
}

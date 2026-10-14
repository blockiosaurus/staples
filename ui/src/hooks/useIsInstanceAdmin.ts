import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { healthApi, type HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/** Whether this viewer administers the whole deployment. `null` while unknown. */
export function resolveIsInstanceAdmin(
  health: Pick<HealthStatus, "deploymentMode"> | null | undefined,
  boardAccess: Pick<CurrentBoardAccess, "isInstanceAdmin"> | null | undefined,
): boolean | null {
  if (!health) return null;
  if (health.deploymentMode !== "authenticated") return true;
  if (!boardAccess) return null;
  return boardAccess.isInstanceAdmin === true;
}

export function useIsInstanceAdmin(): { isAdmin: boolean; loaded: boolean } {
  const healthQuery = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), enabled: false });
  const needsBoardAccess = healthQuery.data?.deploymentMode === "authenticated";
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: needsBoardAccess,
    retry: false,
  });
  const resolved = resolveIsInstanceAdmin(healthQuery.data, boardAccessQuery.data);
  return { isAdmin: resolved === true, loaded: resolved !== null };
}

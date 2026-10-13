import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { healthApi, type HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Whether this viewer may start a new company, mirroring POST /companies:
 * - a Cloud-managed stack never creates in-app;
 * - local trusted mode always can;
 * - authenticated mode needs an instance admin, or self-serve creation
 *   (PAPERCLIP_SELF_SERVE_COMPANIES, reported as `features.selfServeCompanies`).
 *
 * `null` means "not known yet": health or board access is still loading.
 */
export function resolveCanCreateCompany(
  health: Pick<HealthStatus, "deploymentMode" | "features" | "cloud"> | null | undefined,
  boardAccess: Pick<CurrentBoardAccess, "isInstanceAdmin"> | null | undefined,
): boolean | null {
  if (!health) return null;
  if (health.cloud) return false;
  if (health.deploymentMode !== "authenticated") return true;
  if (health.features?.selfServeCompanies === true) return true;
  if (!boardAccess) return null;
  return boardAccess.isInstanceAdmin === true;
}

/**
 * Reads the health and board-access caches that CloudAccessGate fills. The
 * health observer never fetches on its own (see useCloudInstance); board access
 * is fetched only in authenticated mode, where it decides the answer.
 */
export function useCanCreateCompany(): { canCreate: boolean; loaded: boolean } {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });
  const health = healthQuery.data;
  const needsBoardAccess =
    health?.deploymentMode === "authenticated" && !health.cloud && health.features?.selfServeCompanies !== true;
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: needsBoardAccess,
    retry: false,
  });
  const resolved = resolveCanCreateCompany(health, boardAccessQuery.data);
  return { canCreate: resolved === true, loaded: resolved !== null };
}

import { Navigate, Outlet } from "@/lib/router";
import { useIsInstanceAdmin } from "@/hooks/useIsInstanceAdmin";

/** Route layout: admin-only pages fall back to company settings for everyone else. */
export function InstanceAdminGate() {
  const { isAdmin, loaded } = useIsInstanceAdmin();
  if (!loaded) return null;
  return isAdmin ? <Outlet /> : <Navigate to="/company/settings" replace />;
}

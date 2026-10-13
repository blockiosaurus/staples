import { useEffect, useRef } from "react";
import { useLocation } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { SURFACE_REGISTRY } from "./registry";
import { surfaceForPath } from "./resolve";
import { useSurfaces } from "./useSurfaces";

/** Returns the path without the company prefix, or null when the path is not company-prefixed. */
function stripCompanyPrefix(pathname: string, issuePrefix: string | undefined): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (!issuePrefix || segments[0]?.toLowerCase() !== issuePrefix.toLowerCase()) return null;
  segments.shift();
  return `/${segments.join("/")}`;
}

/** Persists growth reveals and first visits. Renders nothing. */
export function SurfaceTracker() {
  const { selectedCompany } = useCompany();
  const { states, preferences, ready, update } = useSurfaces();
  const location = useLocation();
  const companyId = selectedCompany?.id ?? null;
  // Dedupe keys include the company: Layout stays mounted across company switches.
  // Keys are recorded before update() resolves, so a failed PATCH is not retried until
  // remount. That is acceptable: update() rolls back, and the next growth/visit re-triggers.
  const sentReveals = useRef<string>("");
  const sentSeen = useRef<Set<string>>(new Set());

  const revealKey = states.filter((s) => s.shouldPersistReveal).map((s) => s.surface.id).join(",");
  useEffect(() => {
    if (!ready || !companyId || !revealKey) return;
    const key = `${companyId}:${revealKey}`;
    if (sentReveals.current === key) return;
    sentReveals.current = key;
    update({ reveal: revealKey.split(",") });
  }, [ready, companyId, revealKey, update]);

  const relative = stripCompanyPrefix(location.pathname, selectedCompany?.issuePrefix);
  const surface = relative === null ? null : surfaceForPath(SURFACE_REGISTRY, relative);
  const surfaceId = surface && surface.tier !== "core" ? surface.id : null;
  const alreadySeen = surfaceId !== null && surfaceId in preferences.seen;
  useEffect(() => {
    if (!ready || !companyId || !surfaceId || alreadySeen) return;
    const key = `${companyId}:${surfaceId}`;
    if (sentSeen.current.has(key)) return;
    sentSeen.current.add(key);
    update({ see: [surfaceId] });
  }, [ready, companyId, surfaceId, alreadySeen, update]);

  return null;
}

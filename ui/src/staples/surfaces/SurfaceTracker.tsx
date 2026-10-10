import { useEffect, useRef } from "react";
import { useLocation } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { SURFACE_REGISTRY } from "./registry";
import { surfaceForPath } from "./resolve";
import { useSurfaces } from "./useSurfaces";

function stripCompanyPrefix(pathname: string, issuePrefix: string | undefined): string {
  const segments = pathname.split("/").filter(Boolean);
  if (issuePrefix && segments[0]?.toLowerCase() === issuePrefix.toLowerCase()) segments.shift();
  return `/${segments.join("/")}`;
}

/** Persists growth reveals and first visits. Renders nothing. */
export function SurfaceTracker() {
  const { selectedCompany } = useCompany();
  const { states, preferences, ready, update } = useSurfaces();
  const location = useLocation();
  const sentReveals = useRef<string>("");
  const sentSeen = useRef<Set<string>>(new Set());

  const revealIds = states.filter((s) => s.shouldPersistReveal).map((s) => s.surface.id);
  const revealKey = revealIds.join(",");
  useEffect(() => {
    if (!ready || revealIds.length === 0 || sentReveals.current === revealKey) return;
    sentReveals.current = revealKey;
    update({ reveal: revealIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, revealKey, update]);

  const surface = surfaceForPath(SURFACE_REGISTRY, stripCompanyPrefix(location.pathname, selectedCompany?.issuePrefix));
  const surfaceId = surface && surface.tier !== "core" ? surface.id : null;
  const alreadySeen = surfaceId !== null && surfaceId in preferences.seen;
  useEffect(() => {
    if (!ready || !surfaceId || alreadySeen || sentSeen.current.has(surfaceId)) return;
    sentSeen.current.add(surfaceId);
    update({ see: [surfaceId] });
  }, [ready, surfaceId, alreadySeen, update]);

  return null;
}

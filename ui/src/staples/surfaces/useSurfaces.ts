import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PatchUiPreferences, UiPreferences } from "@paperclipai/shared";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { useCompany } from "../../context/CompanyContext";
import { useCompanySignals } from "../../hooks/useCompanySignals";
import { useInboxBadge } from "../../hooks/useInboxBadge";
import { useUiPreferences } from "../../hooks/useUiPreferences";
import { queryKeys } from "../../lib/queryKeys";
import { SURFACE_REGISTRY } from "./registry";
import { resolveSurfaces, type SurfaceState } from "./resolve";

export function useSurfaces(): {
  states: SurfaceState[];
  visible: SurfaceState[];
  hiddenAvailable: SurfaceState[];
  preferences: UiPreferences;
  /** The preferences request failed; edits cannot be trusted to persist. */
  preferencesFailed: boolean;
  ready: boolean;
  update: (patch: PatchUiPreferences) => void;
} {
  const { selectedCompanyId } = useCompany();
  const { signals, failed: signalsFailed } = useCompanySignals(selectedCompanyId);
  const { preferences, loaded: prefsLoaded, failed: prefsFailed, update } = useUiPreferences(selectedCompanyId);
  const inboxUnread = useInboxBadge(selectedCompanyId).inbox;
  const flagsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const flags = flagsQuery.data ?? null;
  const flagsSettled = flagsQuery.isSuccess || flagsQuery.isError;
  const ready = flagsSettled && (prefsLoaded || prefsFailed);
  // A failed refetch keeps the last good signals; only "never loaded" counts as unknown.
  const effectiveSignals = signalsFailed && !signals ? null : signals;

  const states = useMemo(
    () => resolveSurfaces(SURFACE_REGISTRY, { signals: effectiveSignals, flags, inboxUnread }, preferences),
    [effectiveSignals, flags, inboxUnread, preferences],
  );
  const visible = useMemo(() => states.filter((s) => s.visible), [states]);
  const hiddenAvailable = useMemo(() => states.filter((s) => s.available && !s.visible), [states]);
  return { states, visible, hiddenAvailable, preferences, preferencesFailed: prefsFailed, ready, update };
}

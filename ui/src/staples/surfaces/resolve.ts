import type { UiPreferences } from "@paperclipai/shared";
import type { SurfaceContext, SurfaceDefinition } from "./registry";

export interface SurfaceState {
  surface: SurfaceDefinition;
  available: boolean;
  visible: boolean;
  /** Visible because of growth or a visit, and the person has not visited it yet. */
  isNew: boolean;
  /** The growth rule fires but the reveal has not been persisted yet. */
  shouldPersistReveal: boolean;
  /** Why it is visible: used by the "More" menu and tests. */
  source: "unavailable" | "hidden" | "pinned" | "everything" | "revealed" | "core" | "grows" | "advanced";
}

export function resolveSurface(surface: SurfaceDefinition, ctx: SurfaceContext, prefs: UiPreferences): SurfaceState {
  const available = surface.available ? surface.available(ctx) : true;
  const growthFires = surface.tier === "grows" && ctx.signals !== null && (surface.revealWhen?.(ctx) ?? false);
  const revealed = surface.id in prefs.revealed;
  const base = { surface, available, isNew: false, shouldPersistReveal: false };
  if (!available) return { ...base, visible: false, source: "unavailable" };
  if (prefs.hidden.includes(surface.id)) return { ...base, visible: false, source: "hidden" };
  const shouldPersistReveal = growthFires && !revealed;
  const isNew = (revealed || growthFires) && surface.tier !== "core" && !(surface.id in prefs.seen);
  if (prefs.pinned.includes(surface.id)) return { ...base, visible: true, shouldPersistReveal, source: "pinned" };
  if (prefs.showEverything) return { ...base, visible: true, shouldPersistReveal, source: "everything" };
  if (surface.tier === "core") return { ...base, visible: true, source: "core" };
  if (revealed) return { ...base, visible: true, isNew, source: "revealed" };
  if (growthFires) return { ...base, visible: true, isNew, shouldPersistReveal, source: "grows" };
  return { ...base, visible: false, source: surface.tier };
}

export function resolveSurfaces(surfaces: readonly SurfaceDefinition[], ctx: SurfaceContext, prefs: UiPreferences): SurfaceState[] {
  return surfaces.map((surface) => resolveSurface(surface, ctx, prefs));
}

export function surfaceForPath(surfaces: readonly SurfaceDefinition[], pathWithoutPrefix: string): SurfaceDefinition | null {
  const root = pathWithoutPrefix.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!root) return null;
  return surfaces.find((surface) => surface.matchRoots.includes(root)) ?? null;
}

/**
 * Surfaces safe to render now. Until everything has settled (`ready`), only
 * core, pinned and already-revealed surfaces show so nothing flashes in and out.
 */
export function renderableSurfaces(states: readonly SurfaceState[], ready: boolean): SurfaceState[] {
  return states.filter(
    (state) =>
      state.visible &&
      (ready || state.source === "core" || state.source === "pinned" || state.source === "revealed"),
  );
}

import type { UiPreferences } from "./types/ui-preferences.js";
import type { PatchUiPreferences } from "./validators/ui-preferences.js";

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  pinned: [],
  hidden: [],
  revealed: {},
  seen: {},
  showEverything: false,
  updatedAt: null,
};

/** Upper bound for each stored surface collection (pinned, hidden, revealed, seen). */
export const MAX_SURFACE_ENTRIES = 128;

/** Returns a human-readable error when merged preferences exceed the storage cap, else null. */
export function uiPreferencesLimitError(prefs: UiPreferences): string | null {
  const sizes: Array<[string, number]> = [
    ["pinned", prefs.pinned.length],
    ["hidden", prefs.hidden.length],
    ["revealed", Object.keys(prefs.revealed).length],
    ["seen", Object.keys(prefs.seen).length],
  ];
  for (const [key, size] of sizes) {
    if (size > MAX_SURFACE_ENTRIES) {
      return `Too many ${key} navigation entries (${size}); the limit is ${MAX_SURFACE_ENTRIES}.`;
    }
  }
  return null;
}

export function applyUiPreferencesPatch(
  current: UiPreferences,
  patch: PatchUiPreferences,
  now: string,
): UiPreferences {
  const pinned = new Set(current.pinned);
  const hidden = new Set(current.hidden);
  for (const id of patch.pin ?? []) {
    pinned.add(id);
    hidden.delete(id);
  }
  for (const id of patch.unpin ?? []) pinned.delete(id);
  for (const id of patch.hide ?? []) {
    hidden.add(id);
    pinned.delete(id);
  }
  for (const id of patch.unhide ?? []) hidden.delete(id);
  const revealed = { ...current.revealed };
  for (const id of patch.reveal ?? []) revealed[id] ??= now;
  const seen = { ...current.seen };
  for (const id of patch.see ?? []) {
    seen[id] ??= now;
    revealed[id] ??= now;
  }
  return {
    pinned: [...pinned].sort(),
    hidden: [...hidden].sort(),
    revealed,
    seen,
    showEverything: patch.showEverything ?? current.showEverything,
    updatedAt: now,
  };
}

export type { UiPreferences } from "./types/ui-preferences.js";
export type { PatchUiPreferences } from "./validators/ui-preferences.js";

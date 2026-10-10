import { describe, expect, it } from "vitest";
import { applyUiPreferencesPatch, DEFAULT_UI_PREFERENCES, MAX_SURFACE_ENTRIES, uiPreferencesLimitError } from "./ui-preferences.js";
import type { UiPreferences, PatchUiPreferences } from "./index.js";

describe("applyUiPreferencesPatch", () => {
  const now = "2024-01-15T10:30:00Z";

  it("adds pinned items and removes them from hidden", () => {
    const current: UiPreferences = {
      pinned: [],
      hidden: ["nav.projects"],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { pin: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.pinned).toContain("nav.projects");
    expect(result.hidden).not.toContain("nav.projects");
    expect(result.updatedAt).toBe(now);
  });

  it("removes pinned items", () => {
    const current: UiPreferences = {
      pinned: ["nav.projects"],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { unpin: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.pinned).not.toContain("nav.projects");
  });

  it("hides items and removes them from pinned", () => {
    const current: UiPreferences = {
      pinned: ["nav.projects"],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { hide: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.hidden).toContain("nav.projects");
    expect(result.pinned).not.toContain("nav.projects");
  });

  it("unhides items", () => {
    const current: UiPreferences = {
      pinned: [],
      hidden: ["nav.projects"],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { unhide: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.hidden).not.toContain("nav.projects");
  });

  it("keeps first reveal timestamp", () => {
    const oldTime = "2024-01-10T10:00:00Z";
    const current: UiPreferences = {
      pinned: [],
      hidden: [],
      revealed: { "nav.projects": oldTime },
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { reveal: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.revealed["nav.projects"]).toBe(oldTime);
  });

  it("sets new reveal timestamp", () => {
    const current: UiPreferences = {
      pinned: [],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { reveal: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.revealed["nav.projects"]).toBe(now);
  });

  it("see also reveals", () => {
    const current: UiPreferences = {
      pinned: [],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { see: ["nav.projects"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.seen["nav.projects"]).toBe(now);
    expect(result.revealed["nav.projects"]).toBe(now);
  });

  it("toggles showEverything", () => {
    const current: UiPreferences = {
      pinned: [],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { showEverything: true };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.showEverything).toBe(true);
  });

  it("sorts arrays and deduplicates", () => {
    const current: UiPreferences = {
      pinned: ["nav.b"],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    };
    const patch: PatchUiPreferences = { pin: ["nav.a", "nav.c", "nav.b"] };
    const result = applyUiPreferencesPatch(current, patch, now);
    expect(result.pinned).toEqual(["nav.a", "nav.b", "nav.c"]);
  });

  it("initializes from DEFAULT_UI_PREFERENCES", () => {
    expect(DEFAULT_UI_PREFERENCES).toEqual({
      pinned: [],
      hidden: [],
      revealed: {},
      seen: {},
      showEverything: false,
      updatedAt: null,
    });
  });
});

describe("uiPreferencesLimitError", () => {
  const ids = (n: number, prefix = "nav.s") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const asMap = (list: string[]) => Object.fromEntries(list.map((id) => [id, "2024-01-01T00:00:00Z"]));

  it("exports a cap of 128 entries", () => {
    expect(MAX_SURFACE_ENTRIES).toBe(128);
  });

  it("accepts preferences at the cap", () => {
    const at = ids(MAX_SURFACE_ENTRIES);
    expect(
      uiPreferencesLimitError({ ...DEFAULT_UI_PREFERENCES, pinned: at, hidden: at, revealed: asMap(at), seen: asMap(at) }),
    ).toBeNull();
  });

  it.each(["pinned", "hidden", "revealed", "seen"] as const)("rejects %s over the cap", (key) => {
    const over = ids(MAX_SURFACE_ENTRIES + 1);
    const value = key === "pinned" || key === "hidden" ? over : asMap(over);
    const message = uiPreferencesLimitError({ ...DEFAULT_UI_PREFERENCES, [key]: value });
    expect(message).toContain(key);
    expect(message).toContain(String(MAX_SURFACE_ENTRIES));
  });
});

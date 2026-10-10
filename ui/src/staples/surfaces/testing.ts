import { DEFAULT_UI_PREFERENCES, type CompanySignals, type InstanceExperimentalSettings, type UiPreferences } from "@paperclipai/shared";
import { SURFACE_REGISTRY } from "./registry";
import { resolveSurfaces, type SurfaceState } from "./resolve";

export interface SurfacesFixture {
  states: SurfaceState[];
  visible: SurfaceState[];
  hiddenAvailable: SurfaceState[];
  preferences: UiPreferences;
  preferencesFailed: boolean;
  ready: boolean;
  update: () => void;
}

/** Builds a `useSurfaces()` return value from the real registry for component tests. */
export function makeSurfacesFixture(options: {
  signals?: Partial<CompanySignals> | null;
  flags?: Partial<InstanceExperimentalSettings> | null;
  inboxUnread?: number;
  preferences?: Partial<UiPreferences>;
  preferencesFailed?: boolean;
  ready?: boolean;
} = {}): SurfacesFixture {
  const preferences: UiPreferences = { ...DEFAULT_UI_PREFERENCES, ...options.preferences };
  const signals: CompanySignals | null = options.signals === null
    ? null
    : {
        companyId: "company-1",
        agents: 0,
        tasks: 0,
        openTasks: 0,
        projects: 0,
        goals: 0,
        routines: 0,
        artifacts: 0,
        extraSkills: 0,
        connections: 0,
        connectionRequests: 0,
        approvalsEver: 0,
        questionsEver: 0,
        budgetSet: false,
        monthSpendCents: 0,
        generatedAt: "2026-01-01T00:00:00.000Z",
        ...options.signals,
      };
  const states = resolveSurfaces(
    SURFACE_REGISTRY,
    {
      signals,
      flags: (options.flags ?? null) as InstanceExperimentalSettings | null,
      inboxUnread: options.inboxUnread ?? 0,
    },
    preferences,
  );
  return {
    states,
    visible: states.filter((s) => s.visible),
    hiddenAvailable: states.filter((s) => s.available && !s.visible),
    preferences,
    preferencesFailed: options.preferencesFailed ?? false,
    ready: options.ready ?? true,
    update: () => {},
  };
}

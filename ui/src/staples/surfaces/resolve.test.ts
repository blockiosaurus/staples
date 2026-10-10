import { describe, expect, it } from "vitest";
import {
  BOARD_ROUTE_ROOTS,
  DEFAULT_UI_PREFERENCES,
  surfaceIdSchema,
  type CompanySignals,
  type InstanceExperimentalSettings,
  type UiPreferences,
} from "@paperclipai/shared";
import { SURFACE_REGISTRY } from "./registry";
import type { SurfaceContext } from "./registry";
import { renderableSurfaces, resolveSurface, resolveSurfaces, surfaceForPath } from "./resolve";

function signals(overrides: Partial<CompanySignals> = {}): CompanySignals {
  return {
    companyId: "c1",
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
    ...overrides,
  };
}

function prefs(overrides: Partial<UiPreferences> = {}): UiPreferences {
  return { ...DEFAULT_UI_PREFERENCES, ...overrides };
}

function ctx(overrides: Partial<SurfaceContext> = {}): SurfaceContext {
  return { signals: signals(), flags: null, inboxUnread: 0, ...overrides };
}

function byId(id: string) {
  const surface = SURFACE_REGISTRY.find((s) => s.id === id);
  if (!surface) throw new Error(`missing ${id}`);
  return surface;
}

function visibleIds(c: SurfaceContext, p: UiPreferences) {
  return resolveSurfaces(SURFACE_REGISTRY, c, p)
    .filter((s) => s.visible)
    .map((s) => s.surface.id);
}

describe("resolveSurface", () => {
  it("places the core Assistant surface right after Dashboard in the top group", () => {
    const ids = SURFACE_REGISTRY.map((surface) => surface.id);
    expect(ids.indexOf("nav.assistant")).toBe(ids.indexOf("nav.dashboard") + 1);
    expect(byId("nav.assistant")).toMatchObject({
      label: "Assistant",
      to: "/assistant",
      matchRoots: ["assistant"],
      group: "top",
      tier: "core",
    });
  });

  it("shows only dashboard, tasks, agents for a fresh company", () => {
    expect(visibleIds(ctx(), prefs())).toEqual(["nav.dashboard", "nav.assistant", "nav.tasks", "nav.agents"]);
  });

  it("reveals projects when growth fires", () => {
    const state = resolveSurface(byId("nav.projects"), ctx({ signals: signals({ projects: 2 }) }), prefs());
    expect(state).toMatchObject({ visible: true, isNew: true, shouldPersistReveal: true, source: "grows" });
  });

  it("keeps a revealed surface visible after growth recedes", () => {
    const state = resolveSurface(
      byId("nav.projects"),
      ctx(),
      prefs({ revealed: { "nav.projects": "2026-01-01T00:00:00.000Z" } }),
    );
    expect(state).toMatchObject({ visible: true, source: "revealed", shouldPersistReveal: false });
  });

  it("clears isNew once seen", () => {
    const state = resolveSurface(
      byId("nav.projects"),
      ctx(),
      prefs({
        revealed: { "nav.projects": "2026-01-01T00:00:00.000Z" },
        seen: { "nav.projects": "2026-01-02T00:00:00.000Z" },
      }),
    );
    expect(state.isNew).toBe(false);
    expect(state.visible).toBe(true);
  });

  it("hidden beats pinned, growth and showEverything", () => {
    const state = resolveSurface(
      byId("nav.projects"),
      ctx({ signals: signals({ projects: 5 }) }),
      prefs({ hidden: ["nav.projects"], pinned: ["nav.projects"], showEverything: true }),
    );
    expect(state).toMatchObject({ visible: false, source: "hidden" });
  });

  it("showEverything shows advanced surfaces only when available", () => {
    const p = prefs({ showEverything: true });
    const off = resolveSurface(byId("nav.cases"), ctx(), p);
    expect(off.visible).toBe(false);
    const on = resolveSurface(byId("nav.cases"), ctx({ flags: { enableCases: true } as InstanceExperimentalSettings }), p);
    expect(on).toMatchObject({ visible: true, source: "everything" });
  });

  it("keeps unavailable surfaces hidden even when pinned", () => {
    const state = resolveSurface(byId("nav.cases"), ctx(), prefs({ pinned: ["nav.cases"] }));
    expect(state).toMatchObject({ visible: false, available: false, source: "unavailable" });
  });

  it("shows only core surfaces when signals are null", () => {
    const states = resolveSurfaces(SURFACE_REGISTRY, ctx({ signals: null, inboxUnread: 3 }), prefs());
    expect(states.filter((s) => s.visible).map((s) => s.surface.id)).toEqual([
      "nav.dashboard",
      "nav.assistant",
      "nav.tasks",
      "nav.agents",
    ]);
    expect(states.some((s) => s.shouldPersistReveal)).toBe(false);
  });

  it("inbox does not grow while signals are null", () => {
    const state = resolveSurface(byId("nav.inbox"), ctx({ signals: null, inboxUnread: 5 }), prefs());
    expect(state.visible).toBe(false);
    expect(state.shouldPersistReveal).toBe(false);
  });

  it("inbox grows once signals load and something is unread", () => {
    const state = resolveSurface(byId("nav.inbox"), ctx({ inboxUnread: 1 }), prefs());
    expect(state).toMatchObject({ visible: true, source: "grows" });
  });
});

describe("surfaceForPath", () => {
  it("maps paths to surfaces", () => {
    expect(surfaceForPath(SURFACE_REGISTRY, "/issues/PAP-1")?.id).toBe("nav.tasks");
    expect(surfaceForPath(SURFACE_REGISTRY, "/unknown")).toBeNull();
  });

  it("maps cost paths to Costs, not Audit", () => {
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/costs")?.id).toBe("nav.costs");
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/costs/")?.id).toBe("nav.costs");
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/budgets")?.id).toBe("nav.costs");
    expect(surfaceForPath(SURFACE_REGISTRY, "/costs")?.id).toBe("nav.costs");
    expect(surfaceForPath(SURFACE_REGISTRY, "/audit/costs")?.id).toBe("nav.costs");
  });

  it("keeps other activity paths on Audit", () => {
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity")?.id).toBe("nav.audit");
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/runs")?.id).toBe("nav.audit");
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/timeline")?.id).toBe("nav.audit");
    expect(surfaceForPath(SURFACE_REGISTRY, "/activity/costsx")?.id).toBe("nav.audit");
    expect(surfaceForPath(SURFACE_REGISTRY, "/audit")?.id).toBe("nav.audit");
  });

  it("maps approvals to Decisions", () => {
    expect(surfaceForPath(SURFACE_REGISTRY, "/approvals/pending")?.id).toBe("nav.decisions");
  });

  it("prefers the longest matching path", () => {
    const base = byId("nav.audit");
    const surfaces = [
      { ...base, id: "a", matchRoots: [], matchPaths: ["x"] },
      { ...base, id: "b", matchRoots: [], matchPaths: ["x/y"] },
    ];
    expect(surfaceForPath(surfaces, "/x/y/z")?.id).toBe("b");
    expect(surfaceForPath(surfaces, "/x/z")?.id).toBe("a");
  });
});

describe("renderableSurfaces", () => {
  it("before ready, renders only core/pinned/revealed surfaces without an availability rule", () => {
    const states = resolveSurfaces(
      SURFACE_REGISTRY,
      ctx({ signals: signals({ agents: 2 }), flags: { enableCases: true, enableDecisions: true } as InstanceExperimentalSettings }),
      prefs({
        pinned: ["nav.cases", "nav.goals"],
        revealed: { "nav.decisions": "2026-01-01T00:00:00.000Z", "nav.projects": "2026-01-01T00:00:00.000Z" },
      }),
    );
    const ids = (ready: boolean) => renderableSurfaces(states, ready).map((s) => s.surface.id);
    expect(ids(false)).toEqual(["nav.dashboard", "nav.assistant", "nav.tasks", "nav.projects", "nav.goals", "nav.agents"]);
    expect(ids(true)).toEqual(expect.arrayContaining(["nav.chat", "nav.cases", "nav.decisions"]));
  });
});

describe("nav.chat", () => {
  it("is a grows surface with no flag gate that reveals at two agents", () => {
    const chat = byId("nav.chat");
    expect(chat.tier).toBe("grows");
    expect(chat.available).toBeUndefined();
    expect(chat.reason).toBe("Chat appeared because you have more than one agent.");
    expect(visibleIds(ctx({ signals: signals({ agents: 1 }) }), prefs())).not.toContain("nav.chat");
    expect(visibleIds(ctx({ signals: signals({ agents: 2 }) }), prefs())).toContain("nav.chat");
  });

  it("does not depend on the retired enableAgentChat flag", () => {
    const flags = { enableAgentChat: false } as InstanceExperimentalSettings;
    expect(visibleIds(ctx({ signals: signals({ agents: 2 }), flags }), prefs())).toContain("nav.chat");
  });
});

describe("SURFACE_REGISTRY", () => {
  it("has valid unique ids and a path-only costs entry", () => {
    const ids = SURFACE_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(surfaceIdSchema.safeParse(id).success).toBe(true);
    expect(byId("nav.costs").matchRoots).toEqual([]);
    expect(byId("nav.costs").matchPaths).toContain("activity/costs");
    expect(byId("nav.audit").matchRoots).not.toContain("costs");
  });

  it("only matches reserved board route roots", () => {
    const roots = new Set<string>(BOARD_ROUTE_ROOTS);
    for (const surface of SURFACE_REGISTRY) {
      for (const root of surface.matchRoots) expect(roots.has(root), `${surface.id} root ${root}`).toBe(true);
      for (const path of surface.matchPaths ?? []) {
        expect(path.startsWith("/"), `${surface.id} path ${path}`).toBe(false);
        const first = path.split("/")[0]!;
        expect(roots.has(first), `${surface.id} path ${path}`).toBe(true);
      }
    }
  });

  it("all revealWhen rules except inbox are false when signals are null", () => {
    const c = ctx({ signals: null, inboxUnread: 9 });
    for (const s of SURFACE_REGISTRY) {
      if (s.id === "nav.inbox") continue;
      expect(s.revealWhen?.(c) ?? false).toBe(false);
    }
  });
});

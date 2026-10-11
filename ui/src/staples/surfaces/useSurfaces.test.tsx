// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES } from "@paperclipai/shared";
import { useSurfaces } from "./useSurfaces";
import { SurfaceTracker } from "./SurfaceTracker";

const mocks = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  signals: vi.fn(),
  prefs: vi.fn(),
  update: vi.fn(),
  pathname: { value: "/PAP/issues" },
  company: { value: { id: "company-1", issuePrefix: "PAP" } },
}));
vi.mock("../../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.getExperimental } }));
vi.mock("../../hooks/useCompanySignals", () => ({ useCompanySignals: () => mocks.signals() }));
vi.mock("../../hooks/useUiPreferences", () => ({ useUiPreferences: () => mocks.prefs() }));
vi.mock("../../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: mocks.company.value.id, selectedCompany: mocks.company.value }),
}));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: mocks.pathname.value }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useSurfaces / SurfaceTracker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let observed: ReturnType<typeof useSurfaces>;

  function Probe() {
    observed = useSurfaces();
    return <SurfaceTracker />;
  }
  const tree = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const setPrefs = (over: Record<string, unknown> = {}, loaded = true, failed = false) =>
    mocks.prefs.mockReturnValue({ preferences: { ...DEFAULT_UI_PREFERENCES, ...over }, loaded, failed, update: mocks.update });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname.value = "/PAP/issues";
    mocks.company.value = { id: "company-1", issuePrefix: "PAP" };
    mocks.getExperimental.mockResolvedValue({});
    mocks.signals.mockReturnValue({ signals: null, loaded: true, failed: false });
    setPrefs();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  });

  const mount = async () => {
    await act(async () => root.render(tree()));
    await flush();
    await flush();
  };

  it("is not ready until flags and preferences load", async () => {
    setPrefs({}, false);
    await act(async () => root.render(tree()));
    expect(observed.ready).toBe(false);
    setPrefs({}, true);
    await mount();
    expect(observed.ready).toBe(true);
  });

  it("treats failed preferences as settled", async () => {
    setPrefs({}, false, true);
    await mount();
    expect(observed.ready).toBe(true);
  });

  it("keeps last-good signals when a later refetch fails", async () => {
    mocks.signals.mockReturnValue({
      signals: { companyId: "company-1", agents: 0, tasks: 0, openTasks: 0, projects: 2, goals: 0, routines: 0, artifacts: 0, extraSkills: 0, connections: 0, connectionRequests: 0, approvalsEver: 0, questionsEver: 0, budgetSet: false, monthSpendCents: 0, hasBrief: false },
      loaded: true,
      failed: true,
    });
    await mount();
    expect(observed.visible.map((s) => s.surface.id)).toContain("nav.projects");
  });

  it("treats failed signals with no data as unknown", async () => {
    mocks.signals.mockReturnValue({ signals: null, loaded: false, failed: true });
    await mount();
    expect(observed.visible.map((s) => s.surface.id)).toEqual(["nav.dashboard", "nav.assistant", "nav.tasks", "nav.agents"]);
  });

  it("exposes preference load failures", async () => {
    setPrefs({}, false, true);
    await mount();
    expect(observed.preferencesFailed).toBe(true);
  });

  it("persists a growth-fired reveal exactly once across re-renders", async () => {
    mocks.signals.mockReturnValue({
      signals: { companyId: "company-1", agents: 0, tasks: 0, openTasks: 0, projects: 2, goals: 0, routines: 0, artifacts: 0, extraSkills: 0, connections: 0, connectionRequests: 0, approvalsEver: 0, questionsEver: 0, budgetSet: false, monthSpendCents: 0, hasBrief: false },
      loaded: true,
      failed: false,
    });
    await mount();
    const revealCalls = () => mocks.update.mock.calls.filter(([p]) => p.reveal);
    const first = revealCalls().length;
    expect(first).toBe(1);
    expect(revealCalls()[0]![0]).toEqual({ reveal: ["nav.projects"] });
    await mount();
    await mount();
    expect(revealCalls().length).toBe(1);
  });

  it("records a visit to a non-core surface", async () => {
    mocks.pathname.value = "/PAP/routines";
    await mount();
    expect(mocks.update).toHaveBeenCalledWith({ see: ["nav.routines"] });
  });

  it("does nothing for a core surface", async () => {
    mocks.pathname.value = "/PAP/issues";
    await mount();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("re-sends reveal and see after switching company", async () => {
    mocks.signals.mockReturnValue({
      signals: { companyId: "company-1", agents: 0, tasks: 0, openTasks: 0, projects: 2, goals: 0, routines: 0, artifacts: 0, extraSkills: 0, connections: 0, connectionRequests: 0, approvalsEver: 0, questionsEver: 0, budgetSet: false, monthSpendCents: 0, hasBrief: false },
      loaded: true,
      failed: false,
    });
    mocks.pathname.value = "/PAP/routines";
    await mount();
    expect(mocks.update).toHaveBeenCalledWith({ reveal: ["nav.projects"] });
    expect(mocks.update).toHaveBeenCalledWith({ see: ["nav.routines"] });
    mocks.update.mockClear();
    mocks.company.value = { id: "company-2", issuePrefix: "BBB" };
    mocks.pathname.value = "/BBB/routines";
    await mount();
    expect(mocks.update).toHaveBeenCalledWith({ reveal: ["nav.projects"] });
    expect(mocks.update).toHaveBeenCalledWith({ see: ["nav.routines"] });
  });

  it("ignores unprefixed transient paths", async () => {
    for (const path of ["/dashboard", "/activity", "/routines"]) {
      mocks.pathname.value = path;
      await mount();
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

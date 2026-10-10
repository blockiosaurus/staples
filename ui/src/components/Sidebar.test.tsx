// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { makeSurfacesFixture, type SurfacesFixture } from "../staples/surfaces/testing";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockAttentionApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

const mockSidebar = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
  collapsed: false,
  peeking: false,
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebar,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/attention", () => ({
  attentionApi: mockAttentionApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

const mockInboxBadge = vi.hoisted(() => ({ inbox: 0, failedRuns: 0 }));

const surfacesState = vi.hoisted(() => ({ current: null as unknown as SurfacesFixture }));

vi.mock("../staples/surfaces/useSurfaces", () => ({
  useSurfaces: () => surfacesState.current,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => mockInboxBadge,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-plugin-slot-types={slotTypes.join(",")}>Plugin slot outlet</div>
  ),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: ({ placementZones }: { placementZones: string[] }) => (
    <div data-plugin-launcher-zone={placementZones.join(",")}>Plugin launcher outlet</div>
  ),
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: ({ streamlined }: { streamlined?: boolean }) => (
    <div data-testid="sidebar-agents" data-streamlined={String(streamlined)}>
      Active agents
    </div>
  ),
}));

vi.mock("./SidebarStarredProjects", () => ({
  SidebarStarredProjects: () => <div data-testid="sidebar-starred-projects" />,
}));

// Stubbed so the "no agent names in the primary nav" assertion would catch a
// regression that mounts the old per-agent chat rows alongside the Chat rail.

vi.mock("./SidebarRecentTasks", () => ({
  SidebarRecentTasks: () => <div data-testid="sidebar-recent-tasks">Recent Tasks</div>,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  async function renderSidebar() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  async function withSidebar(
    options: Parameters<typeof makeSurfacesFixture>[0],
    assert: () => void,
    experimental: Record<string, unknown> = {},
  ) {
    surfacesState.current = makeSurfacesFixture(options);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(experimental);
    const root = await renderSidebar();
    try {
      assert();
    } finally {
      flushSync(() => {
        root.unmount();
      });
    }
  }

  const navLabels = () => [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
  const hrefs = () => [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockAttentionApi.list.mockResolvedValue({ items: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    surfacesState.current = makeSurfacesFixture();
    mockSidebar.isMobile = false;
    mockSidebar.collapsed = false;
    mockSidebar.peeking = false;
    mockInboxBadge.inbox = 0;
    mockInboxBadge.failedRuns = 0;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the default sidebar edge borderless", async () => {
    await withSidebar({}, () => {
      const sidebar = container.querySelector("aside");
      expect(sidebar?.classList).not.toContain("border-r");
      expect(sidebar?.classList).not.toContain("border-border");
      expect(sidebar?.classList).toContain("primary-sidebar-surface");
    });
  });

  it("shows Search as a nav item instead of a header icon", async () => {
    await withSidebar({}, () => {
      expect(container.querySelector('a[aria-label="Open search"]')).toBeNull();
      const navSearchLink = [...container.querySelectorAll("nav a")]
        .find((anchor) => anchor.textContent?.trim() === "Search");
      expect(navSearchLink?.getAttribute("href")).toBe("/search");
    });
  });

  it("fresh company shows Dashboard, Assistant, Tasks and Agents only", async () => {
    await withSidebar({}, () => {
      expect(navLabels()).toEqual(["Search", "Dashboard", "Assistant", "Tasks", "Agents"]);
      expect(container.textContent).toContain("New Task");
      expect(container.querySelector('[data-testid="sidebar-starred-projects"]')).toBeNull();
      expect(container.querySelector('[data-testid="sidebar-recent-tasks"]')).not.toBeNull();
    });
  });

  it("renders plugin sidebar launchers inside the Work section", async () => {
    await withSidebar({}, () => {
      const launcher = [...container.querySelectorAll("nav [data-plugin-launcher-zone]")]
        .find((node) => node.getAttribute("data-plugin-launcher-zone") === "sidebar");
      expect(launcher?.textContent).toContain("Plugin launcher outlet");
      let section = launcher?.parentElement ?? null;
      while (section && !section.textContent?.includes("Work")) section = section.parentElement;
      expect(section?.textContent).toContain("Work");
      expect(section?.textContent).toContain("Tasks");
      expect(section?.textContent).not.toContain("Goals");
    });
  });

  it("renders the Work and Org sections in registry order with Costs in Org", async () => {
    await withSidebar(
      {
        preferences: { showEverything: true },
        flags: { enableIsolatedWorkspaces: false },
      },
      () => {
        const sections = [...container.querySelectorAll("nav > div")];
        const workSection = sections.find((section) => section.textContent?.startsWith("Work"));
        const orgSection = sections.find((section) => section.textContent?.startsWith("Org"));
        const labels = (section: Element | undefined) => [...(section?.querySelectorAll("a") ?? [])]
          .map((anchor) => anchor.textContent?.trim());

        expect(labels(workSection)).toEqual(["Chat", "Tasks", "Projects", "Routines", "Artifacts", "Goals"]);
        expect(labels(orgSection)).toEqual(["Agents", "Skills", "Connectors", "Costs", "Audit"]);
        expect(orgSection?.querySelector('a[href="/activity/costs"]')?.textContent).toContain("Costs");
        expect(orgSection?.querySelector('a[href="/activity"]')?.textContent).toContain("Audit");
        expect(sections.indexOf(workSection!)).toBeLessThan(sections.indexOf(orgSection!));
        expect(
          workSection?.querySelector('a[href="/issues"] svg')?.classList.contains("lucide-circle-check"),
        ).toBe(true);
        expect(container.querySelector('a[href="/timeline"]')).toBeNull();
      },
    );
  });

  it("a grows surface marked new renders the new badge and hint", async () => {
    await withSidebar({ signals: { routines: 2 } }, () => {
      const link = container.querySelector('a[href="/routines"]');
      expect(link).not.toBeNull();
      expect(link?.textContent).toContain("new");
      expect(link?.getAttribute("title")).toBeNull();
      const describedBy = link?.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe("Routines appeared because you created a recurring job.");
      // Core surfaces never carry the badge.
      expect(container.querySelector('a[href="/issues"]')?.textContent).not.toContain("new");
    });
  });

  it("drops the new badge once the surface has been seen", async () => {
    await withSidebar(
      {
        signals: { routines: 2 },
        preferences: { revealed: { "nav.routines": "2026-01-01T00:00:00.000Z" }, seen: { "nav.routines": "2026-01-02T00:00:00.000Z" } },
      },
      () => {
        const link = container.querySelector('a[href="/routines"]');
        expect(link).not.toBeNull();
        expect(link?.textContent).not.toContain("new");
        expect(link?.getAttribute("aria-describedby")).toBeNull();
      },
    );
  });

  it("renders Starred projects only with Projects", async () => {
    await withSidebar({}, () => {
      expect(container.querySelector('[data-testid="sidebar-starred-projects"]')).toBeNull();
    });
    await withSidebar({ signals: { projects: 3 } }, () => {
      const starred = container.querySelector('[data-testid="sidebar-starred-projects"]');
      expect(starred).not.toBeNull();
      const projectsLink = container.querySelector('a[href="/projects"]');
      expect(projectsLink).not.toBeNull();
      expect(projectsLink!.compareDocumentPosition(starred!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("renders plugin sidebar slots in Work below Workspaces", async () => {
    await withSidebar(
      { preferences: { showEverything: true }, flags: { enableIsolatedWorkspaces: true } },
      () => {
        expect(hrefs()).toContain("/workspaces");
        const sidebarSlot = [...container.querySelectorAll("nav [data-plugin-slot-types]")]
          .find((node) => node.getAttribute("data-plugin-slot-types") === "sidebar");
        expect(sidebarSlot?.textContent).toContain("Plugin slot outlet");
        const workText = sidebarSlot?.parentElement?.parentElement?.textContent ?? "";
        expect(workText).toContain("Workspaces");
        expect(workText.indexOf("Workspaces")).toBeLessThan(workText.indexOf("Plugin slot outlet"));
        const primaryNavText = container.querySelector("nav > div:first-child")?.textContent ?? "";
        expect(primaryNavText).not.toContain("Plugin slot outlet");
      },
    );
  });

  it("shows the Inbox row with its badge when Inbox is visible", async () => {
    mockInboxBadge.inbox = 4;
    mockInboxBadge.failedRuns = 1;
    await withSidebar({ inboxUnread: 4 }, () => {
      const inbox = container.querySelector('a[href="/inbox"]');
      expect(inbox?.textContent).toContain("Inbox");
      expect(inbox?.textContent).toContain("4");
      expect(inbox?.closest("nav > div:first-child")).not.toBeNull();
    });
  });

  it("hides the Inbox row while there is nothing waiting", async () => {
    await withSidebar({ inboxUnread: 0 }, () => {
      expect(hrefs()).not.toContain("/inbox");
    });
  });

  it("with Combined Inbox + Task List on, drops the Inbox row and moves its unread badge onto Tasks", async () => {
    mockInboxBadge.inbox = 7;
    await withSidebar(
      { inboxUnread: 7, flags: { enableCombinedInboxTasks: true } },
      () => {
        expect(hrefs()).not.toContain("/inbox");
        const tasksLink = container.querySelector('a[href="/issues"]');
        expect(tasksLink?.textContent).toContain("Tasks");
        expect(tasksLink?.textContent).toContain("7");
      },
      { enableCombinedInboxTasks: true },
    );
  });

  it("leads the Work group with Chat once there is more than one agent, alongside Workspaces", async () => {
    await withSidebar(
      {
        preferences: { showEverything: true },
        signals: { agents: 2 },
        flags: { enableIsolatedWorkspaces: true },
      },
      () => {
        const chatLink = container.querySelector('a[href="/chats"]');
        expect(chatLink?.textContent).toContain("Chat");
        const workText = [...container.querySelectorAll("nav > div")]
          .find((section) => section.textContent?.startsWith("Work"))?.textContent ?? "";
        expect(workText.indexOf("Chat")).toBeLessThan(workText.indexOf("Tasks"));
        expect(hrefs()).toContain("/workspaces");
      },
    );
  });

  it("adds no chat surface for a company with fewer than two agents", async () => {
    await withSidebar({}, () => {
      expect(hrefs()).not.toContain("/chats");
    });
  });

  it("does not poll attention until Decisions is visible", async () => {
    await withSidebar({ flags: { enableDecisions: true } }, () => {
      // Available but not yet grown: hidden, so no polling.
      expect(hrefs()).not.toContain("/decisions");
      expect(mockAttentionApi.list).not.toHaveBeenCalled();
    }, { enableDecisions: true });
  });

  it("polls attention and shows Decisions with Status below it once both are visible", async () => {
    await withSidebar(
      {
        signals: { approvalsEver: 1 },
        preferences: { pinned: ["nav.status"] },
        flags: { enableDecisions: true, enableStatusCards: true },
      },
      () => {
        const primaryNavLinks = [...container.querySelectorAll("nav > div:first-child a")];
        const decisionsLink = primaryNavLinks.find((a) => a.getAttribute("href") === "/decisions");
        const statusLink = primaryNavLinks.find((a) => a.getAttribute("href") === "/status");
        expect(decisionsLink).toBeDefined();
        expect(statusLink?.textContent).toContain("beta");
        expect(primaryNavLinks.indexOf(statusLink!)).toBe(primaryNavLinks.indexOf(decisionsLink!) + 1);
        expect(mockAttentionApi.list).toHaveBeenCalled();
      },
      { enableDecisions: true, enableStatusCards: true },
    );
  });

  it("shows Pipelines only when its flag is on and it was revealed, visited or everything is shown", async () => {
    await withSidebar({ preferences: { showEverything: true }, flags: { enablePipelines: false } }, () => {
      expect(hrefs()).not.toContain("/pipelines");
    });
    await withSidebar({ flags: { enablePipelines: true } }, () => {
      expect(hrefs()).not.toContain("/pipelines");
    });
    await withSidebar({ preferences: { showEverything: true }, flags: { enablePipelines: true } }, () => {
      expect(hrefs()).toContain("/pipelines");
    });
    await withSidebar(
      {
        preferences: {
          revealed: { "nav.pipelines": "2026-01-01T00:00:00.000Z" },
          seen: { "nav.pipelines": "2026-01-01T00:00:00.000Z" },
        },
        flags: { enablePipelines: true },
      },
      () => {
        expect(hrefs()).toContain("/pipelines");
      },
    );
  });

  it("links Connectors to /apps", async () => {
    await withSidebar({ signals: { connections: 1 } }, () => {
      const connectors = [...container.querySelectorAll("nav a")].find((a) => a.textContent?.includes("Connectors"));
      expect(connectors?.getAttribute("href")).toBe("/apps");
    });
  });

  it("labels Status with a beta badge", async () => {
    await withSidebar(
      { preferences: { pinned: ["nav.status"] }, flags: { enableStatusCards: true } },
      () => {
        const status = container.querySelector('a[href="/status"]');
        const badges = [...(status?.querySelectorAll("span") ?? [])].map((span) => span.textContent?.trim());
        expect(badges).toContain("beta");
        expect(status?.textContent).not.toContain("new");
      },
    );
  });

  it("shows the beta badge on Cases", async () => {
    await withSidebar(
      { preferences: { pinned: ["nav.cases"] }, flags: { enableCases: true } },
      () => {
        expect(container.querySelector('a[href="/cases"]')?.textContent).toContain("beta");
      },
    );
  });

  it("attaches the live run count to Dashboard", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([{ id: "r1", issueId: "i1" }]);
    await withSidebar({}, () => {
      expect(container.querySelector('a[href="/dashboard"]')?.textContent).toContain("1 live");
    });
  });

  it("no-flash: before surfaces are ready it renders only core, pinned and already revealed surfaces", async () => {
    await withSidebar(
      {
        ready: false,
        signals: { routines: 2, artifacts: 3, projects: 5 },
        preferences: { revealed: { "nav.routines": "2026-01-01T00:00:00.000Z" }, pinned: ["nav.goals"] },
      },
      () => {
        expect(hrefs()).toContain("/dashboard");
        expect(hrefs()).toContain("/issues");
        expect(hrefs()).toContain("/agents");
        expect(hrefs()).toContain("/routines");
        expect(hrefs()).toContain("/goals");
        // Growth-only surfaces wait for ready so nothing renders then disappears.
        expect(hrefs()).not.toContain("/artifacts");
        expect(hrefs()).not.toContain("/projects");
      },
    );
  });

  it("no-flash: flag-gated surfaces wait for ready even when pinned", async () => {
    await withSidebar(
      { ready: false, preferences: { pinned: ["nav.cases"] }, signals: { agents: 2 }, flags: { enableCases: true } },
      () => {
        expect(hrefs()).not.toContain("/cases");
        expect(hrefs()).not.toContain("/chats");
        expect(hrefs()).toContain("/issues");
      },
    );
  });

  it("no-flash: once ready the grown surfaces appear", async () => {
    await withSidebar({ ready: true, signals: { artifacts: 3, projects: 5 } }, () => {
      expect(hrefs()).toContain("/artifacts");
      expect(hrefs()).toContain("/projects");
    });
  });

  it("does not render a global navigation collapse affordance", async () => {
    await withSidebar({}, () => {
      expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();
      expect(container.textContent).toContain("Company menu");
    });
  });

  it("hides the collapse affordance on mobile (drawer handles it)", async () => {
    mockSidebar.isMobile = true;
    await withSidebar({}, () => {
      expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();
    });
  });
});

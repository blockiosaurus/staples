// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";
import { makeSurfacesFixture, type SurfacesFixture } from "../staples/surfaces/testing";

const surfacesState = vi.hoisted(() => ({ current: null as unknown as SurfacesFixture }));
const inboxBadge = vi.hoisted(() => ({ inbox: 0, failedRuns: 0 }));
const combined = vi.hoisted(() => ({ enabled: false }));

vi.mock("../staples/surfaces/useSurfaces", () => ({ useSurfaces: () => surfacesState.current }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => inboxBadge }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({
  useCombinedInboxTasksEnabled: () => ({ enabled: combined.enabled }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/" }),
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>
      {typeof children === "function" ? children({ isActive: false }) : children}
    </a>
  ),
}));

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;
  let lastText = "";

  function labels(fixture: SurfacesFixture) {
    surfacesState.current = fixture;
    const root = createRoot(container);
    flushSync(() => {
      root.render(<MobileBottomNav visible />);
    });
    const result = [...container.querySelectorAll("nav a, nav button")].map((el) => el.querySelector("span.truncate")?.textContent?.trim());
    lastText = container.textContent ?? "";
    flushSync(() => root.unmount());
    return result;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    inboxBadge.inbox = 0;
    combined.enabled = false;
  });

  afterEach(() => {
    container.remove();
  });

  it("fresh company shows Home, New Task, Tasks and Agents", () => {
    expect(labels(makeSurfacesFixture())).toEqual(["Home", "New Task", "Tasks", "Agents"]);
  });

  it("adds Inbox when the Inbox surface is visible", () => {
    inboxBadge.inbox = 3;
    expect(labels(makeSurfacesFixture({ inboxUnread: 3 }))).toEqual(["Home", "New Task", "Tasks", "Agents", "Inbox"]);
  });

  it("adds Chat second once there is more than one agent", () => {
    expect(labels(makeSurfacesFixture({ signals: { agents: 2 } }))).toEqual([
      "Home", "Chat", "New Task", "Tasks", "Agents",
    ]);
  });

  it("with Combined Inbox + Tasks, drops Inbox and puts the badge on Tasks", () => {
    inboxBadge.inbox = 5;
    combined.enabled = true;
    expect(labels(makeSurfacesFixture({ inboxUnread: 5, flags: { enableCombinedInboxTasks: true } }))).toEqual([
      "Home", "New Task", "Tasks", "Agents",
    ]);
    expect(lastText).toContain("5");
  });
});

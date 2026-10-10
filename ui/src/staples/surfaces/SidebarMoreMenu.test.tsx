// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarMoreMenu } from "./SidebarMoreMenu";
import { makeSurfacesFixture } from "./testing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
const update = vi.fn();
let fixture = makeSurfacesFixture();
let rail = false;

vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("../../context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: rail, peeking: false }) }));
vi.mock("./useSurfaces", () => ({ useSurfaces: () => ({ ...fixture, update }) }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span data-testid="tooltip">{children}</span>,
}));
// Radix popovers portal and need pointer events; render content inline when open.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children, open }: { children: ReactNode; open?: boolean }) => (
    <div data-open={String(open)}>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="more-content">{children}</div>,
}));

describe("SidebarMoreMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render() {
    act(() => {
      root.render(<SidebarMoreMenu />);
    });
  }
  function button(text: string) {
    return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigate.mockReset();
    update.mockReset();
    rail = false;
    fixture = makeSurfacesFixture({ signals: { projects: 2 } });
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("lists hidden available surfaces under Open and navigates on click", () => {
    render();
    const routines = button("Routines");
    expect(routines).toBeDefined();
    act(() => routines!.click());
    expect(navigate).toHaveBeenCalledWith("/routines");
  });

  it("hides a visible non-core surface", () => {
    render();
    const hide = container.querySelector('button[aria-label="Hide Projects"]') as HTMLButtonElement;
    expect(hide).not.toBeNull();
    act(() => hide.click());
    expect(update).toHaveBeenCalledWith({ hide: ["nav.projects"] });
  });

  it("unhides a person-hidden surface only under In your sidebar", () => {
    fixture = makeSurfacesFixture({ signals: { projects: 2 }, preferences: { hidden: ["nav.projects"] } });
    render();
    const unhide = container.querySelector('button[aria-label="Unhide Projects"]') as HTMLButtonElement;
    expect(unhide).not.toBeNull();
    expect(button("Projects")).toBeUndefined();
    act(() => unhide.click());
    expect(update).toHaveBeenCalledWith({ unhide: ["nav.projects"] });
  });

  it("toggles Show everything", () => {
    render();
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement;
    act(() => sw.click());
    expect(update).toHaveBeenCalledWith({ showEverything: true });
  });

  it("renders nothing when nothing qualifies", () => {
    fixture = { ...makeSurfacesFixture(), hiddenAvailable: [], visible: fixture.visible.filter((s) => s.surface.tier === "core") };
    render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing until surfaces are ready", () => {
    fixture = makeSurfacesFixture({ signals: { projects: 2 }, ready: false });
    render();
    expect(container.innerHTML).toBe("");
  });

  it("disables hide, unhide and Show everything while preferences failed to load", () => {
    fixture = makeSurfacesFixture({
      signals: { projects: 2, routines: 1 },
      preferences: { hidden: ["nav.routines"] },
      preferencesFailed: true,
    });
    render();
    const hide = container.querySelector('button[aria-label="Hide Projects"]') as HTMLButtonElement;
    const unhide = container.querySelector('button[aria-label="Unhide Routines"]') as HTMLButtonElement;
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(hide.disabled).toBe(true);
    expect(unhide.disabled).toBe(true);
    expect(sw.disabled).toBe(true);
    act(() => hide.click());
    expect(update).not.toHaveBeenCalled();
  });

  it("moves focus to Unhide after hiding", () => {
    render();
    update.mockImplementation(() => {
      fixture = makeSurfacesFixture({ signals: { projects: 2 }, preferences: { hidden: ["nav.projects"] } });
    });
    const hide = container.querySelector('button[aria-label="Hide Projects"]') as HTMLButtonElement;
    hide.focus();
    act(() => hide.click());
    render();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Unhide Projects");
  });

  it("moves focus to Hide after unhiding", () => {
    fixture = makeSurfacesFixture({ signals: { projects: 2 }, preferences: { hidden: ["nav.projects"] } });
    render();
    update.mockImplementation(() => {
      fixture = makeSurfacesFixture({ signals: { projects: 2 } });
    });
    const unhide = container.querySelector('button[aria-label="Unhide Projects"]') as HTMLButtonElement;
    act(() => unhide.click());
    render();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Hide Projects");
  });

  it("falls back to the menu content when the counterpart control is absent", () => {
    fixture = makeSurfacesFixture({ signals: { projects: 2 }, preferences: { hidden: ["nav.goals"] } });
    render();
    update.mockImplementation(() => {
      fixture = makeSurfacesFixture({ signals: { projects: 2 } });
    });
    const unhide = container.querySelector('button[aria-label="Unhide Goals"]') as HTMLButtonElement;
    act(() => unhide.click());
    render();
    expect(document.activeElement?.getAttribute("data-more-menu-content")).toBe("");
  });

  it("labels each section by its visible heading", () => {
    fixture = makeSurfacesFixture({ signals: { projects: 2 }, preferences: { hidden: ["nav.goals"] } });
    render();
    const sections = Array.from(container.querySelectorAll("section"));
    expect(sections.length).toBe(2);
    for (const section of sections) {
      expect(section.getAttribute("aria-label")).toBeNull();
      const heading = document.getElementById(section.getAttribute("aria-labelledby") ?? "");
      expect(heading).not.toBeNull();
      expect(section.contains(heading)).toBe(true);
    }
    expect(sections.map((section) => document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent)).toEqual([
      "Open",
      "In your sidebar",
    ]);
  });

  it("shows a tooltip label in rail mode", () => {
    rail = true;
    render();
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe("More");
  });
});

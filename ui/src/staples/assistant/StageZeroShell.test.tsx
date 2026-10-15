// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageZeroShell } from "./StageZeroShell";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  available: false,
  setupState: "ready" as string,
  askAssistant: vi.fn(() => true),
}));

vi.mock("./AssistantProvider", () => ({
  useAssistantShell: () => ({ available: mocks.available, askAssistant: mocks.askAssistant }),
}));
vi.mock("./useAssistant", () => ({
  useAssistant: () => ({ setup: mocks.available ? { state: mocks.setupState } : null }),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: "c1", issuePrefix: "NEW" } }) }));
vi.mock("./BrandStarterCard", () => ({ BrandStarterCard: () => null }));
vi.mock("./AssistantConversation", () => ({ AssistantConversation: () => null }));
vi.mock("@/components/CompanySwitcher", () => ({ CompanySwitcher: () => null }));
vi.mock("@/components/SidebarAccountMenu", () => ({ SidebarAccountMenu: () => null }));

let seenState: unknown;
function Probe() {
  seenState = useLocation().state;
  return null;
}

describe("StageZeroShell first message", () => {
  let container: HTMLDivElement;
  let root: Root;

  function tree(state: unknown) {
    return (
      <MemoryRouter initialEntries={[{ pathname: "/NEW/assistant", state }]}>
        <StageZeroShell />
        <Probe />
      </MemoryRouter>
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.available = false;
    mocks.setupState = "ready";
    mocks.askAssistant.mockClear();
    mocks.askAssistant.mockReturnValue(true);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("sends the description once the Assistant is ready, then clears the router state", async () => {
    await act(async () => root.render(tree({ firstMessage: "A candle shop" })));
    expect(mocks.askAssistant).not.toHaveBeenCalled();

    mocks.available = true;
    await act(async () => root.render(tree({ firstMessage: "A candle shop" })));
    expect(mocks.askAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.askAssistant).toHaveBeenCalledWith({
      text: "A candle shop",
      send: true,
      context: { label: expect.stringContaining("Time zone"), href: "/start" },
    });
    expect(seenState).toBeNull();

    await act(async () => root.render(tree({ firstMessage: "A candle shop" })));
    expect(mocks.askAssistant).toHaveBeenCalledTimes(1);
  });

  it("waits while setup is still starting", async () => {
    mocks.available = true;
    mocks.setupState = "starting";
    await act(async () => root.render(tree({ firstMessage: "A candle shop" })));
    expect(mocks.askAssistant).not.toHaveBeenCalled();
    mocks.setupState = "ready";
    await act(async () => root.render(tree({ firstMessage: "A candle shop" })));
    expect(mocks.askAssistant).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a first message", async () => {
    mocks.available = true;
    await act(async () => root.render(tree(null)));
    expect(mocks.askAssistant).not.toHaveBeenCalled();
  });
});

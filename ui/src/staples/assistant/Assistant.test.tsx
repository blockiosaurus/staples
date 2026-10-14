// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { PanelProvider, usePanel } from "@/context/PanelContext";
import { ApiError } from "@/api/client";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ASSISTANT_DOCK_OPEN_STORAGE_KEY, AssistantProvider, composeAskText, useAssistantShell, type AssistantShellValue } from "./AssistantProvider";
import { AssistantDock, AssistantDockToggle } from "./AssistantDock";
import { AssistantPage } from "./AssistantPage";
import { StageZeroShell } from "./StageZeroShell";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  companyId: "company-1",
  location: { pathname: "/PAP/issues/PAP-12", search: "", hash: "", state: null, key: "k" },
  navigate: vi.fn(),
  isMobile: false,
  assistantGet: vi.fn(),
  agentGet: vi.fn(),
  chatGet: vi.fn(),
  chatEnsure: vi.fn(),
  surfaceProps: [] as Array<{ conversation: Record<string, unknown> }>,
  fill: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: mocks.companyId, selectedCompany: { id: mocks.companyId, issuePrefix: "PAP", name: "Acme" } }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mocks.isMobile }) }));
vi.mock("@/api/assistant", () => ({ assistantApi: { get: mocks.assistantGet } }));
vi.mock("./AssistantSetupCard", () => ({
  AssistantSetupCard: ({ setup, canConfigure }: { setup: { state: string }; canConfigure: boolean }) => (
    <div data-testid="setup-card" data-can-configure={String(canConfigure)}>Setup: {setup.state}</div>
  ),
}));
vi.mock("@/components/CompanySwitcher", () => ({ CompanySwitcher: () => <div>Company switcher</div> }));
vi.mock("@/components/SidebarAccountMenu", () => ({ SidebarAccountMenu: () => <div>Account menu</div> }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: mocks.agentGet } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: mocks.chatGet, ensure: mocks.chatEnsure } }));
vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => Promise.resolve({ user: { id: "user-1" }, session: { userId: "user-1" } }) },
}));
// The conversation surface itself is covered by IssueDetail tests; here we
// check what the Assistant hands it, and that the dock isolates page chrome.
vi.mock("@/pages/IssueDetail", () => ({
  TaskDetailSurface: (props: { conversation: { agent: { name: string }; embedded?: boolean } }) => {
    mocks.surfaceProps.push(props as never);
    const { setBreadcrumbs } = useBreadcrumbs();
    const { openPanel } = usePanel();
    useEffect(() => {
      // What the real surface does on mount; must not leak out of the dock.
      setBreadcrumbs([{ label: props.conversation.agent.name }]);
      openPanel(<div>conversation properties</div>);
    }, [setBreadcrumbs, openPanel, props.conversation.agent.name]);
    const conversation = props.conversation as typeof props.conversation & {
      emptyState?: (composer: { fill: (text: string) => void }) => React.ReactNode;
      composerReplacement?: React.ReactNode;
    };
    return (
      <div data-testid="assistant-surface">
        Conversation with {props.conversation.agent.name}
        {conversation.emptyState?.({ fill: mocks.fill })}
        <div data-testid="task-chat-composer-dock">
          {conversation.composerReplacement ?? (
            <div data-testid="stub-composer" contentEditable="true" suppressContentEditableWarning tabIndex={0} />
          )}
        </div>
      </div>
    );
  },
}));

const ASSISTANT = { id: "assistant-1", name: "Assistant", urlKey: "assistant", adapterType: "claude_local", status: "idle" };
const CONVERSATION = { id: "conv-1", companyId: "company-1", conversationAgentId: "assistant-1" };

function HostPage({ crumbs }: { crumbs: string[] }) {
  const { setBreadcrumbs, breadcrumbs } = useBreadcrumbs();
  const shell = useAssistantShell();
  useKeyboardShortcuts({ onToggleAssistant: shell?.toggleDock });
  useEffect(() => {
    setBreadcrumbs(crumbs.map((label) => ({ label })));
  }, [crumbs, setBreadcrumbs]);
  return (
    <>
      <span data-testid="host-crumbs">{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</span>
      <textarea data-testid="host-composer" />
      <AssistantDockToggle />
      <AssistantDock />
    </>
  );
}

describe("Assistant page and dock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.location.pathname = "/PAP/issues/PAP-12";
    mocks.isMobile = false;
    mocks.companyId = "company-1";
    mocks.surfaceProps.length = 0;
    mocks.fill.mockReset();
    mocks.navigate.mockReset();
    mocks.assistantGet.mockReset().mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1" });
    mocks.agentGet.mockReset().mockResolvedValue({ ...ASSISTANT, companyId: "company-1" });
    mocks.chatGet.mockReset().mockResolvedValue(CONVERSATION);
    mocks.chatEnsure.mockReset().mockResolvedValue(CONVERSATION);
    localStorage.clear();
    window.innerWidth = 1400;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function settle() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BreadcrumbProvider companyName="Acme">
            <PanelProvider>
              <AssistantProvider>{node}</AssistantProvider>
            </PanelProvider>
          </BreadcrumbProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  function pressJ(target: EventTarget, modifier: "metaKey" | "ctrlKey") {
    const event = new KeyboardEvent("keydown", { key: "j", [modifier]: true, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  const dock = () => container.querySelector('[data-testid="assistant-dock"]');
  const lastConversation = () => mocks.surfaceProps.at(-1)!.conversation as {
    agent: { id: string };
    issue: { id: string } | null;
    embedded?: boolean;
    commentMetadata?: () => unknown;
    onCommentSent?: () => void;
    focusComposerRequest?: number;
  };

  it("renders the Assistant conversation on the full page", async () => {
    mocks.location.pathname = "/PAP/assistant";
    await render(<AssistantPage />);
    expect(container.textContent).toContain("Conversation with Assistant");
    const conversation = lastConversation();
    expect(conversation.agent.id).toBe("assistant-1");
    expect(conversation.issue?.id).toBe("conv-1");
    expect(conversation.embedded).toBe(false);
    expect(mocks.chatGet).toHaveBeenCalledWith("company-1", "assistant-1");
    // The full page has no page to point at.
    expect(conversation.commentMetadata?.()).toBeUndefined();
    const brief = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Company brief"));
    expect(brief?.getAttribute("href")).toBe("/company/brief");
  });

  it("opens an empty conversation with a client-rendered bubble whose chips fill the composer", async () => {
    mocks.location.pathname = "/PAP/assistant";
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: null, setup: { state: "ready", adapterType: "claude_local" } });
    await render(<AssistantPage />);
    expect(container.querySelector('[data-testid="assistant-opening"]')?.textContent)
      .toContain("Hi, I'm your Assistant. What business are you starting, or what do you want help with?");
    const chips = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-opening"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "A dog-walking service in my neighborhood",
      "An online shop for my handmade candles",
      "A weekly newsletter for my customers",
    ]);
    await act(async () => chips[1]!.click());
    expect(mocks.fill).toHaveBeenCalledWith("An online shop for my handmade candles");
    // Nothing is sent: the bubble is not a message.
    expect(mocks.chatEnsure).not.toHaveBeenCalled();
  });

  it("shows the setup card instead of the composer until the Assistant can answer", async () => {
    mocks.location.pathname = "/PAP/assistant";
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1", setup: { state: "needs_model", adapterType: "claude_local" } });
    await render(<AssistantPage />);
    expect(container.querySelector('[data-testid="setup-card"]')?.textContent).toBe("Setup: needs_model");
    expect(container.querySelector('[data-testid="setup-card"]')?.getAttribute("data-can-configure")).toBe("true");
    expect(container.querySelector('[data-testid="stub-composer"]')).toBeNull();
    // Suggestions wait for a model too.
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="assistant-opening"] button');
    expect(chip?.disabled).toBe(true);
  });

  it("passes the viewer restriction to the setup card", async () => {
    mocks.location.pathname = "/PAP/assistant";
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1", canConfigure: false,
      setup: { state: "needs_model", adapterType: "claude_local" } });
    await render(<AssistantPage />);
    expect(container.querySelector('[data-testid="setup-card"]')?.getAttribute("data-can-configure")).toBe("false");
  });

  it("keeps the same setup card element across unrelated renders", async () => {
    mocks.location.pathname = "/PAP/assistant";
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1", setup: { state: "needs_model", adapterType: "claude_local" } });
    await render(<AssistantPage />);
    const cards = mocks.surfaceProps.map((props) => props.conversation.composerReplacement).filter(Boolean);
    expect(cards.length).toBeGreaterThan(1);
    expect(new Set(cards).size).toBe(1);
  });

  it("polls while the Assistant is starting and swaps the card for the composer once ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.location.pathname = "/PAP/assistant";
      mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1", setup: { state: "starting", adapterType: "claude_local" } });
      await render(<AssistantPage />);
      expect(container.querySelector('[data-testid="setup-card"]')?.textContent).toBe("Setup: starting");
      mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: "conv-1", setup: { state: "ready", adapterType: "claude_local" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      await settle();
      expect(container.querySelector('[data-testid="setup-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="stub-composer"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show the opening bubble in the dock", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: null });
    await render(<HostPage crumbs={["Issues"]} />);
    expect(dock()).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-opening"]')).toBeNull();
  });

  it("renders stage 0 as the full-screen Assistant with the opening bubble and no dock", async () => {
    mocks.location.pathname = "/PAP/dashboard";
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: null, setup: { state: "ready", adapterType: "claude_local" } });
    await render(<StageZeroShell />);
    expect(container.querySelector('[data-testid="stage-zero-shell"]')).not.toBeNull();
    expect(container.textContent).toContain("Company switcher");
    expect(container.textContent).toContain("Account menu");
    expect(container.querySelector('[data-testid="assistant-opening"]')).not.toBeNull();
    expect(dock()).toBeNull();
  });

  it("shows an inline error with retry when the Assistant is unavailable", async () => {
    mocks.location.pathname = "/PAP/assistant";
    mocks.assistantGet.mockRejectedValue(new ApiError("Assistant provisioning failed", 403, null));
    await render(<AssistantPage />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Assistant provisioning failed");
    expect(container.textContent).not.toContain("Conversation with Assistant");

    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: null });
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!;
    await act(async () => retry.click());
    await settle();
    expect(container.textContent).toContain("Conversation with Assistant");
  });

  it("toggles the dock with Cmd+J and Ctrl+J while typing in a textarea, and remembers it", async () => {
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    expect(dock()).toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="host-composer"]')!;
    textarea.focus();

    const open = pressJ(textarea, "metaKey");
    await settle();
    expect(open.defaultPrevented).toBe(true);
    expect(dock()).not.toBeNull();
    expect(localStorage.getItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY)).toBe("true");
    expect(container.textContent).toContain("Conversation with Assistant");
    expect(lastConversation().embedded).toBe(true);

    pressJ(textarea, "ctrlKey");
    await settle();
    expect(dock()).toBeNull();
    expect(localStorage.getItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY)).toBe("false");

    pressJ(textarea, "ctrlKey");
    await settle();
    expect(dock()).not.toBeNull();
  });

  it("opens from the remembered state and keeps the conversation from taking over page chrome", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    expect(dock()).not.toBeNull();
    expect(container.textContent).toContain("Conversation with Assistant");
    expect(container.querySelector('[data-testid="host-crumbs"]')?.textContent).toBe("Tasks / Fix login");
  });

  it("attaches the issue page's context to messages sent from the dock", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    expect(container.querySelector('[data-testid="assistant-seeing-chip"]')?.textContent).toContain("Seeing: Fix login");
    expect(lastConversation().commentMetadata?.()).toEqual({
      pageContext: {
        route: "/issues/PAP-12",
        title: "Fix login • Tasks • Acme • Paperclip",
        entity: { type: "issue", id: "PAP-12", label: "Fix login" },
      },
    });
  });

  it("drops the context until a message is actually sent when the person clicks ×", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    const drop = container.querySelector<HTMLButtonElement>('button[aria-label="Don\'t share this page with the next message"]')!;
    await act(async () => drop.click());
    expect(container.textContent).toContain("Not sharing this page");

    // A send that fails (no onCommentSent) keeps the context dropped for the retry.
    expect(lastConversation().commentMetadata?.()).toBeUndefined();
    expect(lastConversation().commentMetadata?.()).toBeUndefined();
    expect(container.textContent).toContain("Not sharing this page");

    await act(async () => lastConversation().onCommentSent?.());
    await settle();
    expect(container.querySelector('[data-testid="assistant-seeing-chip"]')).not.toBeNull();
    expect(lastConversation().commentMetadata?.()).toMatchObject({ pageContext: { entity: { type: "issue", id: "PAP-12" } } });
  });

  it("moves focus into the dock on open, closes on Escape, and returns focus", async () => {
    window.innerWidth = 1400;
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="host-composer"]')!;
    textarea.focus();
    pressJ(textarea, "metaKey");
    await settle();
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(lastConversation().focusComposerRequest).toBe(1);
    expect(dock()?.contains(document.activeElement)).toBe(true);
    // Once the composer is interactive, focus lands in it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("stub-composer");

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { document.activeElement!.dispatchEvent(escape); });
    await settle();
    expect(dock()).toBeNull();
    expect(document.activeElement).toBe(textarea);

    // Reopening asks the surface to focus its composer again.
    pressJ(textarea, "ctrlKey");
    await settle();
    expect(lastConversation().focusComposerRequest).toBe(2);
    pressJ(document.activeElement!, "ctrlKey");
    await settle();
    expect(dock()).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("does not steal focus when the dock is restored open on page load", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Dashboard"]} />);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(lastConversation().focusComposerRequest).toBe(0);
    expect(dock()?.contains(document.activeElement)).toBe(false);
  });

  it("stays in the flex row at 1280px and up, and overlays the page below", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    window.innerWidth = 1280;
    await render(<HostPage crumbs={["Dashboard"]} />);
    expect(dock()?.getAttribute("data-dock-mode")).toBe("docked");
    expect(dock()?.className).not.toContain("fixed");

    window.innerWidth = 1100;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(dock()?.getAttribute("data-dock-mode")).toBe("overlay");
    expect(dock()?.className).toContain("fixed inset-y-0 right-0");
    expect(dock()?.className).toContain("shadow-lg");
    expect(dock()?.getAttribute("role")).toBeNull();
  });

  it("hides the dock while the page itself shows the Assistant conversation", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    function ClaimingPage({ agentId }: { agentId: string }) {
      const shell = useAssistantShell();
      const claim = shell?.claimConversationPage;
      useEffect(() => (claim ? claim(agentId) : undefined), [claim, agentId]);
      return null;
    }
    await render(<><ClaimingPage agentId="alice" /><HostPage crumbs={["Chats"]} /></>);
    expect(dock()).not.toBeNull();
    await render(<><ClaimingPage agentId="assistant-1" /><HostPage crumbs={["Chats"]} /></>);
    expect(dock()).toBeNull();
    await render(<HostPage crumbs={["Chats"]} />);
    expect(dock()).not.toBeNull();
  });

  it("shows the header toggle only once the Assistant is available", async () => {
    mocks.assistantGet.mockRejectedValue(new ApiError("nope", 404, null));
    await render(<HostPage crumbs={["Dashboard"]} />);
    expect(container.querySelector('button[aria-label="Open the Assistant"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.assistantGet.mockResolvedValue({ agent: ASSISTANT, conversationIssueId: null });
    await render(<HostPage crumbs={["Dashboard"]} />);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Open the Assistant"]')!;
    expect(toggle).not.toBeNull();
    await act(async () => toggle.click());
    await settle();
    expect(dock()).not.toBeNull();
  });

  it("shows an inline error with retry inside the dock when the Assistant fails to load", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    mocks.assistantGet.mockRejectedValue(new ApiError("Assistant down", 404, null));
    await render(<HostPage crumbs={["Dashboard"]} />);
    expect(dock()?.querySelector('[role="alert"]')?.textContent).toContain("Assistant down");
  });

  it("renders as a full-screen modal sheet on mobile that keeps focus inside", async () => {
    mocks.isMobile = true;
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Dashboard"]} />);
    const sheet = dock()!;
    expect(sheet.className).toContain("fixed inset-0");
    expect(sheet.querySelector('[data-presentation="sheet"]')).not.toBeNull();
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.getAttribute("aria-label")).toBe("Assistant");

    const first = sheet.querySelectorAll<HTMLButtonElement>("button")[0]!;
    const last = sheet.querySelector<HTMLElement>('[data-testid="stub-composer"]')!;
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { last.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    act(() => { first.dispatchEvent(back); });
    expect(document.activeElement).toBe(last);

    // Cmd/Ctrl+J still closes the sheet even though it is a modal dialog.
    pressJ(last, "ctrlKey");
    await settle();
    expect(dock()).toBeNull();
  });

  it("stays out of the way on the full Assistant page and opens it from the header", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    const full = container.querySelector<HTMLButtonElement>('button[aria-label="Open the Assistant full page"]')!;
    await act(async () => full.click());
    expect(mocks.navigate).toHaveBeenCalledWith("/assistant");
    expect(dock()).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    mocks.location.pathname = "/PAP/assistant";
    await render(<HostPage crumbs={["Assistant"]} />);
    expect(dock()).toBeNull();
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await render(<HostPage crumbs={["Dashboard"]} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="host-composer"]')!;
    pressJ(textarea, "metaKey");
    await settle();
    expect(dock()).not.toBeNull();
  });

  describe("askAssistant", () => {
    let shellRef: AssistantShellValue | null = null;
    function Capture() {
      shellRef = useAssistantShell();
      return null;
    }

    it("composes a plain About line from the context", () => {
      expect(composeAskText({ text: "What is blocking this?", context: { label: "Fix login", href: "/PAP/issues/PAP-12" } }))
        .toBe("What is blocking this?\n\nAbout: Fix login (/PAP/issues/PAP-12)");
      expect(composeAskText({ text: "Hi" })).toBe("Hi");
    });

    it("opens the dock with a pending draft that is consumed once", async () => {
      await render(<><Capture /><HostPage crumbs={["Home"]} /></>);
      expect(dock()).toBeNull();
      await act(async () => {
        shellRef!.askAssistant({ text: "Summarize", context: { label: "Fix login", href: "/PAP/issues/PAP-12" } });
      });
      await settle();
      expect(dock()).not.toBeNull();
      const first = shellRef!.pendingAsk!;
      expect(first).toMatchObject({ text: "Summarize\n\nAbout: Fix login (/PAP/issues/PAP-12)", send: false });
      act(() => shellRef!.consumeAsk(first.nonce));
      expect(shellRef!.pendingAsk).toBeNull();
      await act(async () => shellRef!.askAssistant({ text: "Again", send: true }));
      expect(shellRef!.pendingAsk!.nonce).toBeGreaterThan(first.nonce);
      expect(shellRef!.pendingAsk!.send).toBe(true);
    });

    it("reports that an ask was taken", async () => {
      await render(<><Capture /><HostPage crumbs={["Home"]} /></>);
      let taken: boolean | undefined;
      await act(async () => { taken = shellRef!.askAssistant({ text: "Hello", send: true }); });
      expect(taken).toBe(true);
      expect(shellRef!.pendingAsk?.send).toBe(true);
    });

    it("refuses an auto-send ask when the Assistant cannot be reached", async () => {
      mocks.assistantGet.mockRejectedValue(new ApiError("Assistant down", 404, null));
      await render(<><Capture /><HostPage crumbs={["Home"]} /></>);
      await settle();
      expect(shellRef!.available).toBe(false);
      let taken: boolean | undefined;
      await act(async () => { taken = shellRef!.askAssistant({ text: "Hello", send: true }); });
      expect(taken).toBe(false);
      expect(shellRef!.pendingAsk).toBeNull();
    });

    it("drops a never-consumed ask when the dock closes", async () => {
      await render(<><Capture /><HostPage crumbs={["Home"]} /></>);
      await act(async () => shellRef!.askAssistant({ text: "Hello" }));
      expect(shellRef!.pendingAsk?.text).toBe("Hello");
      await act(async () => shellRef!.setDockOpen(false));
      expect(shellRef!.pendingAsk).toBeNull();
    });

    async function askAndNavigate(node: React.ReactNode, pathname: string) {
      await act(async () => {
        shellRef!.askAssistant({ text: "Hello" });
        mocks.location = { ...mocks.location, pathname };
        root.render(
          <QueryClientProvider client={queryClient}>
            <BreadcrumbProvider companyName="Acme">
              <PanelProvider>
                <AssistantProvider>{node}</AssistantProvider>
              </PanelProvider>
            </BreadcrumbProvider>
          </QueryClientProvider>,
        );
      });
      await settle();
    }

    it("keeps an ask issued in the same tick as a navigation to another page", async () => {
      const tree = <><Capture /><HostPage crumbs={["Home"]} /></>;
      await render(tree);
      await askAndNavigate(tree, "/PAP/issues/PAP-99");
      expect(dock()).not.toBeNull();
      expect(shellRef!.pendingAsk?.text).toBe("Hello");
    });

    it("keeps an ask issued in the same tick as a navigation to the Assistant page", async () => {
      const tree = <><Capture /><AssistantPage /><AssistantDock /></>;
      await render(<><Capture /><HostPage crumbs={["Home"]} /></>);
      await askAndNavigate(tree, "/PAP/assistant");
      expect(container.textContent).toContain("Conversation with Assistant");
      expect(dock()).toBeNull();
      expect(shellRef!.pendingAsk?.text).toBe("Hello");
    });

    it("keeps the dock closed on the Assistant page and clears a pending draft on company switch", async () => {
      mocks.location.pathname = "/PAP/assistant";
      await render(<><Capture /><AssistantPage /><AssistantDock /></>);
      await act(async () => shellRef!.askAssistant({ text: "Hello" }));
      expect(dock()).toBeNull();
      expect(shellRef!.pendingAsk?.text).toBe("Hello");
      mocks.companyId = "company-2";
      await render(<><Capture /><AssistantPage /><AssistantDock /></>);
      expect(shellRef!.pendingAsk).toBeNull();
    });
  });
});

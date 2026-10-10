// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { PanelProvider, usePanel } from "@/context/PanelContext";
import { ApiError } from "@/api/client";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ASSISTANT_DOCK_OPEN_STORAGE_KEY, AssistantProvider, useAssistantShell } from "./AssistantProvider";
import { AssistantDock, AssistantDockToggle } from "./AssistantDock";
import { AssistantPage } from "./AssistantPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  location: { pathname: "/PAP/issues/PAP-12", search: "", hash: "", state: null, key: "k" },
  navigate: vi.fn(),
  isMobile: false,
  assistantGet: vi.fn(),
  agentGet: vi.fn(),
  chatGet: vi.fn(),
  chatEnsure: vi.fn(),
  surfaceProps: [] as Array<{ conversation: Record<string, unknown> }>,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Acme" } }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mocks.isMobile }) }));
vi.mock("@/api/assistant", () => ({ assistantApi: { get: mocks.assistantGet } }));
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
    return (
      <div data-testid="assistant-surface">
        Conversation with {props.conversation.agent.name}
        <div data-testid="task-chat-composer-dock">
          <div data-testid="stub-composer" contentEditable="true" suppressContentEditableWarning tabIndex={0} />
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
    mocks.surfaceProps.length = 0;
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
});

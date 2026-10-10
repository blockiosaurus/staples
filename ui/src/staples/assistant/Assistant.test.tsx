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
    return <div data-testid="assistant-surface">Conversation with {props.conversation.agent.name}</div>;
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

  it("drops the context for the next message only when the person clicks ×", async () => {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Tasks", "Fix login"]} />);
    const drop = container.querySelector<HTMLButtonElement>('button[aria-label="Don\'t share this page with the next message"]')!;
    await act(async () => drop.click());
    expect(container.textContent).toContain("Not sharing this page");

    let metadata: unknown;
    await act(async () => {
      metadata = lastConversation().commentMetadata?.();
    });
    expect(metadata).toBeUndefined();
    await settle();
    expect(container.querySelector('[data-testid="assistant-seeing-chip"]')).not.toBeNull();
    expect(lastConversation().commentMetadata?.()).toMatchObject({ pageContext: { entity: { type: "issue", id: "PAP-12" } } });
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

  it("renders as a full-screen sheet on mobile", async () => {
    mocks.isMobile = true;
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, "true");
    await render(<HostPage crumbs={["Dashboard"]} />);
    expect(dock()?.className).toContain("fixed inset-0");
    expect(dock()?.querySelector('[data-presentation="sheet"]')).not.toBeNull();
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

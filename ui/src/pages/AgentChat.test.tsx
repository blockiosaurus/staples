// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";

const mocks = vi.hoisted(() => ({ agentRef: "assistant", list: vi.fn(), chat: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.list, get: vi.fn() } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: mocks.chat, ensure: vi.fn() } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => Promise.resolve({ user: { id: "user-1" } }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/recent-agent-chats", () => ({ recordAgentChatVisit: vi.fn() }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ agentRef: mocks.agentRef }),
  Navigate: ({ to }: { to: string }) => <span data-testid="navigate">{to}</span>,
}));
vi.mock("./IssueDetail", () => ({ TaskDetailSurface: () => <span data-testid="surface" /> }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.list.mockResolvedValue([
    { id: "alice", companyId: "company-1", name: "Alice", urlKey: "alice", metadata: null },
    {
      id: "assistant-1", companyId: "company-1", name: "Assistant", urlKey: "assistant",
      metadata: { paperclipBuiltInAgent: { key: "assistant", featureKeys: ["assistant"] } },
    },
  ]);
  mocks.chat.mockResolvedValue(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><AgentChat /></QueryClientProvider>));
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

it.each(["assistant", "assistant-1"])("redirects the Assistant's agent chat route (%s) to /assistant", async (ref) => {
  mocks.agentRef = ref;
  await render();
  expect(container.querySelector('[data-testid="navigate"]')?.textContent).toBe("/assistant");
  expect(container.querySelector('[data-testid="surface"]')).toBeNull();
});

it("keeps ordinary agent chats on /chats", async () => {
  mocks.agentRef = "alice";
  await render();
  expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  expect(container.querySelector('[data-testid="surface"]')).not.toBeNull();
});

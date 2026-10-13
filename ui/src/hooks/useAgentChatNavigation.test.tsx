// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentChatNavigation } from "./useAgentChatNavigation";

const mocks = vi.hoisted(() => ({ list: vi.fn(), chats: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.list } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: mocks.chats } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => Promise.resolve({ user: { id: "user-1" } }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let observed: ReturnType<typeof useAgentChatNavigation> | null = null;

function Probe() {
  observed = useAgentChatNavigation();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.list.mockResolvedValue([
    { id: "alice", name: "Alice", metadata: null },
    { id: "assistant-1", name: "Assistant", metadata: { paperclipBuiltInAgent: { key: "assistant", featureKeys: ["assistant"] } } },
  ]);
  mocks.chats.mockResolvedValue([
    { id: "chat-alice", conversationAgentId: "alice" },
    { id: "chat-assistant", conversationAgentId: "assistant-1" },
  ]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps the Assistant and its conversation out of the Chats roster", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(observed?.agents.data?.map((agent) => agent.id)).toEqual(["alice"]);
  expect(observed?.chats.data?.map((chat) => chat.id)).toEqual(["chat-alice"]);
});

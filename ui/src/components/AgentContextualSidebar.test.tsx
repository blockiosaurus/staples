// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AgentContextualSidebar } from "./AgentContextualSidebar";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("./ContextualSidebarFrame", () => ({
  ContextualSidebarFrame: ({
    title,
    showHeader,
    className,
    children,
  }: {
    title: string;
    showHeader?: boolean;
    className?: string;
    children: React.ReactNode;
  }) => (
    <aside data-title={title} data-show-header={String(showHeader)} className={className}>
      {children}
    </aside>
  ),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a>,
}));

function render(path: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient();
  seed?.(client);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AgentContextualSidebar agentRef="codexcoder" agentId="agent-1" agentName="Codex Coder" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

describe("AgentContextualSidebar", () => {
  it("shows the Agent group and a collapsed Advanced disclosure by default", () => {
    const markup = render("/agents/codexcoder/overview");
    expect(markup).toContain("Codex Coder");
    expect(markup).toContain('data-show-header="false"');
    expect(markup).toContain('data-slot="contextual-sidebar-nav"');
    expect(markup).toContain('href="/agents/codexcoder/overview"');
    expect(markup).toContain('href="/agents/codexcoder/instructions"');
    expect(markup).toContain('href="/agents/codexcoder/skills"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="agent-advanced-nav"');
    expect(markup).not.toContain('href="/agents/codexcoder/permissions"');
    expect(markup).not.toContain('href="/agents/codexcoder/runtime"');
    expect(markup).not.toContain("/activity?mode=agents");
  });

  it("opens Advanced when the active view is inside it", () => {
    const markup = render("/agents/codexcoder/permissions");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Permissions / Trust");
    expect(markup).toContain('href="/agents/codexcoder/runtime"');
    expect(markup).toContain('href="/activity?mode=agents&amp;agentId=agent-1"');
    expect(markup).toContain('href="/activity/runs?agentId=agent-1"');
    expect(markup).toContain("Harness / Runtime");
  });

  it("opens Advanced for scoped Audit routes", () => {
    const markup = render("/activity/runs?agentId=agent-1");
    expect(markup).toContain('aria-expanded="true"');
  });

  it("hides Channels and API keys when known empty, unless active", () => {
    const seed = (c: QueryClient) => {
      c.setQueryData(queryKeys.chatEndpoints.list("company-1"), []);
      c.setQueryData(queryKeys.agents.keys("agent-1"), []);
    };
    const hidden = render("/agents/codexcoder/runtime", seed);
    expect(hidden).not.toContain('href="/agents/codexcoder/channels"');
    expect(hidden).not.toContain('href="/agents/codexcoder/api-keys"');
    expect(hidden).toContain('href="/agents/codexcoder/tools"');
    expect(render("/agents/codexcoder/channels", seed)).toContain('href="/agents/codexcoder/channels"');
    expect(render("/agents/codexcoder/api-keys", seed)).toContain('href="/agents/codexcoder/api-keys"');
  });

  it("keeps Channels and API keys visible when emptiness is unknown or non-empty", () => {
    const unknown = render("/agents/codexcoder/runtime");
    expect(unknown).toContain('href="/agents/codexcoder/channels"');
    expect(unknown).toContain('href="/agents/codexcoder/api-keys"');
    const nonEmpty = render("/agents/codexcoder/runtime", (c) => {
      c.setQueryData(queryKeys.chatEndpoints.list("company-1"), [
        { id: "e1", assignedAgentId: "agent-1", status: "active", provider: "agentmail" },
      ]);
      c.setQueryData(queryKeys.agents.keys("agent-1"), [{ id: "k1" }]);
    });
    expect(nonEmpty).toContain('href="/agents/codexcoder/channels"');
    expect(nonEmpty).toContain('href="/agents/codexcoder/api-keys"');
  });

  it("hides Channels when endpoints exist only for other agents or are archived", () => {
    const markup = render("/agents/codexcoder/runtime", (c) => {
      c.setQueryData(queryKeys.chatEndpoints.list("company-1"), [
        { id: "e1", assignedAgentId: "other", status: "active", provider: "slack" },
        { id: "e2", assignedAgentId: "agent-1", status: "archived", provider: "slack" },
      ]);
    });
    expect(markup).not.toContain('href="/agents/codexcoder/channels"');
  });

  it("shows Autopilot in the Agent group only for templated agents", () => {
    const seedAgent = (metadata: Record<string, unknown> | null) => (c: QueryClient) => {
      c.setQueryData([...queryKeys.agents.detail("codexcoder"), "company-1", "contextual-sidebar"], {
        id: "agent-1", name: "Codex Coder", metadata,
      });
    };
    const templated = seedAgent({ staplesTemplate: { ref: "staples/coding-agent", version: "1.0.1" } });
    for (const path of ["/agents/codexcoder/overview", "/TES/agents/codexcoder/overview", "/TES/agents/codexcoder/autopilot"]) {
      const markup = render(path, templated);
      expect(markup).toContain('href="/agents/codexcoder/autopilot"');
      expect(markup).toContain("Autopilot");
    }
    for (const path of ["/agents/codexcoder/overview", "/TES/agents/codexcoder/autopilot"]) {
      expect(render(path, seedAgent({ other: true }))).not.toContain('href="/agents/codexcoder/autopilot"');
      expect(render(path, seedAgent(null))).not.toContain('href="/agents/codexcoder/autopilot"');
      // Unknown (not loaded yet): hidden.
      expect(render(path)).not.toContain('href="/agents/codexcoder/autopilot"');
    }
  });

  it("opens Advanced on company-prefixed deep links", () => {
    const markup = render("/TES/agents/codexcoder/permissions");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Permissions / Trust");
    expect(render("/TES/activity/runs?agentId=agent-1")).toContain('aria-expanded="true"');
  });

  it("renders the forced-open toggle as non-interactive and the normal toggle as interactive", () => {
    const forced = render("/TES/agents/codexcoder/permissions");
    expect(forced).toContain('aria-disabled="true"');
    const normal = render("/agents/codexcoder/overview");
    expect(normal).not.toContain("aria-disabled");
  });

  it.each([false, true])("keeps Channels for default email regardless of the chat setting (%s)", (enabled) => {
    const markup = render("/agents/codexcoder/runtime", (c) => {
      c.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: enabled });
      c.setQueryData(queryKeys.chatEndpoints.list("company-1"), [
        { id: "e1", assignedAgentId: "agent-1", status: "active", provider: "agentmail" },
      ]);
    });
    expect(markup).toContain('href="/agents/codexcoder/channels"');
  });

  it("hides Channels when only chat-provider endpoints exist and chat is disabled", () => {
    const markup = render("/agents/codexcoder/runtime", (c) => {
      c.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: false });
      c.setQueryData(queryKeys.chatEndpoints.list("company-1"), [
        { id: "e1", assignedAgentId: "agent-1", status: "active", provider: "slack" },
      ]);
    });
    expect(markup).not.toContain('href="/agents/codexcoder/channels"');
  });
});

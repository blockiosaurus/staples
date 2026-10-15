// @vitest-environment jsdom

import { plainRunStatus } from "./AgentDetail";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail, AgentRuntimeState, HeartbeatRun, Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentOverview } from "./AgentDetail";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("AgentOverview", () => {
  it("prioritizes identity, capability, runtime, skills, tasks, and scoped Audit entry points", () => {
    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      urlKey: "codexcoder",
      role: "engineer",
      title: "Product engineer",
      status: "active",
      reportsTo: null,
      capabilities: "Builds and verifies product changes.",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-sol" },
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-42",
      title: "Simplify agent information architecture",
      status: "in_progress",
      priority: "high",
      updatedAt: new Date("2026-08-31T12:00:00Z"),
    } as unknown as Issue;
    const runtime = {
      sessionDisplayId: "codex-session-42",
    } as unknown as AgentRuntimeState;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[issue]}
          runtimeState={runtime}
          directReportCount={2}
          skillNames={["Design Guide", "Check PR"]}
          agentRouteId="codexcoder"
          showSkills
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("About");
    expect(markup).toContain("Capabilities");
    expect(markup).toMatch(/id="agent-runtime-heading"[^>]*>Setup</);
    expect(markup).toMatch(/text-xs">Runs on</);
    expect(markup).not.toContain("Harness");
    // The raw conversation id and public key sit under Advanced, not the default cards.
    const defaultCards = markup.slice(0, markup.indexOf('data-testid="agent-overview-advanced"'));
    expect(defaultCards).not.toContain("codex-session-42");
    expect(defaultCards).not.toContain("Public key");
    expect(markup.slice(markup.indexOf('data-testid="agent-overview-advanced"'))).toContain("codex-session-42");
    expect(markup).toContain("Design Guide");
    expect(markup).toContain("Simplify agent information architecture");
    expect(markup).toContain("PAP-42");
    expect(markup).toContain('href="/activity/costs?agentId=agent-1"');
    expect(markup).toContain("GPT-5.6 Sol");
    expect(markup).toContain(">Skills<");
    expect(markup).not.toContain("Run Activity");
    expect(markup).not.toContain("Tasks by Status");
  });

  it("hides the Skills section when the Skills surface is off", () => {
    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      urlKey: "codexcoder",
      role: "engineer",
      status: "active",
      reportsTo: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      chainOfCommand: [],
    } as unknown as AgentDetail;
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={["Design Guide"]}
          agentRouteId="codexcoder"
          showSkills={false}
        />
      </QueryClientProvider>,
    );
    expect(markup).not.toContain(">Skills<");
    expect(markup).not.toContain("Design Guide");
  });

  it("maps raw run statuses to plain words", () => {
    expect(plainRunStatus("succeeded")).toBe("Finished");
    expect(plainRunStatus("failed")).toBe("Hit a problem");
    expect(plainRunStatus("running")).toBe("Working");
    expect(plainRunStatus("queued")).toBe("Waiting to start");
    expect(plainRunStatus("cancelled")).toBe("Stopped");
    expect(plainRunStatus("timed_out")).toBe("Ran out of time");
    expect(plainRunStatus("some_new_state")).toBe("some new state");
  });
});

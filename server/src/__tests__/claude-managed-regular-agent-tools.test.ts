import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, issueComments, issues } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { HOSTED_STAPLES_API_NOTE } from "@paperclipai/adapter-claude-managed/server";
import {
  fakeEvents,
  startFakeManagedAgentsServer,
  type FakeManagedAgentsServer,
} from "@paperclipai/adapter-claude-managed/testing";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { heartbeatService } from "../services/heartbeat.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

/**
 * A regular (non-Assistant) agent hired on Claude (hosted) gets the proxied
 * Staples tools on a heartbeat run: the real claude_managed registration
 * (native_mcp delivery, run JWT) with only its execute stubbed or pointed at a
 * fake Managed Agents API, so the run preparation path is the production one.
 */
type CapturedRun = { agentId: string; servers: AdapterRuntimeMcpServer[]; projectTools: string[] };

type JsonRpcResult = { result?: Record<string, unknown> & { tools?: Array<{ name: string }> }; error?: { code: number; message: string } };

async function rpc(url: string, token: string | null, method: string, params?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as JsonRpcResult | null };
}

function toolText(body: JsonRpcResult | null) {
  const content = body?.result?.content as Array<{ text: string }> | undefined;
  return { isError: body?.result?.isError === true, value: JSON.parse(content?.[0]?.text ?? "null") as Record<string, unknown> };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("claude_managed regular agent tools", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let fakeAnthropic: FakeManagedAgentsServer;
  const previous = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, apiUrl: process.env.PAPERCLIP_API_URL };
  const runs: CapturedRun[] = [];
  /** Agents whose runs go through the real adapter against the fake Managed Agents API. */
  const realExecuteAgents = new Set<string>();

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
    fakeAnthropic = await startFakeManagedAgentsServer();
    process.env.PAPERCLIP_API_URL = `${server.apiUrl}/api`;
    const real = getServerAdapter("claude_managed");
    expect(real.type).toBe("claude_managed");
    registerServerAdapter({
      ...real,
      execute: async (ctx: AdapterExecutionContext) => {
        const servers = ctx.runtimeMcp?.getServers() ?? [];
        if (realExecuteAgents.has(ctx.agent.id)) {
          runs.push({ agentId: ctx.agent.id, servers, projectTools: [] });
          return real.execute({
            ...ctx,
            config: { ...ctx.config, apiBaseUrl: fakeAnthropic.baseUrl, env: { ANTHROPIC_API_KEY: fakeAnthropic.apiKey } },
          });
        }
        // The proxied project tools answer tools/list with this run's JWT.
        const projects = servers.find((s) => s.connectionId === "paperclip-project-tools");
        let projectTools: string[] = [];
        if (projects) {
          const { body } = await rpc(projects.url, projects.token, "tools/list");
          projectTools = (body?.result?.tools ?? []).map((t) => t.name);
        }
        runs.push({ agentId: ctx.agent.id, servers, projectTools });
        return { exitCode: 0, signal: null, timedOut: false, summary: "Done." };
      },
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter("claude_managed");
    await fakeAnthropic?.close();
    await server?.close();
    for (const [key, value] of [["PAPERCLIP_AGENT_JWT_SECRET", previous.secret], ["PAPERCLIP_API_URL", previous.apiUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  async function hostedHire(name: string) {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const userId = f.responsibleUserId!;
    const [agent] = await server.db.insert(agents).values({
      companyId: f.companyId, name, role: "researcher", adapterType: "claude_managed",
      adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { heartbeat: { enabled: false } }, status: "idle",
    }).returning();
    const [issue] = await server.db.insert(issues).values({
      companyId: f.companyId, projectId: f.projectId, title: "Market brief", status: "todo",
      assigneeAgentId: agent!.id, responsibleUserId: userId, createdByUserId: userId,
    }).returning();
    return { f, userId, agent: agent!, issue: issue! };
  }

  it("registers the Staples runtime tools for a hosted hire's heartbeat run, without the Assistant tools", async () => {
    const { userId, agent, issue } = await hostedHire("Researcher");
    const heartbeat = heartbeatService(server.db);
    try {
      const run = await heartbeat.wakeup(agent.id, {
        source: "assignment", reason: "issue_assigned", triggerDetail: "system",
        payload: { issueId: issue.id },
        contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned", responsibleUserId: userId },
      });
      expect(run).not.toBeNull();
      await vi.waitFor(() => expect(runs.filter((r) => r.agentId === agent.id)).toHaveLength(1), { timeout: 30_000, interval: 100 });
      const captured = runs.find((r) => r.agentId === agent.id)!;
      const ids = captured.servers.map((s) => s.connectionId);
      expect(ids).toContain("paperclip-runtime-tools");
      expect(ids).toContain("paperclip-project-tools");
      expect(ids).toContain("paperclip-tools");
      expect(captured.servers.find((s) => s.connectionId === "paperclip-tools")).toMatchObject({
        name: "paperclip", url: `${server.apiUrl}/api/mcp/paperclip-tools`,
      });
      expect(ids).not.toContain("staples-assistant-tools");
      for (const s of captured.servers) expect(s.token, s.connectionId).toBeTruthy();
      expect(captured.projectTools).toEqual(expect.arrayContaining(["list_projects", "create_task"]));
      await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded"), { timeout: 30_000, interval: 100 });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("a hosted run reads its task and comments through paperclip__ tools; Anthropic never sees the run token", async () => {
    const { userId, agent, issue } = await hostedHire("Hosted researcher");
    realExecuteAgents.add(agent.id);
    fakeAnthropic.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "custom_tool_call", name: "paperclip__paperclipGetIssue", input: { issueId: issue.id }, id: "sevt_get_issue" },
      { kind: "custom_tool_call", name: "paperclip__paperclipAddComment", input: { issueId: issue.id, body: "Brief read; starting research." }, id: "sevt_comment" },
      { kind: "emit", event: fakeEvents.agentMessage("Commented.") },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 1 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const heartbeat = heartbeatService(server.db);
    try {
      const run = await heartbeat.wakeup(agent.id, {
        source: "assignment", reason: "issue_assigned", triggerDetail: "system",
        payload: { issueId: issue.id },
        contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned", responsibleUserId: userId },
      });
      expect(run).not.toBeNull();
      await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/succeeded|failed/), { timeout: 60_000, interval: 100 });
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");

      const created = fakeAnthropic.requests.filter((r) => r.method === "POST" && r.path === "/v1/agents")
        .map((r) => r.body as { name: string; system: string | null; tools: Array<{ name?: string }> })
        .find((body) => body.name === `Staples: ${agent.name}`)!;
      expect(created.tools.map((t) => t.name)).toEqual(expect.arrayContaining([
        "paperclip__paperclipGetIssue", "paperclip__paperclipAddComment", "paperclip__paperclipUpdateIssue",
        "paperclip__paperclipAskUserQuestions", "paperclip__paperclipApiRequest",
      ]));
      for (const tool of created.tools) if (tool.name) expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(created.system).toContain(HOSTED_STAPLES_API_NOTE);

      const sessionId = fakeAnthropic.sessionIds().at(-1)!;
      const results = fakeAnthropic.receivedEvents(sessionId).filter((e) => e.type === "user.custom_tool_result");
      const issueResult = results.find((e) => e.custom_tool_use_id === "sevt_get_issue") as { is_error: boolean; content: Array<{ text: string }> };
      expect(issueResult.is_error).toBe(false);
      expect(JSON.parse(issueResult.content[0]!.text)).toMatchObject({ id: issue.id, title: "Market brief" });

      // The comment is the agent's own, attributed to this run, with an activity entry.
      const [comment] = await server.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
      expect(comment).toMatchObject({ body: "Brief read; starting research.", authorAgentId: agent.id, createdByRunId: run!.id });
      const activity = await server.db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.runId, run!.id)));
      expect(activity.some((row) => row.actorType === "agent" && row.agentId === agent.id && row.action.includes("comment"))).toBe(true);

      // No run-scoped bearer token reaches the Managed Agents API.
      const captured = runs.find((r) => r.agentId === agent.id)!;
      const recorded = JSON.stringify(fakeAnthropic.requests);
      for (const s of captured.servers) expect(recorded).not.toContain(s.token);
    } finally {
      realExecuteAgents.delete(agent.id);
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  describe("/api/mcp/paperclip-tools", () => {
    const url = () => `${server.apiUrl}/api/mcp/paperclip-tools`;

    it("rejects a missing or foreign token", async () => {
      const f = await server.fixture();
      expect((await rpc(url(), null, "tools/list")).status).toBe(401);
      const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
      const foreign = createLocalAgentJwt(f.agentId, f.companyId, "claude_managed", f.runId)!;
      process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
      expect((await rpc(url(), foreign, "tools/list")).status).toBe(401);
      expect((await rpc(url(), foreign, "tools/call", { name: "paperclipGetIssue", arguments: { issueId: f.issueId } })).status).toBe(401);
    });

    it("lists the tool set and runs each call as the run's agent, inside its company", async () => {
      const f = await server.fixture();
      const other = await server.fixture();
      const token = createLocalAgentJwt(f.agentId, f.companyId, "claude_managed", f.runId)!;

      const listed = await rpc(url(), token, "tools/list");
      expect(listed.status).toBe(200);
      const names = (listed.body?.result?.tools ?? []).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["paperclipGetIssue", "paperclipAddComment", "paperclipApiRequest"]));
      expect(names).not.toContain("connections_search");

      const me = toolText((await rpc(url(), token, "tools/call", { name: "paperclipMe", arguments: {} })).body);
      expect(me).toMatchObject({ isError: false, value: { id: f.agentId, companyId: f.companyId } });

      const own = toolText((await rpc(url(), token, "tools/call", { name: "paperclipGetIssue", arguments: { issueId: f.issueId } })).body);
      expect(own).toMatchObject({ isError: false, value: { id: f.issueId } });

      // Another company's issue, project and issue list stay out of reach.
      const foreignIssue = toolText((await rpc(url(), token, "tools/call", { name: "paperclipGetIssue", arguments: { issueId: other.issueId } })).body);
      expect(foreignIssue.isError).toBe(true);
      expect(foreignIssue.value.status).toBeGreaterThanOrEqual(403);
      const foreignList = toolText((await rpc(url(), token, "tools/call", { name: "paperclipListIssues", arguments: { companyId: other.companyId } })).body);
      expect(foreignList).toMatchObject({ isError: true, value: { status: 403 } });
      const foreignProject = toolText((await rpc(url(), token, "tools/call", { name: "paperclipGetProject", arguments: { projectId: f.foreignProjectId } })).body);
      expect(foreignProject.isError).toBe(true);
      expect(JSON.stringify(foreignProject.value)).not.toContain("foreign-data-must-not-leak");

      const commented = toolText((await rpc(url(), token, "tools/call", { name: "paperclipAddComment", arguments: { issueId: f.issueId, body: "From the hosted tools." } })).body);
      expect(commented.isError).toBe(false);
      const [comment] = await server.db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.body, "From the hosted tools.")));
      expect(comment).toMatchObject({ authorAgentId: f.agentId, createdByRunId: f.runId });
      const foreignComment = toolText((await rpc(url(), token, "tools/call", { name: "paperclipAddComment", arguments: { issueId: other.issueId, body: "leak" } })).body);
      expect(foreignComment.isError).toBe(true);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, other.issueId))).toHaveLength(0);

      const unknown = await rpc(url(), token, "tools/call", { name: "connections_search", arguments: {} });
      expect(unknown.body?.error?.code).toBe(-32602);
    });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, issues } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

/**
 * A regular (non-Assistant) agent hired on Claude (hosted) gets the proxied
 * Staples tools on a heartbeat run: the real claude_managed registration
 * (native_mcp delivery, run JWT) with only its execute stubbed, so the run
 * preparation path is the production one.
 */
type CapturedRun = { agentId: string; servers: AdapterRuntimeMcpServer[]; projectTools: string[] };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("claude_managed regular agent tools", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previous = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, apiUrl: process.env.PAPERCLIP_API_URL };
  const runs: CapturedRun[] = [];

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
    process.env.PAPERCLIP_API_URL = `${server.apiUrl}/api`;
    const real = getServerAdapter("claude_managed");
    expect(real.type).toBe("claude_managed");
    registerServerAdapter({
      ...real,
      execute: async (ctx: AdapterExecutionContext) => {
        const servers = ctx.runtimeMcp?.getServers() ?? [];
        // The proxied project tools answer tools/list with this run's JWT.
        const projects = servers.find((s) => s.connectionId === "paperclip-project-tools");
        let projectTools: string[] = [];
        if (projects) {
          const response = await fetch(projects.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${projects.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          });
          const body = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
          projectTools = (body.result?.tools ?? []).map((t) => t.name);
        }
        runs.push({ agentId: ctx.agent.id, servers, projectTools });
        return { exitCode: 0, signal: null, timedOut: false, summary: "Done." };
      },
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter("claude_managed");
    await server?.close();
    for (const [key, value] of [["PAPERCLIP_AGENT_JWT_SECRET", previous.secret], ["PAPERCLIP_API_URL", previous.apiUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("registers the Staples runtime tools for a hosted hire's heartbeat run, without the Assistant tools", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const userId = f.responsibleUserId!;
    const [agent] = await server.db.insert(agents).values({
      companyId: f.companyId, name: "Researcher", role: "researcher", adapterType: "claude_managed",
      adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { heartbeat: { enabled: false } }, status: "idle",
    }).returning();
    const [issue] = await server.db.insert(issues).values({
      companyId: f.companyId, projectId: f.projectId, title: "Market brief", status: "todo",
      assigneeAgentId: agent!.id, responsibleUserId: userId, createdByUserId: userId,
    }).returning();

    const heartbeat = heartbeatService(server.db);
    try {
      const run = await heartbeat.wakeup(agent!.id, {
        source: "assignment", reason: "issue_assigned", triggerDetail: "system",
        payload: { issueId: issue!.id },
        contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: userId },
      });
      expect(run).not.toBeNull();
      await vi.waitFor(() => expect(runs.filter((r) => r.agentId === agent!.id)).toHaveLength(1), { timeout: 30_000, interval: 100 });
      const captured = runs.find((r) => r.agentId === agent!.id)!;
      const ids = captured.servers.map((s) => s.connectionId);
      expect(ids).toContain("paperclip-runtime-tools");
      expect(ids).toContain("paperclip-project-tools");
      expect(ids).not.toContain("staples-assistant-tools");
      for (const s of captured.servers) expect(s.token, s.connectionId).toBeTruthy();
      expect(captured.projectTools).toEqual(expect.arrayContaining(["list_projects", "create_task"]));
      await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded"), { timeout: 30_000, interval: 100 });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);
});

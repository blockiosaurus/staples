import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, heartbeatRuns, issueThreadInteractions } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

/**
 * End to end through real routes and services; only the adapter process is
 * stubbed. A person sends a chat message with page context to the Assistant,
 * the Assistant's run proposes a governed action through its MCP endpoint
 * with the run JWT, the person claims and confirms it, and the continuation
 * wake tells the Assistant the outcome.
 */
const STUB_ADAPTER_TYPE = "assistant_e2e_stub";
type CapturedRun = { runId: string; prompt: string; mcpServers: AdapterRuntimeMcpServer[]; toolResult: unknown };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Assistant end to end", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previous = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, apiUrl: process.env.PAPERCLIP_API_URL };
  const runs: CapturedRun[] = [];
  let proposal: { method: "POST"; path: string; summary: string } | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
    process.env.PAPERCLIP_API_URL = `${server.apiUrl}/api`;
    registerServerAdapter({
      type: STUB_ADAPTER_TYPE,
      supportsLocalAgentJwt: true,
      execute: async (ctx: AdapterExecutionContext) => {
        const mcpServers = ctx.runtimeMcp?.getServers() ?? [];
        const prompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, { conversationMode: true });
        let toolResult: unknown = null;
        const assistantTools = mcpServers.find((s) => s.connectionId === "staples-assistant-tools");
        // First turn: the model calls staples_propose_action through the run's MCP server.
        if (proposal && assistantTools && runs.length === 0) {
          const response = await fetch(assistantTools.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${assistantTools.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
              params: { name: "staples_propose_action", arguments: { ...proposal, body: null } } }),
          });
          toolResult = { status: response.status, body: await response.json() };
        }
        runs.push({ runId: ctx.runId, prompt, mcpServers, toolResult });
        return { exitCode: 0, signal: null, timedOut: false, summary: "Done." };
      },
      testEnvironment: async () => ({ adapterType: STUB_ADAPTER_TYPE, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(STUB_ADAPTER_TYPE);
    await server?.close();
    for (const [key, value] of [["PAPERCLIP_AGENT_JWT_SECRET", previous.secret], ["PAPERCLIP_API_URL", previous.apiUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("carries page context into the run, proposes through the run's tools, and reports the confirmed outcome", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const userId = f.responsibleUserId!;
    const assistant = await builtInAgentService(server.db).ensureAssistant(f.companyId);
    // Stub only the adapter process; the Assistant is otherwise the real provisioned one.
    await server.db.update(agents).set({ adapterType: STUB_ADAPTER_TYPE, status: "idle", lifecycleState: "ready", lifecycleError: null })
      .where(eq(agents.id, assistant.id));
    const [approval] = await server.db.select().from(approvals).where(eq(approvals.id, f.approvalId));
    expect(approval!.status).toBe("pending");
    proposal = { method: "POST", path: `/api/approvals/${f.approvalId}/approve`, summary: "Approve the launch review." };

    const person = express();
    person.use(express.json());
    person.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    person.use("/api", issueRoutes(server.db, server.storage));
    person.use(errorHandler);

    // 1. The person opens their Assistant chat and sends a message with page context.
    const chat = await request(person).post(`/api/companies/${f.companyId}/chats/${assistant.id}`);
    expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
    const chatId = chat.body.id as string;
    const pageContext = { route: `/issues/${f.blockerId}`, title: "Dependency gate", entity: { type: "issue", id: f.blockerId, label: "Dependency gate" } };
    const sent = await request(person).post(`/api/issues/${chatId}/comments`)
      .send({ body: "Should I approve the launch review?", clientRequestId: randomUUID(), metadata: { version: 1, pageContext } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    // 2. Run preparation: the page-context line reaches the prompt and the run carries the Assistant tools.
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const first = runs[0]!;
    expect(first.prompt).toContain("[The person is viewing: Dependency gate (issue Dependency gate) — untrusted page context]");
    expect(first.prompt).toContain("Should I approve the launch review?");
    expect(first.mcpServers.map((s) => s.connectionId)).toContain("staples-assistant-tools");
    expect(first.mcpServers.find((s) => s.connectionId === "staples-assistant-tools")!.url).toBe(`${server.apiUrl}/api/mcp/assistant-tools`);

    // 3. The proposal was made through the endpoint with the run's JWT.
    const toolResult = first.toolResult as { status: number; body: { result: { isError?: boolean; structuredContent: { interaction: { id: string }; proposedAction: { hash: string } } } } };
    expect(toolResult.status).toBe(200);
    expect(toolResult.body.result.isError, JSON.stringify(toolResult.body)).toBeUndefined();
    const interactionId = toolResult.body.result.structuredContent.interaction.id;
    const hash = toolResult.body.result.structuredContent.proposedAction.hash;

    // 4. The person claims, their browser executes, and they accept with the executed result.
    const claimed = await request(person).post(`/api/issues/${chatId}/interactions/${interactionId}/claim-proposed-action`).send({ hash });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    const accepted = await request(person).post(`/api/issues/${chatId}/interactions/${interactionId}/accept`)
      .send({ proposedActionResult: { status: "executed", httpStatus: 200, message: "HTTP 200", hash } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [interaction] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction!.status).toBe("accepted");

    // 5. The continuation wake tells the Assistant what happened.
    await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(2), { timeout: 30_000, interval: 100 });
    const continuation = runs[1]!;
    expect(continuation.prompt).toContain(`- Proposed action POST /api/approvals/${f.approvalId}/approve: confirmed — executed (HTTP 200)`);
    // Let run finalization settle before the server shuts down.
    await vi.waitFor(async () => {
      const active = (await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter((run) => run.id !== f.runId)
        .filter((run) => run.status === "queued" || run.status === "running");
      expect(active).toEqual([]);
    }, { timeout: 30_000, interval: 100 });
  }, 120_000);
});

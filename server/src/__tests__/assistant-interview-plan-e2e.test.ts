import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, goals, heartbeatRuns, issueRelations, issueThreadInteractions, issues,
  principalPermissionGrants, projectGoals, projects,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { planRoutes } from "../routes/plans.js";
import { companyBriefRoutes } from "../routes/company-brief.js";
import { companySignalsRoutes } from "../routes/company-signals.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { injectApiRequest } from "../services/public-mcp/capabilities.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

/**
 * Phase 4 end to end through real routes, services and DB; only the adapter
 * process is stubbed and the person's session actor injected. A new company
 * with no staff: the person asks the Assistant to build a newsletter, the
 * Assistant interviews them with a question card, they accept the
 * recommendations, the Assistant proposes a whole plan (brief, goal, project,
 * one hire, three tasks), and the person's browser applies it.
 */
const STUB_ADAPTER_TYPE = "assistant_interview_e2e_stub";
/** A trusted browser origin: board session mutations need one (CSRF guard). */
const ORIGIN = "http://localhost:3100";
type ToolCall = { status: number; body: { result: { isError?: boolean; content?: unknown; structuredContent: Record<string, any> } } };
type CapturedRun = { runId: string; prompt: string; mcpServers: AdapterRuntimeMcpServer[]; toolResult: ToolCall | null };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Assistant interview -> plan end to end", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previous = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, apiUrl: process.env.PAPERCLIP_API_URL };
  const runs: CapturedRun[] = [];
  let planArgs: Record<string, unknown> | null = null;

  const questions = [
    { id: "q1", prompt: "Who is the newsletter for?", required: true, answerMode: "single_select",
      options: [{ id: "founders", label: "Early-stage founders", recommended: true }, { id: "devs", label: "Developers" }] },
    { id: "q2", prompt: "How often should it go out?", required: true, answerMode: "single_select",
      options: [{ id: "weekly", label: "Weekly", recommended: true }, { id: "monthly", label: "Monthly" }] },
  ];

  async function callTool(server: AdapterRuntimeMcpServer, name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() } as ToolCall;
  }

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
        const tools = mcpServers.find((s) => s.connectionId === "staples-assistant-tools");
        let toolResult: ToolCall | null = null;
        // Turn 1: interview. Turn 2 (woken with the answers): propose the plan. Turn 3: outcome only.
        if (tools && runs.length === 0) {
          toolResult = await callTool(tools, "staples_ask_questions", { title: "A few questions about your newsletter", questions });
        } else if (tools && runs.length === 1 && planArgs) {
          toolResult = await callTool(tools, "staples_propose_plan", planArgs);
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

  it("interviews, proposes a plan with a brief, and the applied plan creates the company's first staff", async () => {
    const db = server.db;
    // 1. A new company with no staff agents and no approval requirement for hires.
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Newsletter Co ${nonce}`, issuePrefix: `NL${nonce.slice(0, 4).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
    }).returning();
    const companyId = company!.id;
    const userId = `person-${nonce}`;
    await db.insert(authUsers).values({ id: userId, name: "Pat", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" });
    const assistant = await builtInAgentService(db).ensureAssistant(companyId);
    // Stub only the adapter process; the Assistant is otherwise the real provisioned one.
    await db.update(agents).set({ adapterType: STUB_ADAPTER_TYPE, status: "idle", lifecycleState: "ready", lifecycleError: null })
      .where(eq(agents.id, assistant.id));

    const actor = {
      type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false,
    } as Express.Request["actor"];
    // Plans hire through the agent-hire route in-process, as the person (as in app.ts).
    // The wake scheduler for the plan's assigned tasks is replaced: waking the
    // new claude_local agent would start a real model process.
    const taskWakeup = vi.fn(async () => undefined);
    const planApi = Router();
    planApi.use(boardMutationGuard());
    planApi.use(agentRoutes(db));
    planApi.use(planRoutes(db, {
      hireAgent: (a, cid, body, origin) => injectApiRequest(planApi, a, "POST", `/companies/${cid}/agent-hires`, body, { trustedOrigin: origin }),
      heartbeat: { wakeup: taskWakeup },
    }));
    const person = express();
    person.use(express.json());
    person.use((req, _res, next) => { req.actor = actor; next(); });
    person.use("/api", issueRoutes(db, server.storage));
    person.use("/api", companyBriefRoutes(db));
    person.use("/api", companySignalsRoutes(db));
    person.use("/api", planApi);
    person.use(errorHandler);

    // What the Assistant's second turn will propose (set before any wake can run).
    planArgs = {
      summary: "Start a weekly newsletter for early-stage founders with a writer and three starter tasks.",
      plan: {
        brief: { body: "# Mission\n\nA weekly newsletter for early-stage founders.", baseRevisionId: null },
        goal: { title: "Publish a weekly founders newsletter", description: "One useful issue every week." },
        project: { name: "Newsletter launch", description: "Starter work for the first issue." },
        agents: [{ clientKey: "writer", name: "Newsletter Writer", role: "general", adapterType: "claude_local", capabilities: "Drafts newsletter issues." }],
        tasks: [
          { clientKey: "topics", title: "List ten topic ideas" },
          { clientKey: "style", title: "Write a one-page style guide" },
          { clientKey: "first-issue", title: "Draft the first issue", assigneeClientKey: "writer", blockedByClientKeys: ["topics"] },
        ],
      },
    };
    const signalsBefore = await request(person).get(`/api/companies/${companyId}/signals`);
    expect(signalsBefore.status, JSON.stringify(signalsBefore.body)).toBe(200);
    expect(signalsBefore.body.agents).toBe(0);

    // 2. The person sends a chat message; the Assistant's run asks questions through its tools.
    const chat = await request(person).post(`/api/companies/${companyId}/chats/${assistant.id}`);
    expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
    const chatId = chat.body.id as string;
    const sent = await request(person).post(`/api/issues/${chatId}/comments`)
      .send({ body: "I want to build a newsletter", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 30_000, interval: 100 });
    expect(runs[0]!.prompt).toContain("I want to build a newsletter");
    const asked = runs[0]!.toolResult!;
    expect(asked.status).toBe(200);
    expect(asked.body.result.isError, JSON.stringify(asked.body)).toBeUndefined();
    const questionId = asked.body.result.structuredContent.interaction.id as string;
    const [questionCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, questionId));
    expect(questionCard).toMatchObject({ kind: "ask_user_questions", status: "pending", issueId: chatId, addresseeUserId: userId });

    // 3. The person accepts all recommendations; the continuation wake renders the answers.
    const answered = await request(person).post(`/api/issues/${chatId}/interactions/${questionId}/respond`)
      .send({ answers: [{ questionId: "q1", optionIds: ["founders"] }, { questionId: "q2", optionIds: ["weekly"] }] });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    // 4. The woken run proposes the plan.
    await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(2), { timeout: 30_000, interval: 100 });
    const second = runs[1]!;
    expect(second.prompt).toContain("Resolved questions and answers:");
    expect(second.prompt).toContain("- Who is the newsletter for?: Early-stage founders");
    expect(second.prompt).toContain("- How often should it go out?: Weekly");
    const proposed = second.toolResult!;
    expect(proposed.status).toBe(200);
    expect(proposed.body.result.isError, JSON.stringify(proposed.body)).toBeUndefined();
    const planInteractionId = proposed.body.result.structuredContent.interaction.id as string;
    const hash = proposed.body.result.structuredContent.proposedAction.hash as string;
    expect(proposed.body.result.structuredContent.proposedAction).toMatchObject({ method: "POST", path: `/api/companies/${companyId}/plans/apply`, category: "plan" });

    // 5. The person claims, their browser applies the stored (pinned) body with the card id as key, then accepts.
    const claimed = await request(person).post(`/api/issues/${chatId}/interactions/${planInteractionId}/claim-proposed-action`).send({ hash });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    const [planCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, planInteractionId));
    const storedBody = (planCard!.payload as { proposedAction: { body: Record<string, unknown> } }).proposedAction.body;
    const apply = () => request(person).post(`/api/companies/${companyId}/plans/apply`)
      .set("Origin", ORIGIN).set("Idempotency-Key", planInteractionId).send(storedBody);
    const applied = await apply();
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result = applied.body;
    const accepted = await request(person).post(`/api/issues/${chatId}/interactions/${planInteractionId}/accept`)
      .send({ proposedActionResult: { status: "executed", httpStatus: 201, message: "HTTP 201", hash } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // 6. Everything the plan described exists and is linked.
    const brief = await request(person).get(`/api/companies/${companyId}/brief`);
    expect(brief.status).toBe(200);
    expect(brief.body).toMatchObject({ body: "# Mission\n\nA weekly newsletter for early-stage founders.", revisionId: result.brief.revisionId });
    const [goal] = await db.select().from(goals).where(eq(goals.id, result.goal.id));
    expect(goal).toMatchObject({ companyId, title: "Publish a weekly founders newsletter", level: "company" });
    const [project] = await db.select().from(projects).where(eq(projects.id, result.project.id));
    expect(project).toMatchObject({ companyId, name: "Newsletter launch", goalId: goal!.id });
    expect(await db.select().from(projectGoals).where(eq(projectGoals.projectId, project!.id))).toHaveLength(1);
    const [writer] = await db.select().from(agents).where(eq(agents.id, result.agents.writer.id));
    expect(writer).toMatchObject({ companyId, name: "Newsletter Writer", role: "general", adapterType: "claude_local" });
    expect(writer!.status).not.toBe("pending_approval");
    const taskIds = ["topics", "style", "first-issue"].map((key) => result.tasks[key].id as string);
    const taskRows = await db.select().from(issues).where(inArray(issues.id, taskIds));
    const byKey = (key: string) => taskRows.find((row) => row.id === result.tasks[key].id)!;
    for (const key of ["topics", "style", "first-issue"]) expect(byKey(key)).toMatchObject({ goalId: goal!.id, projectId: project!.id });
    expect(byKey("first-issue")).toMatchObject({ assigneeAgentId: writer!.id, status: "todo" });
    expect(byKey("topics")).toMatchObject({ assigneeAgentId: null, status: "backlog" });
    expect(byKey("style")).toMatchObject({ assigneeAgentId: null, status: "backlog" });
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, byKey("first-issue").id));
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ issueId: byKey("topics").id, type: "blocks" });
    expect(result.pendingAssignments).toEqual([]);
    const signalsAfter = await request(person).get(`/api/companies/${companyId}/signals`);
    expect(signalsAfter.body.agents).toBeGreaterThanOrEqual(1);

    // The continuation wake tells the Assistant the plan's outcome.
    await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(3), { timeout: 30_000, interval: 100 });
    expect(runs[2]!.prompt).toContain(`- Proposed action POST /api/companies/${companyId}/plans/apply: confirmed — executed (HTTP 201)`);

    // 7. A retry with the same key returns the stored result and creates nothing.
    const retried = await apply();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toEqual(result);
    const staff = (await db.select().from(agents).where(eq(agents.companyId, companyId))).filter((row) => row.id !== assistant.id);
    expect(staff).toHaveLength(1);
    expect(await db.select().from(goals).where(eq(goals.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(1);
    const planTasks = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.projectId, project!.id)));
    expect(planTasks).toHaveLength(3);

    // Let run finalization settle before the server shuts down.
    await vi.waitFor(async () => {
      const active = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
        .filter((run) => run.status === "queued" || run.status === "running");
      expect(active).toEqual([]);
    }, { timeout: 30_000, interval: 100 });
    // Post-run bookkeeping continues briefly after a run is marked finished.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }, 180_000);
});

import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, companySkills, heartbeatRuns, issueRelations, issueThreadInteractions, issues,
  principalPermissionGrants, routines, routineTriggers, toolPolicies,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { AgentTemplateDetail, PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { planRoutes } from "../routes/plans.js";
import { agentAutopilotRoutes } from "../routes/agent-autopilot.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { injectApiRequest } from "../services/public-mcp/capabilities.js";
import { agentTemplatesService } from "../services/agent-templates.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

/**
 * Phase 6 end to end through real routes, services and DB; only the adapter
 * process is stubbed and the person's session actor injected. The Assistant
 * reads a template, proposes a plan whose hire carries templateRef and the
 * recommended answers, and the person's browser applies it.
 */
const STUB_ADAPTER_TYPE = "agent_template_install_e2e_stub";
const ORIGIN = "http://localhost:3100";
const TIMEZONE = "Europe/Berlin";
type ToolCall = { status: number; body: { result: { isError?: boolean; content?: unknown; structuredContent: Record<string, any> } } };
type Script = { marker: string; ref: string; override: Record<string, string>; done: boolean; template: ToolCall | null; proposal: ToolCall | null };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Agent template install end to end", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previous = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, apiUrl: process.env.PAPERCLIP_API_URL };
  const scripts: Script[] = [];
  const prompts: string[] = [];

  async function callTool(mcp: AdapterRuntimeMcpServer, name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const response = await fetch(mcp.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${mcp.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() } as ToolCall;
  }

  function recommended(questions: PaperclipQuestionSetQuestion[]): Record<string, string | string[]> {
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const picks = (question.options ?? []).filter((option) => option.recommended).map((option) => option.id);
      if (question.answerMode === "text") answers[question.id] = question.initialText ?? "";
      else if (question.answerMode === "multi_select") answers[question.id] = picks;
      else answers[question.id] = picks[0] ?? "";
    }
    return answers;
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
        prompts.push(prompt);
        const tools = mcpServers.find((s) => s.connectionId === "staples-assistant-tools");
        const script = scripts.find((s) => !s.done && prompt.includes(s.marker));
        if (tools && script) {
          script.done = true;
          // The Assistant reads the template, then proposes a plan from its recommendations.
          script.template = await callTool(tools, "staples_get_template", { ref: script.ref });
          const detail = script.template.body.result.structuredContent.template as AgentTemplateDetail;
          script.proposal = await callTool(tools, "staples_propose_plan", {
            summary: `Hire the ${detail.ref} agent with its recommended setup.`,
            plan: {
              agents: [{
                clientKey: "hire", templateRef: script.ref, templateVersion: detail.version,
                templateAnswers: { ...recommended(detail.setupQuestions), ...script.override }, adapterType: "claude_local",
              }],
              tasks: [],
            },
          });
        }
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

  it("the Assistant hires a Researcher and an Email Secretary from templates; the person applies both plans", async () => {
    const db = server.db;
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Template Co ${nonce}`, issuePrefix: `TP${nonce.slice(0, 4).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
    }).returning();
    const companyId = company!.id;
    const userId = `person-${nonce}`;
    await db.insert(authUsers).values({ id: userId, name: "Pat", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" });
    const assistant = await builtInAgentService(db).ensureAssistant(companyId);
    await db.update(agents).set({ adapterType: STUB_ADAPTER_TYPE, status: "idle", lifecycleState: "ready", lifecycleError: null })
      .where(eq(agents.id, assistant.id));

    const actor = {
      type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false,
    } as Express.Request["actor"];
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
    person.use("/api", agentAutopilotRoutes(db));
    person.use("/api", planApi);
    person.use(errorHandler);

    const chat = await request(person).post(`/api/companies/${companyId}/chats/${assistant.id}`);
    expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
    const chatId = chat.body.id as string;

    /** One round: the person asks, the Assistant proposes, the person claims, applies and accepts. */
    async function hire(script: Script) {
      scripts.push(script);
      const sent = await request(person).post(`/api/issues/${chatId}/comments`).send({ body: script.marker, clientRequestId: randomUUID() });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      await vi.waitFor(() => expect(script.proposal).not.toBeNull(), { timeout: 30_000, interval: 100 });
      expect(script.template!.status).toBe(200);
      expect(script.template!.body.result.isError, JSON.stringify(script.template!.body)).toBeUndefined();
      expect(script.template!.body.result.structuredContent.template.ref).toBe(script.ref);
      const proposed = script.proposal!;
      expect(proposed.status).toBe(200);
      expect(proposed.body.result.isError, JSON.stringify(proposed.body)).toBeUndefined();
      const interactionId = proposed.body.result.structuredContent.interaction.id as string;
      const hash = proposed.body.result.structuredContent.proposedAction.hash as string;
      expect(proposed.body.result.structuredContent.proposedAction).toMatchObject({ method: "POST", path: `/api/companies/${companyId}/plans/apply`, category: "plan" });

      const claimed = await request(person).post(`/api/issues/${chatId}/interactions/${interactionId}/claim-proposed-action`).send({ hash });
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
      const storedBody = (card!.payload as { proposedAction: { body: Record<string, unknown> } }).proposedAction.body;
      const applied = await request(person).post(`/api/companies/${companyId}/plans/apply`)
        .set("Origin", ORIGIN).set("Idempotency-Key", interactionId).set("X-Staples-Timezone", TIMEZONE).send(storedBody);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      const accepted = await request(person).post(`/api/issues/${chatId}/interactions/${interactionId}/accept`)
        .send({ proposedActionResult: { status: "executed", httpStatus: 201, message: "HTTP 201", hash } });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      // The outcome reaches the Assistant on its next turn.
      await vi.waitFor(
        () => expect(prompts.some((p) => p.includes(`- Proposed action POST /api/companies/${companyId}/plans/apply: confirmed — executed (HTTP 201)`))).toBe(true),
        { timeout: 30_000, interval: 100 },
      );
      return applied.body;
    }

    const templates = agentTemplatesService();
    const ctx = { companyName: company!.name, personName: "Pat", personTimezone: TIMEZONE };

    // 1. Researcher: no apps needed, so no connect task.
    const researcherScript: Script = { marker: "Please hire me a researcher", ref: "staples/researcher", override: { reportDay: "friday" }, done: false, template: null, proposal: null };
    const result = await hire(researcherScript);
    const researcherDetail = researcherScript.template!.body.result.structuredContent.template as AgentTemplateDetail;
    const [researcher] = await db.select().from(agents).where(eq(agents.id, result.agents.hire.id));
    expect(researcher).toMatchObject({ companyId, adapterType: "claude_local" });
    expect(researcher!.metadata).toMatchObject({ staplesTemplate: { ref: "staples/researcher", version: researcherDetail.version } });
    const answers = { ...recommended(researcherDetail.setupQuestions), reportDay: "friday" };
    const rendered = await templates.render("staples/researcher", researcherDetail.version, answers, ctx);

    const instructions = await agentInstructionsService(db).readFile(researcher!, "AGENTS.md");
    expect(instructions.content.length).toBeGreaterThan(100);
    expect(instructions.content).not.toMatch(/\{\{/);
    expect(instructions.content).toContain("Pat");

    const skillRows = await db.select().from(companySkills).where(eq(companySkills.companyId, companyId));
    expect(skillRows.length).toBeGreaterThan(0);
    const desired = ((researcher!.adapterConfig as Record<string, any>).paperclipSkillSync?.desiredSkills ?? []) as Array<string | { key: string }>;
    const desiredKeys = desired.map((entry) => (typeof entry === "string" ? entry : entry.key));
    expect(rendered.agent.skills.length).toBeGreaterThan(0);
    for (const slug of [...rendered.agent.skills, ...rendered.vendoredSkills.map((skill) => skill.slug)]) {
      expect(desiredKeys.some((key) => key === slug || key.endsWith(`/${slug}`)), `${slug} in ${desiredKeys.join(", ")}`).toBe(true);
    }

    const routineRows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    const weekly = routineRows.find((row) => /brief/i.test(row.title));
    expect(weekly, routineRows.map((row) => row.title).join(", ")).toBeTruthy();
    expect(weekly).toMatchObject({ assigneeAgentId: researcher!.id, status: "active" });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, weekly!.id));
    expect(trigger).toMatchObject({ kind: "schedule", cronExpression: "0 9 * * 5", timezone: TIMEZONE, enabled: true });

    const taskKeys = Object.keys(result.tasks);
    expect(taskKeys.length).toBeGreaterThan(0);
    expect(taskKeys.some((key) => key.includes("connect"))).toBe(false);
    const taskRows = await db.select().from(issues).where(inArray(issues.id, taskKeys.map((key) => result.tasks[key].id as string)));
    expect(taskRows.some((row) => row.title.startsWith("Connect "))).toBe(false);
    expect(taskRows.some((row) => row.assigneeAgentId === researcher!.id)).toBe(true);
    expect(result.pendingAssignments).toEqual([]);

    const guard = async (agentId: string) => (await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, companyId)))
      .filter((row) => (row.selectors as Record<string, unknown>).agentId === agentId && (row.config as Record<string, unknown> | null)?.source === "agent_template");
    const researcherRules = await guard(researcher!.id);
    expect(researcherRules.map((rule) => (rule.config as Record<string, unknown>).templateRule)).toContain("destructive");
    expect(researcherRules.every((rule) => rule.policyType === "require_approval" || rule.policyType === "deny")).toBe(true);

    // 2. Email Secretary: needs email, none connected, so a connect task blocks the rest.
    const secretaryScript: Script = { marker: "Please hire me an email secretary", ref: "staples/email-secretary", override: {}, done: false, template: null, proposal: null };
    const mailResult = await hire(secretaryScript);
    const mailId = mailResult.agents.hire.id as string;
    const mailKeys = Object.keys(mailResult.tasks);
    const connectKey = mailKeys.find((key) => key.includes("connect-email"));
    expect(connectKey, mailKeys.join(", ")).toBeTruthy();
    const mailTasks = await db.select().from(issues).where(inArray(issues.id, mailKeys.map((key) => mailResult.tasks[key].id as string)));
    const connectRow = mailTasks.find((row) => row.id === mailResult.tasks[connectKey!].id)!;
    expect(connectRow.title).toMatch(/^Connect /);
    expect(connectRow.assigneeAgentId).toBe(mailId);
    const others = mailTasks.filter((row) => row.id !== connectRow.id);
    expect(others.length).toBeGreaterThan(0);
    const blocks = await db.select().from(issueRelations).where(inArray(issueRelations.relatedIssueId, others.map((row) => row.id)));
    for (const other of others) {
      expect(blocks.some((row) => row.relatedIssueId === other.id && row.issueId === connectRow.id && row.type === "blocks"), other.title).toBe(true);
    }
    const mailRules = await guard(mailId);
    const byRule = new Map(mailRules.map((rule) => [(rule.config as Record<string, unknown>).templateRule as string, rule]));
    expect(byRule.get("outward")).toMatchObject({ policyType: "require_approval" });
    expect(byRule.get("destructive")).toMatchObject({ policyType: "require_approval" });

    const autopilot = await request(person).get(`/api/agents/${mailId}/autopilot`);
    expect(autopilot.status, JSON.stringify(autopilot.body)).toBe(200);
    // Template 1.1.0 added an optional calendar outward action (1c735aa41); neither is connected yet.
    expect(autopilot.body.categories).toEqual([
      expect.objectContaining({ capability: "email", canToggle: false }),
      expect.objectContaining({ capability: "calendar", canToggle: false }),
    ]);

    // Let run finalization settle before the server shuts down.
    await vi.waitFor(async () => {
      const active = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
        .filter((run) => run.status === "queued" || run.status === "running");
      expect(active).toEqual([]);
    }, { timeout: 30_000, interval: 100 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }, 240_000);
});

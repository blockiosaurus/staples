import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  builtInManagedResources,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  goals,
  issueApprovals,
  planApplications,
  principalPermissionGrants,
  issueRelations,
  issues,
  projectGoals,
  projects,
  companySkills,
  companySkillPolicies,
  agentConfigRevisions,
  routines,
  routineTriggers,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY, type AgentTemplateAnswers, type PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { agentRoutes } from "../routes/agents.js";
import { planRoutes } from "../routes/plans.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { injectApiRequest } from "../services/public-mcp/capabilities.js";
import { companyBriefService } from "../services/company-brief.js";
import { claimPlanApplication, planHash, takeOverPlanApplication } from "../services/plans.js";
import { applyPlanSchema } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { planHireConnectionsFor } from "../services/assistant-tools.js";
import { agentTemplatesService } from "../services/agent-templates.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { approvalService } from "../services/approvals.js";
import { teamsCatalogService } from "../services/teams-catalog.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { agentService } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
/** A trusted browser origin: board session mutations need one (CSRF guard). */
const ORIGIN = "http://localhost:3100";

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

describeEmbeddedPostgres("POST /api/companies/:companyId/plans/apply", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plans-apply-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(options: { requireApproval?: boolean; membershipRole?: string; canHire?: boolean } = {}) {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Plan Co ${nonce}`, issuePrefix: `PL${nonce.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: options.requireApproval ?? false,
    }).returning();
    const userId = `user-${nonce}`;
    await db.insert(authUsers).values({ id: userId, name: "Pat", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole: options.membershipRole ?? "owner" });
    if (options.canHire !== false) {
      await db.insert(principalPermissionGrants).values({ companyId: company!.id, principalType: "user", principalId: userId, permissionKey: "agents:create" });
    }
    const [staff] = await db.insert(agents).values({ companyId: company!.id, name: "Riley", role: "engineer", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, status: "idle" }).returning();
    const [assistant] = await db.insert(agents).values({
      companyId: company!.id, name: "Assistant", role: "general", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, status: "idle",
      metadata: { paperclipBuiltInAgent: { key: ASSISTANT_BUILT_IN_AGENT_KEY } },
    }).returning();
    return { companyId: company!.id, userId, staffId: staff!.id, assistantId: assistant!.id, membershipRole: options.membershipRole ?? "owner" };
  }

  type Seed = Awaited<ReturnType<typeof seed>>;

  function sessionActor(s: Seed, source: string = "session"): Actor {
    return {
      type: "board", source, userId: s.userId, companyIds: [s.companyId],
      memberships: [{ companyId: s.companyId, membershipRole: s.membershipRole, status: "active" }], isInstanceAdmin: false,
    } as Actor;
  }

  function buildApp(actor: Actor, overrides: { hireAgent?: Parameters<typeof planRoutes>[1]["hireAgent"] } = {}) {
    const wakeup = vi.fn(async () => undefined);
    const api = Router();
    // As in the app: the guard runs for the plan request and again for each in-process hire.
    api.use(boardMutationGuard());
    api.use(agentRoutes(db));
    api.use(planRoutes(db, {
      hireAgent: overrides.hireAgent ?? ((a, companyId, body, origin) => injectApiRequest(api, a, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin })),
      heartbeat: { wakeup },
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", api);
    app.use(errorHandler);
    return { app, wakeup, api };
  }

  function fullPlan(s: Seed) {
    return {
      brief: { body: "# Mission\n\nShip weekly.", baseRevisionId: null },
      goal: { title: "Publish one article every week", description: "Readers get one useful article a week." },
      project: { name: "Weekly articles", description: "Holds the starter tasks." },
      agents: [
        { clientKey: "writer", name: "Writer", role: "general", adapterType: "claude_local", capabilities: "Drafts articles.", reportsToClientKey: "editor" },
        { clientKey: "editor", name: "Editor", role: "pm", title: "Managing editor", adapterType: "codex_local", budgetMonthlyCents: 5000 },
      ],
      tasks: [
        { clientKey: "first", title: "Publish the first article", assigneeClientKey: "writer", blockedByClientKeys: ["style", "outline"] },
        { clientKey: "style", title: "Write a style guide", description: "Done when: one page.", assigneeClientKey: "editor" },
        { clientKey: "outline", title: "Outline the first article", assigneeAgentId: s.staffId, parentClientKey: "style" },
        { clientKey: "ideas", title: "Collect topic ideas" },
      ],
    };
  }

  it("creates the brief, goal, project, agents and tasks with all links", async () => {
    const s = await seed();
    const { app, wakeup } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(fullPlan(s));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const result = response.body;

    // Brief created at revision 1.
    const brief = await companyBriefService(db).get(s.companyId);
    expect(brief).toMatchObject({ body: "# Mission\n\nShip weekly.", revisionNumber: 1, revisionId: result.brief.revisionId });

    // Goal: company level (the company had none); project linked to it.
    const [goal] = await db.select().from(goals).where(eq(goals.id, result.goal.id));
    expect(goal).toMatchObject({ companyId: s.companyId, title: "Publish one article every week", level: "company", parentId: null });
    const [project] = await db.select().from(projects).where(eq(projects.id, result.project.id));
    expect(project).toMatchObject({ companyId: s.companyId, name: "Weekly articles", goalId: goal!.id });
    expect(await db.select().from(projectGoals).where(eq(projectGoals.projectId, project!.id))).toHaveLength(1);

    // Agents hired through the agent-hire route: manager first, reporting line set.
    const editor = await db.select().from(agents).where(eq(agents.id, result.agents.editor.id)).then((rows) => rows[0]!);
    const writer = await db.select().from(agents).where(eq(agents.id, result.agents.writer.id)).then((rows) => rows[0]!);
    expect(editor).toMatchObject({ name: "Editor", role: "pm", title: "Managing editor", adapterType: "codex_local", budgetMonthlyCents: 5000 });
    expect(editor.status).toBe(result.agents.editor.status);
    expect(editor.status).not.toBe("pending_approval");
    expect(writer).toMatchObject({ name: "Writer", role: "general", adapterType: "claude_local", reportsTo: editor.id, capabilities: "Drafts articles." });
    const hireActivity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "agent.hire_created")));
    expect(hireActivity.map((row) => row.entityId).sort()).toEqual([editor.id, writer.id].sort());

    // Tasks: goal/project attached, assignees, parent and blockers resolved.
    const rows = await db.select().from(issues).where(eq(issues.companyId, s.companyId));
    const byKey = (key: string) => rows.find((row) => row.id === result.tasks[key].id)!;
    for (const key of ["first", "style", "outline", "ideas"]) {
      expect(byKey(key)).toMatchObject({ goalId: goal!.id, projectId: project!.id, createdByUserId: s.userId });
    }
    expect(byKey("first")).toMatchObject({ assigneeAgentId: writer.id, status: "todo" });
    expect(byKey("style")).toMatchObject({ assigneeAgentId: editor.id, status: "todo", description: "Done when: one page." });
    expect(byKey("outline")).toMatchObject({ assigneeAgentId: s.staffId, parentId: byKey("style").id });
    expect(byKey("ideas")).toMatchObject({ assigneeAgentId: null, status: "backlog" });
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, byKey("first").id));
    expect(relations.map((row) => row.issueId).sort()).toEqual([byKey("style").id, byKey("outline").id].sort());
    expect(relations.every((row) => row.type === "blocks")).toBe(true);
    expect(result.pendingAssignments).toEqual([]);

    // Audit and wakes: assigned tasks only, never the backlog one.
    const [applied] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "plan.applied")));
    expect(applied).toMatchObject({ actorType: "user", actorId: s.userId, entityType: "company", entityId: s.companyId });
    expect(applied!.details).toMatchObject({ goalId: goal!.id, projectId: project!.id, briefRevisionId: result.brief.revisionId });
    const wokenIssueIds = wakeup.mock.calls.map((call) => ((call as unknown[])[1] as { payload: { issueId: string } }).payload.issueId);
    expect(wokenIssueIds.sort()).toEqual([byKey("first").id, byKey("style").id, byKey("outline").id].sort());
  }, 120_000);

  it("gives hires on the Assistant's adapter its model connection and engine, and leaves other adapters alone", async () => {
    const s = await seed();
    // Make the seeded Assistant the provisioned one, connected through Codex on the CLI engine.
    await db.update(agents).set({
      adapterType: "codex_local",
      adapterConfig: { engine: "cli", model: "gpt-5.4" },
      runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } },
      metadata: withBuiltInAgentMarker({}, { key: ASSISTANT_BUILT_IN_AGENT_KEY, featureKeys: [] }),
    }).where(eq(agents.id, s.assistantId));
    await db.insert(builtInManagedResources).values({
      companyId: s.companyId, bundleKey: ASSISTANT_BUILT_IN_AGENT_KEY, resourceKind: "instructions", resourceKey: "AGENTS.md",
      resourceId: s.assistantId, stockVersion: "test", stockHash: "test",
    });
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send({
      agents: [
        { clientKey: "editor", name: "Editor", role: "pm", adapterType: "codex_local" },
        { clientKey: "writer", name: "Writer", role: "general", adapterType: "claude_local" },
      ],
      tasks: [{ clientKey: "t", title: "Write the style guide", assigneeClientKey: "editor" }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [editor] = await db.select().from(agents).where(eq(agents.id, response.body.agents.editor.id));
    const [writer] = await db.select().from(agents).where(eq(agents.id, response.body.agents.writer.id));
    expect((editor!.runtimeConfig as Record<string, unknown>).aiConnection).toEqual({ provider: "openai", method: "api_key", mode: "responsible_user" });
    expect((editor!.adapterConfig as Record<string, unknown>).engine).toBe("cli");
    // The model is the adapter's default, not copied from the Assistant.
    expect((editor!.adapterConfig as Record<string, unknown>).model).not.toBe("gpt-5.4");
    expect((writer!.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    expect((writer!.adapterConfig as Record<string, unknown>).engine).toBeUndefined();
  }, 120_000);

  it("uses a task-level goal under the company goal when one exists, and works without brief/project/agents", async () => {
    const s = await seed();
    const [companyGoal] = await db.insert(goals).values({ companyId: s.companyId, title: "Company mission", level: "company", status: "active" }).returning();
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send({
      goal: { title: "Sub goal" }, tasks: [{ clientKey: "a", title: "Do A", assigneeAgentId: s.staffId }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [goal] = await db.select().from(goals).where(eq(goals.id, response.body.goal.id));
    expect(goal).toMatchObject({ level: "task", parentId: companyGoal!.id });
    expect(response.body).toMatchObject({ brief: null, project: null, agents: {} });
  }, 60_000);

  it("keeps hires pending when the company requires approval; their tasks wait unassigned, linked to the approval", async () => {
    const s = await seed({ requireApproval: true });
    const { app, wakeup } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send({
      agents: [{ clientKey: "writer", name: "Writer", role: "general", adapterType: "claude_local" }],
      tasks: [
        { clientKey: "draft", title: "Draft", assigneeClientKey: "writer" },
        { clientKey: "review", title: "Review", assigneeAgentId: s.staffId, blockedByClientKeys: ["draft"] },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const writer = response.body.agents.writer;
    expect(writer.status).toBe("pending_approval");
    expect(writer.approvalId).toEqual(expect.any(String));
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, writer.approvalId));
    expect(approval).toMatchObject({ type: "hire_agent", status: "pending" });
    const draftId = response.body.tasks.draft.id;
    const [draft] = await db.select().from(issues).where(eq(issues.id, draftId));
    expect(draft).toMatchObject({ assigneeAgentId: null, status: "backlog" });
    expect(response.body.pendingAssignments).toEqual([{ taskClientKey: "draft", agentClientKey: "writer", agentId: writer.id, approvalId: writer.approvalId }]);
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, writer.approvalId));
    expect(links.map((row) => row.issueId)).toEqual([draftId]);
    const woken = wakeup.mock.calls.map((call) => ((call as unknown[])[1] as { payload: { issueId: string } }).payload.issueId);
    expect(woken).toEqual([response.body.tasks.review.id]);
  }, 60_000);

  it("refuses a stale brief before creating anything", async () => {
    const s = await seed();
    await companyBriefService(db).update(s.companyId, { body: "# Existing" }, { userId: s.userId });
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(fullPlan(s));
    expect(response.status).toBe(409);
    const companyAgents = await db.select().from(agents).where(eq(agents.companyId, s.companyId));
    expect(companyAgents).toHaveLength(2);
    expect(await db.select().from(goals).where(eq(goals.companyId, s.companyId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
  }, 60_000);

  it.each([
    ["a CEO-level hire", (plan: Record<string, any>) => { plan.agents[0].role = "ceo"; }, /CEO/],
    ["an unknown role", (plan: Record<string, any>) => { plan.agents[0].role = "overlord"; }, /role must be one of/],
    ["a non-proposable adapter", (plan: Record<string, any>) => { plan.agents[0].adapterType = "process"; }, /adapterType must be one of/],
    ["a blocker cycle", (plan: Record<string, any>) => { plan.tasks[1].blockedByClientKeys = ["first"]; }, /cycle/],
    ["an unknown assignee key", (plan: Record<string, any>) => { plan.tasks[0].assigneeClientKey = "nobody"; }, /nobody/],
  ])("refuses %s with 422 and creates nothing", async (_label, mutate, message) => {
    const s = await seed();
    const plan = fullPlan(s) as Record<string, any>;
    mutate(plan);
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(plan);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toMatch(message);
    expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
    expect(await companyBriefService(db).get(s.companyId)).toBeNull();
  }, 60_000);

  it("refuses the Assistant or an agent from another company as an assignee", async () => {
    const s = await seed();
    const other = await seed();
    const { app } = buildApp(sessionActor(s));
    const toAssistant = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN)
      .send({ tasks: [{ clientKey: "a", title: "A", assigneeAgentId: s.assistantId }] });
    expect(toAssistant.status).toBe(422);
    expect(toAssistant.body.error).toMatch(/Assistant/);
    const foreign = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN)
      .send({ tasks: [{ clientKey: "a", title: "A", assigneeAgentId: other.staffId }] });
    expect(foreign.status).toBe(422);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
  }, 60_000);

  it("accepts only the person's own session (or local trusted board), never agents, delegated sources, keys or viewers", async () => {
    const s = await seed();
    const body = { tasks: [{ clientKey: "a", title: "A" }] };
    for (const source of ["assistant_run", "mcp_oauth", "board_key"]) {
      const { app } = buildApp(sessionActor(s, source));
      expect((await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(body)).status).toBe(403);
    }
    const agentActor = { type: "agent", agentId: s.staffId, companyId: s.companyId, source: "agent_jwt", runId: randomUUID() } as Actor;
    expect((await request(buildApp(agentActor).app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(body)).status).toBe(403);
    const viewer = await seed({ membershipRole: "viewer" });
    expect((await request(buildApp(sessionActor(viewer)).app).post(`/api/companies/${viewer.companyId}/plans/apply`).set("Origin", ORIGIN).send(body)).status).toBe(403);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
    const local = { type: "board", source: "local_implicit", userId: s.userId, isInstanceAdmin: true } as Actor;
    const applied = await request(buildApp(local).app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(body);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
  }, 60_000);

  it("refuses a plan with hires before creating anything when the person cannot hire", async () => {
    const s = await seed({ canHire: false });
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send({ ...fullPlan(s), brief: undefined });
    expect(response.status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
  }, 60_000);

  it("in-process hires pass the board mutation guard only with the forwarded browser origin", async () => {
    const s = await seed();
    const built = buildApp(sessionActor(s), {
      hireAgent: (actor, companyId, body) => injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body),
    });
    const response = await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(fullPlan(s));
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Hiring Editor failed: Board mutation requires trusted browser origin/);
    expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
  }, 60_000);

  it("refuses assigning to an existing agent the person may not assign before hiring anyone", async () => {
    const s = await seed();
    await db.update(agents).set({ permissions: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).where(eq(agents.id, s.staffId));
    const { app } = buildApp(sessionActor(s));
    const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(fullPlan(s));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toMatch(/assignment grant/);
    expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
    expect(await companyBriefService(db).get(s.companyId)).toBeNull();
  }, 60_000);

  describe("idempotent apply", () => {
    const KEY = "11111111-2222-4333-8444-555555555555";

    it("a retry after success with the same key returns the same ids and creates nothing", async () => {
      const s = await seed();
      const { app } = buildApp(sessionActor(s));
      const plan = fullPlan(s);
      const first = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY).send(plan);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const again = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY).send(plan);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.agents).toEqual(first.body.agents);
      expect(again.body.tasks).toEqual(first.body.tasks);
      expect(again.body.goal).toEqual(first.body.goal);
      expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(4);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(4);
      expect(await db.select().from(goals).where(eq(goals.companyId, s.companyId))).toHaveLength(1);
      // The same key with a different plan is refused.
      const other = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY)
        .send({ tasks: [{ clientKey: "x", title: "Different" }] });
      expect(other.status).toBe(409);
      // A body key that disagrees with the header is refused.
      const mismatch = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY)
        .send({ ...plan, idempotencyKey: "other-key" });
      expect(mismatch.status).toBe(400);
    }, 120_000);

    it("a retry after a partial failure reuses the agents already hired and completes", async () => {
      const s = await seed();
      let failSecond = true;
      let hires = 0;
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          hires += 1;
          if (failSecond && hires === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      const plan = fullPlan(s);
      const failed = await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY).send(plan);
      expect(failed.status).toBe(422);
      expect(failed.body.partial.agents.editor.id).toEqual(expect.any(String));
      expect(failed.body.error).toMatch(/Editor/);
      const [row] = await db.select().from(planApplications).where(eq(planApplications.companyId, s.companyId));
      expect(row).toMatchObject({ status: "failed", idempotencyKey: KEY });

      failSecond = false;
      const resumed = await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", KEY).send(plan);
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(201);
      expect(resumed.body.agents.editor.id).toBe(failed.body.partial.agents.editor.id);
      const companyAgents = await db.select().from(agents).where(eq(agents.companyId, s.companyId));
      expect(companyAgents.filter((agent) => agent.name === "Editor")).toHaveLength(1);
      expect(companyAgents.filter((agent) => agent.name === "Writer")).toHaveLength(1);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(4);

      // Proposing the same plan again (a new key) adopts nothing once it is applied: it is a new plan run.
      const [applied] = await db.select().from(planApplications).where(eq(planApplications.companyId, s.companyId));
      expect(applied!.status).toBe("applied");
    }, 120_000);

    it("a new key takes over a failed application; retrying that key replays its result", async () => {
      const s = await seed();
      let failSecond = true;
      let hires = 0;
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          hires += 1;
          if (failSecond && hires === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      const plan = fullPlan(s);
      const send = (key: string) => request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", key).send(plan);
      expect((await send("card-one")).status).toBe(422);
      failSecond = false;
      const resumed = await send("card-two");
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(201);
      const hiresAfterResume = hires;
      const replayed = await send("card-two");
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(replayed.body.tasks).toEqual(resumed.body.tasks);
      expect(hires).toBe(hiresAfterResume);
      expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(4);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(4);
      const rows = await db.select().from(planApplications).where(eq(planApplications.companyId, s.companyId));
      expect(Object.fromEntries(rows.map((row) => [row.idempotencyKey, row.status]))).toEqual({ "card-one": "superseded", "card-two": "applied" });
    }, 120_000);

    it("an apply that loses its lease mid-way stops before creating tasks; the newer request finishes once", async () => {
      const s = await seed();
      const plan = fullPlan(s);
      let hires = 0;
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          hires += 1;
          if (hires === 2) {
            // The first apply stalls past its lease and a newer request takes the plan over.
            const [row] = await db.select().from(planApplications).where(and(eq(planApplications.companyId, s.companyId), eq(planApplications.idempotencyKey, "slow")));
            await db.update(planApplications).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(planApplications.id, row!.id));
            const [stale] = await db.select().from(planApplications).where(eq(planApplications.id, row!.id));
            await takeOverPlanApplication(db, stale!, { key: "fresh", userId: s.userId });
          }
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      const send = (key: string) => request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", key).send(plan);
      const slow = await send("slow");
      expect(slow.status, JSON.stringify(slow.body)).toBe(409);
      expect(slow.body.error).toMatch(/lost the plan lease/);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
      // The superseded key points at the newer request until it finishes.
      const early = await send("slow");
      expect(early.status).toBe(409);
      expect(early.body.error).toMatch(/continued by a newer request/);

      const fresh = await send("fresh");
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(4);
      expect(fresh.body.agents.editor.id).toBe(slow.body.partial.agents.editor.id);
      // Retrying the superseded key now returns the successor's stored result.
      const retried = await send("slow");
      expect(retried.status).toBe(200);
      expect(retried.body.tasks).toEqual(fresh.body.tasks);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(4);
    }, 120_000);

    it("takes over an in-progress application whose lease was never set", async () => {
      const s = await seed();
      const hash = planHash(applyPlanSchema.parse(fullPlan(s)));
      const hired = { editor: { id: s.staffId, status: "idle", approvalId: null } };
      await db.insert(planApplications).values({ companyId: s.companyId, idempotencyKey: "nolease", planHash: hash, status: "in_progress", leaseUntil: null, createdByUserId: s.userId, agents: hired });
      const claimed = await claimPlanApplication(db, { companyId: s.companyId, key: "next", hash, userId: s.userId });
      expect(claimed).toMatchObject({ kind: "claimed", row: { idempotencyKey: "next", agents: hired } });
      const [old] = await db.select().from(planApplications).where(and(eq(planApplications.companyId, s.companyId), eq(planApplications.idempotencyKey, "nolease")));
      expect(old).toMatchObject({ status: "superseded", supersededById: claimed.row.id, leaseOwner: null });
    }, 60_000);

    it("only one of two racing resumers takes over a failed application", async () => {
      const s = await seed();
      const [failed] = await db.insert(planApplications).values({
        companyId: s.companyId, idempotencyKey: "k1", planHash: "h", status: "failed", createdByUserId: s.userId,
        agents: { editor: { id: s.staffId, status: "idle", approvalId: null } },
      }).returning();
      // Both racers read the same failed row; only the first conditional takeover wins.
      const first = await takeOverPlanApplication(db, failed!, { key: "k2", userId: s.userId });
      expect(first).toMatchObject({ idempotencyKey: "k2", status: "in_progress", agents: { editor: { id: s.staffId } } });
      await expect(takeOverPlanApplication(db, failed!, { key: "k3", userId: s.userId })).rejects.toMatchObject({ status: 409 });
      const keys = (await db.select().from(planApplications).where(eq(planApplications.companyId, s.companyId))).map((row) => row.idempotencyKey).sort();
      expect(keys).toEqual(["k1", "k2"]);
    }, 60_000);

    it("resumes a crashed (expired lease) application of the same person, but not another person's or an old one", async () => {
      const s = await seed();
      const hired = { editor: { id: s.staffId, status: "idle", approvalId: null } };
      const past = new Date(Date.now() - 60_000);
      await db.insert(planApplications).values([
        { companyId: s.companyId, idempotencyKey: "crashed", planHash: "h1", status: "in_progress", leaseUntil: past, createdByUserId: s.userId, agents: hired },
        { companyId: s.companyId, idempotencyKey: "live", planHash: "h2", status: "in_progress", leaseUntil: new Date(Date.now() + 60_000), createdByUserId: s.userId, agents: hired },
        { companyId: s.companyId, idempotencyKey: "theirs", planHash: "h3", status: "failed", createdByUserId: "someone-else", agents: hired },
        { companyId: s.companyId, idempotencyKey: "old", planHash: "h4", status: "failed", createdByUserId: s.userId, agents: hired, updatedAt: new Date(Date.now() - 25 * 3600_000) },
      ]);
      const crashed = await claimPlanApplication(db, { companyId: s.companyId, key: "n1", hash: "h1", userId: s.userId });
      expect(crashed).toMatchObject({ kind: "claimed", row: { idempotencyKey: "n1", agents: hired } });
      await expect(claimPlanApplication(db, { companyId: s.companyId, key: "n2", hash: "h2", userId: s.userId })).rejects.toMatchObject({ status: 409 });
      for (const [key, hash] of [["n3", "h3"], ["n4", "h4"]]) {
        const fresh = await claimPlanApplication(db, { companyId: s.companyId, key, hash, userId: s.userId });
        expect(fresh).toMatchObject({ kind: "claimed", row: { idempotencyKey: key, agents: {} } });
      }
    }, 60_000);

    it("a different key for the same plan resumes a failed application instead of hiring again", async () => {
      const s = await seed();
      let failSecond = true;
      let hires = 0;
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          hires += 1;
          if (failSecond && hires === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      const plan = fullPlan(s);
      expect((await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", "first-card").send(plan)).status).toBe(422);
      failSecond = false;
      const second = await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).set("Idempotency-Key", "second-card").send(plan);
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      const companyAgents = await db.select().from(agents).where(eq(agents.companyId, s.companyId));
      expect(companyAgents.filter((agent) => agent.name === "Editor")).toHaveLength(1);
    }, 120_000);
  });

  describe("inherited Assistant connection", () => {
    const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
    const GRANT_ID = "22222222-2222-4222-8222-222222222222";
    const sharedBinding = { provider: "openai", method: "api_key", mode: "shared", connectionId: CONNECTION_ID, grantId: GRANT_ID };

    async function provisionAssistant(s: Seed, aiConnection: Record<string, unknown>) {
      await db.update(agents).set({
        adapterType: "codex_local",
        adapterConfig: { engine: "cli" },
        runtimeConfig: { aiConnection },
        metadata: withBuiltInAgentMarker({}, { key: ASSISTANT_BUILT_IN_AGENT_KEY, featureKeys: [] }),
      }).where(eq(agents.id, s.assistantId));
      await db.insert(builtInManagedResources).values({
        companyId: s.companyId, bundleKey: ASSISTANT_BUILT_IN_AGENT_KEY, resourceKind: "instructions", resourceKey: "AGENTS.md",
        resourceId: s.assistantId, stockVersion: "test", stockHash: "test",
      });
    }

    /** A real shared connection the person (seed user) created, so the applier may install it. */
    async function ownSharedBinding(s: Seed) {
      const saved = await aiConnectionService(db).save(s.companyId, s.userId, {
        provider: "openai", method: "api_key", name: "Team key", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: false,
      }, "fixture-key");
      return { provider: "openai", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId };
    }

    const onePlan = { agents: [{ clientKey: "editor", name: "Editor", role: "pm", adapterType: "codex_local" }], tasks: [{ clientKey: "t", title: "Write the style guide", assigneeClientKey: "editor" }] };

    function recordingApp(s: Seed, failWith?: number) {
      const bodies: Array<Record<string, unknown>> = [];
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          bodies.push(body as Record<string, unknown>);
          if (failWith && bodies.length === 1) return { statusCode: failWith, json: { error: "Binding refused", details: { code: "ai_connection_unavailable" } } };
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      return { ...built, bodies };
    }

    it("hands a shared Assistant connection to hires on its adapter", async () => {
      const s = await seed();
      const sharedBinding = await ownSharedBinding(s);
      await provisionAssistant(s, sharedBinding);
      const { app, bodies } = recordingApp(s, 422);
      // The first attempt is refused so only the body is inspected here.
      await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect((bodies[0]!.runtimeConfig as Record<string, unknown>).aiConnection).toEqual(sharedBinding);
    }, 120_000);

    it("computes the card's per-hire connection list from the Assistant's binding, never from the plan", async () => {
      const s = await seed();
      await provisionAssistant(s, sharedBinding);
      const plan = { ...onePlan, agents: [...onePlan.agents, { clientKey: "writer", name: "Writer", role: "general", adapterType: "claude_local" }] };
      // Only the hire on the Assistant's adapter inherits.
      expect(await planHireConnectionsFor(db, s.companyId, plan))
        .toEqual([{ clientKey: "editor", provider: "openai" }]);
      await db.update(agents).set({ runtimeConfig: { aiConnection: { ...sharedBinding, mode: "delegated" } } }).where(eq(agents.id, s.assistantId));
      expect(await planHireConnectionsFor(db, s.companyId, plan)).toEqual([]);
    }, 120_000);

    it("never hands on a delegated connection", async () => {
      const s = await seed();
      await provisionAssistant(s, { ...sharedBinding, mode: "delegated" });
      const { app, bodies } = recordingApp(s);
      const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.runtimeConfig).toBeUndefined();
    }, 120_000);

    it("retries once without a refused shared binding instead of failing the plan", async () => {
      const s = await seed();
      const sharedBinding = await ownSharedBinding(s);
      await provisionAssistant(s, sharedBinding);
      // The first hire is refused for the binding (422 with a connection code).
      const { app, bodies } = recordingApp(s, 422);
      const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(bodies).toHaveLength(2);
      expect((bodies[0]!.runtimeConfig as Record<string, unknown>).aiConnection).toEqual(sharedBinding);
      expect(bodies[1]!.runtimeConfig).toBeUndefined();
      expect(bodies[1]!.adapterConfig).toEqual({ engine: "cli" });
      const [editor] = await db.select().from(agents).where(eq(agents.id, response.body.agents.editor.id));
      expect((editor!.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    }, 120_000);

    it("leaves a real shared connection off when the applier could not install it, instead of failing the plan with a 403", async () => {
      const s = await seed({ membershipRole: "member" });
      // Created by someone else and not installed anywhere: the applier cannot install it.
      const otherId = `other-${randomUUID().slice(0, 8)}`;
      await db.insert(authUsers).values({ id: otherId, name: "Sam", email: `${otherId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user", principalId: otherId, status: "active", membershipRole: "owner" });
      const saved = await aiConnectionService(db).save(s.companyId, otherId, {
        provider: "openai", method: "api_key", name: "Team key", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: false,
      }, "fixture-key");
      const binding = { provider: "openai", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId };
      await provisionAssistant(s, binding);
      const { app, bodies } = recordingApp(s);
      const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.runtimeConfig).toBeUndefined();
      const [editor] = await db.select().from(agents).where(eq(agents.id, response.body.agents.editor.id));
      expect((editor!.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    }, 120_000);

    it("does not retry a 422 that is not about the binding", async () => {
      // Transient or unrelated ai_connection_* codes are not binding refusals either.
      for (const code of ["something_else", "ai_connection_busy", "ai_connection_tested", "ai_connection_pool_task_test_required"]) {
        const s = await seed();
        const sharedBinding = await ownSharedBinding(s);
        await provisionAssistant(s, sharedBinding);
        const bodies: unknown[] = [];
        const { app } = buildApp(sessionActor(s), {
          hireAgent: async (_actor, _companyId, body) => { bodies.push(body); return { statusCode: 422, json: { error: "Invalid hire", details: { code } } }; },
        });
        const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
        expect(response.status, code).toBe(422);
        expect(bodies, code).toHaveLength(1);
      }
    }, 120_000);

    it("reports the retry's own failure when the hire still fails without the binding", async () => {
      const s = await seed();
      const sharedBinding = await ownSharedBinding(s);
      await provisionAssistant(s, sharedBinding);
      const bodies: unknown[] = [];
      const { app } = buildApp(sessionActor(s), {
        hireAgent: async (_actor, _companyId, body) => { bodies.push(body); return { statusCode: 422, json: { error: bodies.length === 1 ? "Binding refused" : "Adapter unavailable", ...(bodies.length === 1 ? { details: { code: "ai_connection_unavailable" } } : {}) } }; },
      });
      const response = await request(app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/Hiring Editor failed: Adapter unavailable/);
      expect(bodies).toHaveLength(2);
    }, 120_000);

    it("does not retry an authorization failure or a responsible-user binding", async () => {
      const forbiddenRun = await seed();
      await provisionAssistant(forbiddenRun, sharedBinding);
      const forbidden = recordingApp(forbiddenRun, 403);
      const denied = await request(forbidden.app).post(`/api/companies/${forbiddenRun.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(denied.status).toBe(403);
      expect(forbidden.bodies).toHaveLength(1);

      const personal = await seed();
      await provisionAssistant(personal, { provider: "openai", method: "api_key", mode: "responsible_user" });
      const refused = recordingApp(personal, 422);
      const response = await request(refused.app).post(`/api/companies/${personal.companyId}/plans/apply`).set("Origin", ORIGIN).send(onePlan);
      expect(response.status).toBe(422);
      expect(refused.bodies).toHaveLength(1);
    }, 120_000);
  });

  it("reports partial creation when a hire fails after earlier hires succeeded", async () => {
    const s = await seed();
    let calls = 0;
    const built = buildApp(sessionActor(s), {
      hireAgent: async (actor, companyId, body, origin) => {
        calls += 1;
        if (calls === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
        return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
      },
    });
    const response = await request(built.app).post(`/api/companies/${s.companyId}/plans/apply`).set("Origin", ORIGIN).send(fullPlan(s));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("plan_partially_applied");
    expect(response.body.error).toMatch(/Hiring Writer failed: Adapter unavailable/);
    expect(response.body.partial.agents.editor.id).toEqual(expect.any(String));
    expect(await companyBriefService(db).get(s.companyId)).toBeNull();
    expect(await db.select().from(goals).where(eq(goals.companyId, s.companyId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
    const [failed] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "plan.apply_failed")));
    expect(failed!.details).toMatchObject({ createdAgents: { editor: { id: response.body.partial.agents.editor.id } } });
  }, 60_000);
  describe("agent templates", () => {
    const templates = agentTemplatesService();
    function recommended(questions: PaperclipQuestionSetQuestion[]): AgentTemplateAnswers {
      const answers: AgentTemplateAnswers = {};
      for (const question of questions) {
        const picks = (question.options ?? []).filter((option) => option.recommended).map((option) => option.id);
        if (question.answerMode === "text") answers[question.id] = question.initialText ?? "";
        else if (question.answerMode === "multi_select") answers[question.id] = picks;
        else answers[question.id] = picks[0] ?? "";
      }
      return answers;
    }
    async function templatedAgent(clientKey: string, ref: string, extra: Record<string, unknown> = {}) {
      const detail = await templates.get(ref, { companyName: "Plan Co", personName: "Pat" });
      return { clientKey, templateRef: ref, templateVersion: detail.version, templateAnswers: recommended(detail.setupQuestions), adapterType: "claude_local", ...extra };
    }
    const apply = (app: express.Express, companyId: string, body: unknown, key?: string) => {
      let req = request(app).post(`/api/companies/${companyId}/plans/apply`).set("Origin", ORIGIN).set("X-Staples-Timezone", "Europe/Berlin");
      if (key) req = req.set("Idempotency-Key", key);
      return req.send(body);
    };
    async function templatePolicies(agentId: string) {
      return (await db.select().from(toolPolicies)).filter((row) =>
        (row.selectors as Record<string, unknown>).agentId === agentId && (row.config as Record<string, unknown> | null)?.source === "agent_template");
    }
    /** A connected tool the agent may call (company-wide allow profile), with catalog entries by name and risk. */
    async function toolFixture(companyId: string, tools: Array<[string, "read" | "write" | "destructive"]>) {
      const [application] = await db.insert(toolApplications).values({
        companyId, applicationKey: `fixture-${randomUUID()}`, name: `Fixture ${randomUUID()}`, type: "mcp_http", status: "active",
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId, applicationId: application!.id, name: `Connection ${randomUUID()}`, uid: `test/${randomUUID()}`,
        transport: "mcp_remote", status: "active", enabled: true, config: { url: "https://example.invalid/mcp" },
      }).returning();
      const entries = new Map<string, string>();
      for (const [name, riskLevel] of tools) {
        const [entry] = await db.insert(toolCatalogEntries).values({
          companyId, applicationId: application!.id, connectionId: connection!.id, name, toolName: name, riskLevel,
          versionHash: randomUUID(), schemaHash: randomUUID(),
        }).returning();
        entries.set(name, entry!.id);
      }
      const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `profile-${randomUUID()}`, name: "All tools", defaultAction: "allow" }).returning();
      await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "company", targetId: companyId });
      return (agentId: string, toolName: string) => toolAccessPolicyService(db).decide({
        companyId, actor: { actorType: "agent", actorId: agentId, agentId },
        request: { connectionId: connection!.id, catalogEntryId: entries.get(toolName)!, toolName },
      });
    }

    it("installs a coding agent: instructions, catalog and vendored skills, routines with schedules, connect and starter tasks, guard rules and its record", async () => {
      const s = await seed();
      const { app, wakeup } = buildApp(sessionActor(s));
      const plan = { agents: [await templatedAgent("dev", "staples/coding-agent")], tasks: [] };
      const response = await apply(app, s.companyId, plan);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const result = response.body;
      expect(result.agents.dev).toMatchObject({ templateRef: "staples/coding-agent", approvalId: null });
      const [dev] = await db.select().from(agents).where(eq(agents.id, result.agents.dev.id));
      const rendered = await templates.render("staples/coding-agent", null, plan.agents[0]!.templateAnswers, { companyName: dev!.name ? `Plan Co` : "", personName: "Pat", personTimezone: "Europe/Berlin" });
      expect(dev).toMatchObject({ name: rendered.agent.name, role: "engineer", adapterType: "claude_local", budgetMonthlyCents: 6000 });

      // Instructions: the rendered AGENTS.md, with the person's name filled in.
      const instructions = await agentInstructionsService(db).readFile(dev!, "AGENTS.md");
      expect(instructions.content).toContain("Never push to the default branch");
      expect(instructions.content).toContain("Pat");
      expect(instructions.content).not.toMatch(/\{\{/);

      // Skills: catalog skills installed from the skills catalog, vendored skills imported, all attached.
      const skillRows = await db.select().from(companySkills).where(eq(companySkills.companyId, s.companyId));
      const keys = skillRows.map((row) => row.key);
      for (const key of [
        "paperclipai/bundled/software-development/github-pr-workflow",
        "paperclipai/bundled/paperclip-operations/issue-triage",
        "paperclipai/bundled/quality/qa-acceptance",
      ]) expect(keys).toContain(key);
      const vendored = skillRows.filter((row) => ["github-issue-sorting", "repo-health-check"].includes(row.slug));
      expect(vendored).toHaveLength(2);
      const desired = ((dev!.adapterConfig as Record<string, any>).paperclipSkillSync?.desiredSkills ?? []) as Array<string | { key: string }>;
      const desiredKeys = desired.map((entry) => (typeof entry === "string" ? entry : entry.key));
      for (const key of ["paperclipai/bundled/software-development/github-pr-workflow", "paperclipai/bundled/paperclip-operations/issue-triage",
        "paperclipai/bundled/quality/qa-acceptance", ...vendored.map((row) => row.key)]) {
        expect(desiredKeys).toContain(key);
      }

      // Routines: active, assigned, one schedule trigger each on the person's time zone.
      const routineRows = await db.select().from(routines).where(eq(routines.companyId, s.companyId));
      expect(routineRows.map((row) => row.title).sort()).toEqual(rendered.routines.map((routine) => routine.title).sort());
      expect(result.routines.map((routine: { id: string }) => routine.id).sort()).toEqual(routineRows.map((row) => row.id).sort());
      for (const row of routineRows) {
        expect(row).toMatchObject({ assigneeAgentId: dev!.id, status: "active" });
        const triggers = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id));
        const expected = rendered.routines.find((routine) => routine.title === row.title)!;
        expect(triggers).toHaveLength(1);
        expect(triggers[0]).toMatchObject({ kind: "schedule", cronExpression: expected.cronExpression, timezone: "Europe/Berlin", enabled: true });
        expect(triggers[0]!.nextRunAt).toBeTruthy();
      }

      // Tasks: "Connect GitHub" first, the starter task blocked by it, both assigned.
      const connect = result.tasks["dev~connect-code"];
      const starter = result.tasks["dev~starter-1"];
      expect(connect).toMatchObject({ assigneeAgentId: dev!.id, status: "todo" });
      expect(starter).toMatchObject({ assigneeAgentId: dev!.id });
      const [connectRow] = await db.select().from(issues).where(eq(issues.id, connect.id));
      expect(connectRow!.title).toBe("Connect GitHub");
      expect(connectRow!.description).toContain("connection_request");
      expect(connectRow!.description).toContain("`github`");
      const blockers = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, starter.id));
      expect(blockers.map((row) => row.issueId)).toEqual([connect.id]);
      const woken = wakeup.mock.calls.map((call) => ((call as unknown[])[1] as { payload: { issueId: string } }).payload.issueId);
      expect(woken).toContain(connect.id);

      // Access rules: ask first for destructive calls and for outward writes; drafts and other writes are untouched.
      const rules = await templatePolicies(dev!.id);
      expect(rules.map((rule) => [(rule.config as Record<string, unknown>).templateRule, rule.policyType, rule.priority]).sort())
        .toEqual([["destructive", "require_approval", 5], ["outward", "require_approval", 50]]);
      const decide = await toolFixture(s.companyId, [
        ["merge_pull_request", "write"], ["create_branch", "write"], ["delete_branch", "destructive"], ["get_issue", "read"],
      ]);
      await expect(decide(dev!.id, "merge_pull_request")).resolves.toMatchObject({ decision: "require_approval" });
      await expect(decide(dev!.id, "delete_branch")).resolves.toMatchObject({ decision: "require_approval" });
      await expect(decide(dev!.id, "create_branch")).resolves.toMatchObject({ decision: "allow" });
      await expect(decide(dev!.id, "get_issue")).resolves.toMatchObject({ decision: "allow" });
      // Other agents are not affected by this agent's rules.
      await expect(decide(s.staffId, "merge_pull_request")).resolves.toMatchObject({ decision: "allow" });

      // Rules that run before the outward rule (a remembered trust rule, an allow
      // policy) never skip the destructive ask-first rule, which runs first.
      const remembered = async (agentId: string, toolName: string) => (await db.insert(toolPolicies).values({
        companyId: s.companyId, name: `Remember ${toolName} for ${agentId}`, policyType: "trust_rule", priority: 40,
        selectors: { agentId, toolName }, config: { trustRule: { hitCount: 0, argumentFilters: { allowAny: true } } },
      }).returning())[0]!;
      await remembered(dev!.id, "delete_branch");
      await db.insert(toolPolicies).values({
        companyId: s.companyId, name: "Allow all for dev", policyType: "allow", priority: 10, selectors: { agentId: dev!.id },
      });
      await expect(decide(dev!.id, "delete_branch")).resolves.toMatchObject({ decision: "require_approval", reasonCode: "requires_approval_policy" });
      // The same remembered permission does allow it for an untemplated agent.
      const staffRule = await remembered(s.staffId, "delete_branch");
      await expect(decide(s.staffId, "delete_branch")).resolves.toMatchObject({ decision: "allow", matchedPolicyIds: [staffRule.id] });
      await db.delete(toolPolicies).where(and(eq(toolPolicies.companyId, s.companyId), sql`${toolPolicies.config} ->> 'source' is null`));

      // The template record, server-written.
      expect((dev!.metadata as Record<string, any>).staplesTemplate).toMatchObject({
        ref: "staples/coding-agent", version: rendered.version, readOnly: false,
        outwardActions: [expect.objectContaining({ capability: "code", toolPatterns: expect.arrayContaining(["*merge*"]) })],
        requiredApps: [expect.objectContaining({ capability: "code", anyOf: ["github"] })],
      });

      // Activity: routines and rules.
      const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).map((row) => row.action);
      expect(actions.filter((action) => action === "routine.created")).toHaveLength(routineRows.length);
      expect(actions.filter((action) => action === "tool_policy.created")).toHaveLength(2);
      // Skills: one activity entry per skill the install created.
      expect(actions.filter((action) => action === "company.skill_catalog_installed")).toHaveLength(3);
      expect(actions.filter((action) => action === "company.skills_imported")).toHaveLength(2);

      // Template agents are hires, not installed catalog teams.
      expect(await teamsCatalogService(db).listInstalledCatalogTeams(s.companyId)).toEqual([]);
    }, 180_000);

    it("re-applying, or retrying after a partial failure, creates no duplicate skills, rules or routines", async () => {
      const s = await seed();
      let calls = 0;
      let failSecond = true;
      const built = buildApp(sessionActor(s), {
        hireAgent: async (actor, companyId, body, origin) => {
          calls += 1;
          if (failSecond && calls === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
          return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { trustedOrigin: origin });
        },
      });
      const plan = {
        agents: [await templatedAgent("dev", "staples/coding-agent"), await templatedAgent("research", "staples/researcher")],
        tasks: [{ clientKey: "kickoff", title: "Kick off", assigneeClientKey: "dev" }],
      };
      const first = await apply(built.app, s.companyId, plan, "interaction-templates");
      expect(first.status).toBe(422);
      expect(first.body.code).toBe("plan_partially_applied");
      const devId = first.body.partial.agents.dev.id as string;
      // The hired agent is guarded straight away, before the rest of the plan exists.
      expect(await templatePolicies(devId)).toHaveLength(2);
      expect(await db.select().from(routines).where(eq(routines.companyId, s.companyId))).toHaveLength(0);
      const skillsAfterFirst = (await db.select().from(companySkills).where(eq(companySkills.companyId, s.companyId))).length;

      failSecond = false;
      const retried = await apply(built.app, s.companyId, plan, "interaction-templates");
      expect(retried.status, JSON.stringify(retried.body)).toBe(201);
      expect(retried.body.agents.dev.id).toBe(devId);
      expect(await templatePolicies(devId)).toHaveLength(2);
      expect(await templatePolicies(retried.body.agents.research.id)).toHaveLength(1);
      const routineCount = (await db.select().from(routines).where(eq(routines.companyId, s.companyId))).length;
      expect(routineCount).toBe(retried.body.routines.length);
      // Both agents' skills went in before their hires on the first attempt; the retry adds none.
      const skillsAfterRetry = await db.select().from(companySkills).where(eq(companySkills.companyId, s.companyId));
      expect(skillsAfterRetry.length).toBe(skillsAfterFirst);
      const researchSlugs = (await templates.render("staples/researcher", null, plan.agents[1]!.templateAnswers, { companyName: "", personName: "", personTimezone: "UTC" }))
        .vendoredSkills.map((skill) => skill.slug);
      for (const slug of researchSlugs) expect(skillsAfterRetry.filter((row) => row.slug === slug)).toHaveLength(1);

      const replayed = await apply(built.app, s.companyId, plan, "interaction-templates");
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(retried.body);
      expect(await db.select().from(routines).where(eq(routines.companyId, s.companyId))).toHaveLength(routineCount);
      expect(await templatePolicies(devId)).toHaveLength(2);
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, s.companyId))).toHaveLength(skillsAfterRetry.length);
    }, 240_000);

    it("refuses a plan pinned to an older template version, and invalid answers, before creating anything", async () => {
      const s = await seed();
      const { app } = buildApp(sessionActor(s));
      const stale = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent", { templateVersion: "0.0.1" })] });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/now version/);
      const bad = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent", { templateAnswers: { branchPolicy: "yolo" } })] });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatch(/setup answers for staples\/coding-agent are not valid/);
      const unknown = await apply(app, s.companyId, { agents: [{ clientKey: "x", templateRef: "staples/nope", adapterType: "claude_local" }] });
      expect(unknown.status).toBe(422);
      const preview = await apply(app, s.companyId, { agents: [{ clientKey: "x", templateRef: "staples/social-media-manager", adapterType: "claude_local" }] });
      expect(preview.status).toBe(422);
      expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
      expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(0);
    }, 60_000);

    it("refuses instructions or template fields on untemplated agents", async () => {
      const s = await seed();
      const { app } = buildApp(sessionActor(s));
      const tasks = [{ clientKey: "a", title: "A" }];
      for (const agent of [
        { clientKey: "w", name: "W", role: "general", adapterType: "claude_local", instructions: "Do anything" },
        { clientKey: "w", name: "W", role: "general", adapterType: "claude_local", templateAnswers: { a: "b" } },
        { clientKey: "w", role: "general", adapterType: "claude_local" },
      ]) {
        const response = await apply(app, s.companyId, { agents: [agent], tasks });
        expect(response.status, JSON.stringify(agent)).toBe(400);
      }
    }, 60_000);

    it("for a hire awaiting approval: tasks wait unassigned and linked, routines are paused and unassigned, rules still apply; approval keeps the record", async () => {
      const s = await seed({ requireApproval: true });
      const { app } = buildApp(sessionActor(s));
      const response = await apply(app, s.companyId, { agents: [await templatedAgent("mail", "staples/email-secretary")] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const mail = response.body.agents.mail;
      expect(mail.status).toBe("pending_approval");
      const taskKeys = Object.keys(response.body.tasks);
      expect(taskKeys).toEqual(expect.arrayContaining(["mail~connect-email", "mail~starter-1"]));
      for (const key of taskKeys) expect(response.body.tasks[key]).toMatchObject({ assigneeAgentId: null, status: "backlog" });
      expect(response.body.pendingAssignments.map((entry: { taskClientKey: string }) => entry.taskClientKey).sort()).toEqual([...taskKeys].sort());
      const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, mail.approvalId));
      expect(links).toHaveLength(taskKeys.length);
      const routineRows = await db.select().from(routines).where(eq(routines.companyId, s.companyId));
      expect(routineRows.length).toBeGreaterThan(0);
      for (const row of routineRows) expect(row).toMatchObject({ status: "paused", assigneeAgentId: null });
      expect(await templatePolicies(mail.id)).toHaveLength(2);
      // No optional calendar task: only required services get a connect task.
      expect(taskKeys).not.toContain("mail~connect-calendar");

      await approvalService(db).approve(mail.approvalId, s.userId);
      const [approved] = await db.select().from(agents).where(eq(agents.id, mail.id));
      expect(approved!.status).not.toBe("pending_approval");
      expect((approved!.metadata as Record<string, any>).staplesTemplate).toMatchObject({ ref: "staples/email-secretary" });
      // Approval starts the template's routines: assigned to the agent and active, schedules intact.
      const resumed = await db.select().from(routines).where(eq(routines.companyId, s.companyId));
      expect(resumed).toHaveLength(routineRows.length);
      for (const row of resumed) {
        expect(row).toMatchObject({ status: "active", assigneeAgentId: mail.id, originKind: "agent_template", originId: mail.id });
        const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id));
        expect(trigger).toMatchObject({ kind: "schedule", enabled: true });
      }
      const resumedActivity = (await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "routine.updated"))));
      expect(resumedActivity).toHaveLength(routineRows.length);
    }, 120_000);

    it("blocks every write for a read-only template", async () => {
      const s = await seed();
      const { app } = buildApp(sessionActor(s));
      const response = await apply(app, s.companyId, { agents: [await templatedAgent("books", "staples/bookkeeper")] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const books = response.body.agents.books.id as string;
      const rules = await templatePolicies(books);
      expect(rules.map((rule) => [rule.policyType, (rule.config as Record<string, unknown>).templateRule, rule.priority]).sort())
        .toEqual([["block", "read_only", 5], ["block", "read_only_by_name", 5]]);
      const decide = await toolFixture(s.companyId, [
        ["create_refund", "write"], ["create_payment_link", "write"], ["delete_customer", "destructive"], ["list_charges", "read"],
        ["stripe_create_refund", "read"], ["list_refunds", "read"], ["list_payouts", "read"], ["list_invoices", "read"],
      ]);
      // A misclassified money-moving tool is still blocked; money reads still work.
      await expect(decide(books, "stripe_create_refund")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_policy_block" });
      for (const read of ["list_refunds", "list_payouts", "list_invoices"]) {
        await expect(decide(books, read), read).resolves.toMatchObject({ decision: "allow" });
      }
      // An allow policy or a remembered permission for the agent does not get past the block.
      await db.insert(toolPolicies).values([
        { companyId: s.companyId, name: "Allow all for books", policyType: "allow", priority: 10, selectors: { agentId: books } },
        { companyId: s.companyId, name: "Remember refunds", policyType: "trust_rule", priority: 40,
          selectors: { agentId: books, toolName: "create_refund" }, config: { trustRule: { hitCount: 0, argumentFilters: { allowAny: true } } } },
      ]);
      await expect(decide(books, "create_refund")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_policy_block" });
      await expect(decide(books, "create_payment_link")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_policy_block" });
      await expect(decide(books, "delete_customer")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_policy_block" });
      await expect(decide(books, "list_charges")).resolves.toMatchObject({ decision: "allow" });
      expect((await db.select().from(agents).where(eq(agents.id, books)))[0]!.metadata).toMatchObject({ staplesTemplate: { readOnly: true, outwardActions: [] } });
    }, 120_000);

    it("skips the connect task for a service the company already connected", async () => {
      const s = await seed();
      const [application] = await db.insert(toolApplications).values({
        companyId: s.companyId, applicationKey: `app-gallery:github:${randomUUID()}`, name: "GitHub", type: "mcp_http", status: "active",
        metadata: { sourceTemplateKey: "github" },
      }).returning();
      await db.insert(toolConnections).values({
        companyId: s.companyId, applicationId: application!.id, name: "GitHub", uid: `test/${randomUUID()}`,
        transport: "mcp_remote", status: "active", enabled: true, config: { url: "https://example.invalid/mcp" },
      });
      const { app } = buildApp(sessionActor(s));
      const response = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent")] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(Object.keys(response.body.tasks)).toEqual(["dev~starter-1"]);
      const blockers = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, response.body.tasks["dev~starter-1"].id));
      expect(blockers).toHaveLength(0);
    }, 120_000);

    it("never lets a caller write the template record: not on hire, not on update, not by dropping it", async () => {
      const s = await seed();
      await db.insert(principalPermissionGrants).values({ companyId: s.companyId, principalType: "user", principalId: s.userId, permissionKey: "agents:configure" });
      const { app } = buildApp(sessionActor(s));
      const forged = { ref: "staples/coding-agent", version: "1.0.0", readOnly: false, outwardActions: [], requiredApps: [] };
      const hire = await request(app).post(`/api/companies/${s.companyId}/agent-hires`).set("Origin", ORIGIN)
        .send({ name: "Forger", role: "general", adapterType: "claude_local", metadata: { staplesTemplate: forged } });
      expect(hire.status, JSON.stringify(hire.body)).toBe(409);
      expect(hire.body.details?.code ?? hire.body.code).toBe("staples_template_metadata_readonly");
      const patched = await request(app).patch(`/api/agents/${s.staffId}`).set("Origin", ORIGIN).send({ metadata: { staplesTemplate: forged } });
      expect(patched.status, JSON.stringify(patched.body)).toBe(409);

      const response = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent")] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const devId = response.body.agents.dev.id as string;
      const [dev] = await db.select().from(agents).where(eq(agents.id, devId));
      const stored = (dev!.metadata as Record<string, unknown>).staplesTemplate;
      const changed = await request(app).patch(`/api/agents/${devId}`).set("Origin", ORIGIN).send({ metadata: { staplesTemplate: { ...(stored as object), readOnly: true } } });
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      const dropped = await request(app).patch(`/api/agents/${devId}`).set("Origin", ORIGIN).send({ metadata: { note: "hi" } });
      expect(dropped.status, JSON.stringify(dropped.body)).toBe(409);
      const kept = await request(app).patch(`/api/agents/${devId}`).set("Origin", ORIGIN).send({ metadata: { note: "hi", staplesTemplate: stored } });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    }, 120_000);

    it("refuses a template whose skills the company skill policy does not let the person install, before creating anything", async () => {
      const s = await seed();
      await db.insert(companySkillPolicies).values({
        companyId: s.companyId, schemaVersion: 1, revision: 1, defaultEffect: "allow",
        rules: [{ id: "no-catalog-installs", priority: 0, effect: "deny", subject: { type: "roles", roles: ["board"] }, actions: ["skills.install"], resources: { sourceTypes: ["catalog"] } }],
      });
      const { app } = buildApp(sessionActor(s));
      const response = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent")] });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error).toMatch(/skill policy does not allow installing the skill/);
      expect(await db.select().from(agents).where(eq(agents.companyId, s.companyId))).toHaveLength(2);
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, s.companyId))).toHaveLength(0);
      // A template without catalog skills is unaffected by that rule... unless imports are denied too.
      await db.update(companySkillPolicies).set({
        rules: [{ id: "no-imports", priority: 0, effect: "deny", subject: { type: "roles", roles: ["board"] }, actions: ["skills.import"], resources: { sourceTypes: ["catalog"] } }],
      }).where(eq(companySkillPolicies.companyId, s.companyId));
      const imported = await apply(app, s.companyId, { agents: [await templatedAgent("research", "staples/researcher")] });
      expect(imported.status, JSON.stringify(imported.body)).toBe(403);
      expect(imported.body.error).toMatch(/importing the skill/);
    }, 120_000);

    it("keeps the template record when an agent's config is rolled back to an older revision", async () => {
      const s = await seed();
      const { app } = buildApp(sessionActor(s));
      const response = await apply(app, s.companyId, { agents: [await templatedAgent("dev", "staples/coding-agent")] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const devId = response.body.agents.dev.id as string;
      const [dev] = await db.select().from(agents).where(eq(agents.id, devId));
      const stored = (dev!.metadata as Record<string, unknown>).staplesTemplate;
      const snapshot = {
        name: dev!.name, role: dev!.role, title: dev!.title, reportsTo: dev!.reportsTo, capabilities: dev!.capabilities,
        adapterType: dev!.adapterType, adapterConfig: dev!.adapterConfig, runtimeConfig: dev!.runtimeConfig,
        budgetMonthlyCents: dev!.budgetMonthlyCents,
      };
      for (const metadata of [{ note: "before the template" }, { note: "forged", staplesTemplate: { ...(stored as object), readOnly: true } }]) {
        const [revision] = await db.insert(agentConfigRevisions).values({
          companyId: s.companyId, agentId: devId, source: "patch", changedKeys: ["metadata"],
          beforeConfig: { ...snapshot, metadata }, afterConfig: { ...snapshot, metadata },
        }).returning();
        await agentService(db).rollbackConfigRevision(devId, revision!.id, { userId: s.userId });
        const [after] = await db.select().from(agents).where(eq(agents.id, devId));
        expect(after!.metadata, JSON.stringify(metadata)).toMatchObject({ note: metadata.note, staplesTemplate: stored });
      }
    }, 120_000);

    it("does not count template agents (or forged provenance pointing at a template) as installed catalog teams", async () => {
      const s = await seed();
      await db.update(agents).set({
        metadata: { paperclip: { catalogTeam: { catalogId: "paperclipai:optional:staples:coding-agent", catalogKey: "paperclipai/optional/staples/coding-agent" } } },
      }).where(eq(agents.id, s.staffId));
      expect(await teamsCatalogService(db).listInstalledCatalogTeams(s.companyId)).toEqual([]);
    }, 60_000);
  });
});

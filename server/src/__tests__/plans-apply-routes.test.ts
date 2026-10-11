import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  goals,
  issueApprovals,
  principalPermissionGrants,
  issueRelations,
  issues,
  projectGoals,
  projects,
} from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { planRoutes } from "../routes/plans.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { injectApiRequest } from "../services/public-mcp/capabilities.js";
import { companyBriefService } from "../services/company-brief.js";

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
      hireAgent: overrides.hireAgent ?? ((a, companyId, body, origin) => injectApiRequest(api, a, "POST", `/companies/${companyId}/agent-hires`, body,
        origin ? { origin, host: new URL(origin).host } : {})),
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

  it("reports partial creation when a hire fails after earlier hires succeeded", async () => {
    const s = await seed();
    let calls = 0;
    const built = buildApp(sessionActor(s), {
      hireAgent: async (actor, companyId, body, origin) => {
        calls += 1;
        if (calls === 2) return { statusCode: 422, json: { error: "Adapter unavailable" } };
        return injectApiRequest(built.api, actor, "POST", `/companies/${companyId}/agent-hires`, body, { origin: origin!, host: new URL(origin!).host });
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
});

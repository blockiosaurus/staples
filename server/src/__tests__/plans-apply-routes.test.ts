import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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
} from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
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
});

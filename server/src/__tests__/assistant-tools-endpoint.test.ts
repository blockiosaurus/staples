import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, heartbeatRuns, instanceUserRoles, issueThreadInteractions, issues } from "@paperclipai/db";
import { builtInAgentService } from "../services/built-in-agents.js";
import { assistantRuntimeMcpServer } from "../services/heartbeat/assistant-mcp-server.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { uiPreferencesService } from "../services/ui-preferences.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";


const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("assistant tools endpoint", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 120_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  type Fixture = Awaited<ReturnType<typeof server.fixture>>;
  // A real provisioned Assistant (built-in service), with the fixture's run and
  // conversation repointed to it. The fixture's own agent stays as staff.
  async function assistantFixture(options: { conversation?: boolean } = { conversation: true }) {
    const f = await server.fixture({ conversation: options.conversation, disableWakeOnDemand: true });
    const assistant = await builtInAgentService(server.db).ensureAssistant(f.companyId);
    await server.db.update(heartbeatRuns).set({ agentId: assistant.id }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ assigneeAgentId: assistant.id, ...(options.conversation ? { conversationAgentId: assistant.id } : {}) })
      .where(eq(issues.id, f.issueId));
    return { ...f, agentId: assistant.id, staffAgentId: f.agentId };
  }
  async function rpc(f: Fixture, method: string, params?: Record<string, unknown>) {
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/mcp/assistant-tools`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const call = (f: Fixture, name: string, args: Record<string, unknown>) => rpc(f, "tools/call", { name, arguments: args });

  it("rejects runs that are not the Assistant's or have no responsible person", async () => {
    const staff = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    expect((await rpc(staff, "tools/list")).status).toBe(403);

    // A hand-written marker (bypassing the metadata guard) is not the Assistant.
    for (const metadata of [{ paperclipBuiltInAgent: { key: "assistant", featureKeys: ["assistant"] } }, { paperclipBuiltInAgent: { key: "assistant" } }]) {
      const forged = await server.fixture({ conversation: true, disableWakeOnDemand: true });
      await server.db.update(agents).set({ metadata }).where(eq(agents.id, forged.agentId));
      expect((await rpc(forged, "tools/list")).status).toBe(403);
      expect(await assistantRuntimeMcpServer(server.db, { agent: { id: forged.agentId, companyId: forged.companyId }, authToken: "jwt", apiBaseUrl: "http://127.0.0.1:1" })).toBeNull();
    }

    const unowned = await assistantFixture({ conversation: false });
    expect(unowned.responsibleUserId).toBeNull();
    expect((await rpc(unowned, "tools/list")).status).toBe(403);

    const finished = await assistantFixture();
    expect((await rpc(finished, "tools/list")).status).toBe(200);
    expect(await assistantRuntimeMcpServer(server.db, { agent: { id: finished.agentId, companyId: finished.companyId }, authToken: "jwt", apiBaseUrl: "http://127.0.0.1:1/" }))
      .toEqual({ name: "Staples assistant", url: "http://127.0.0.1:1/api/mcp/assistant-tools", token: "jwt", connectionId: "staples-assistant-tools" });
    expect(await assistantRuntimeMcpServer(server.db, { agent: { id: finished.agentId, companyId: finished.companyId }, authToken: null, apiBaseUrl: "http://127.0.0.1:1" })).toBeNull();
    expect(await assistantRuntimeMcpServer(server.db, { agent: { id: finished.staffAgentId, companyId: finished.companyId }, authToken: "jwt", apiBaseUrl: "http://127.0.0.1:1" })).toBeNull();
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, finished.runId));
    expect((await rpc(finished, "tools/list")).status).toBe(403);
  }, 60_000);

  it("creates a task as the person, attributed to the Assistant run", async () => {
    const f = await assistantFixture();
    const listed = await rpc(f, "tools/list");
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain("paperclip_create_task");

    const created = await call(f, "paperclip_create_task", {
      requestId: randomUUID(), title: "Draft the launch post", description: "For Friday.", assigneeAgentId: f.staffAgentId,
    });
    expect(created.status).toBe(200);
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeUndefined();
    const taskId = created.body.result.structuredContent.task.id as string;

    const [issue] = await server.db.select().from(issues).where(eq(issues.id, taskId));
    expect(issue).toMatchObject({ companyId: f.companyId, createdByUserId: f.responsibleUserId, createdByAgentId: null, assigneeAgentId: f.staffAgentId, originRunId: f.runId });
    const [activity] = await server.db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, taskId), eq(activityLog.action, "issue.created")));
    expect(activity).toMatchObject({ actorType: "user", actorId: f.responsibleUserId, agentId: null, runId: f.runId });

    // The Assistant cannot hand work to itself.
    const self = await call(f, "paperclip_create_task", { requestId: randomUUID(), title: "Loop", description: "", assigneeAgentId: f.agentId });
    expect(self.body.result).toMatchObject({ isError: true });
  }, 60_000);

  it("hides the Assistant from agent lists, rejects disallowed edits and pins surfaces", async () => {
    const f = await assistantFixture();
    const listed = await call(f, "paperclip_list_agents", {});
    const ids = listed.body.result.structuredContent.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain(f.staffAgentId);
    expect(ids).not.toContain(f.agentId);
    const self = await call(f, "paperclip_get_agent", { agentId: f.agentId });
    expect(self.body.result).toMatchObject({ isError: true });
    expect(self.body.result.content[0].text).toMatch(/not found/i);
    const staff = await call(f, "paperclip_get_agent", { agentId: f.staffAgentId });
    expect(staff.body.result.isError, JSON.stringify(staff.body)).toBeUndefined();

    const disallowed = await call(f, "paperclip_update_task", { taskId: f.blockerId, requestId: randomUUID(), changes: { visibility: "private" } });
    expect(disallowed.status).toBe(200);
    expect(disallowed.body.result).toMatchObject({ isError: true });
    expect(disallowed.body.result.content[0].text).toMatch(/visibility/);

    const pinned = await call(f, "staples_pin_surface", { surfaceId: "projects" });
    expect(pinned.body.result.isError, JSON.stringify(pinned.body)).toBeUndefined();
    const preferences = await uiPreferencesService(server.db).get(f.companyId, f.responsibleUserId!);
    expect(preferences.pinned).toContain("projects");
  }, 60_000);

  it("answers only questions addressed to this person", async () => {
    const f = await assistantFixture();
    const payload = { version: 1, questions: [{ id: "q1", prompt: "Ship Friday?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] };
    const [other] = await server.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.blockerId, kind: "ask_user_questions", status: "pending", addresseeUserId: "someone-else", createdByAgentId: f.staffAgentId, payload }).returning();
    const refused = await call(f, "staples_answer_question", { issueId: f.blockerId, interactionId: other!.id, answers: [{ questionId: "q1", optionIds: ["yes"] }] });
    expect(refused.body.result).toMatchObject({ isError: true });

    const [mine] = await server.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.blockerId, kind: "ask_user_questions", status: "pending", addresseeUserId: f.responsibleUserId, createdByAgentId: f.staffAgentId, payload }).returning();
    const answered = await call(f, "staples_answer_question", { issueId: f.blockerId, interactionId: mine!.id, answers: [{ questionId: "q1", optionIds: ["yes"] }] });
    expect(answered.body.result.isError, JSON.stringify(answered.body)).toBeUndefined();
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, mine!.id));
    expect(row).toMatchObject({ status: "answered", resolvedByUserId: f.responsibleUserId });
  }, 60_000);

  it("does not inherit the person's instance-admin read of private tasks", async () => {
    const f = await assistantFixture();
    const ownerId = `owner-${randomUUID()}`;
    await server.db.insert(authUsers).values({ id: ownerId, name: "Private owner", email: `${ownerId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" });
    const privateId = randomUUID();
    await server.db.insert(issues).values({ id: privateId, companyId: f.companyId, issueNumber: 99, identifier: `PRIV-${privateId.slice(0, 6)}`, title: "Private plum-heron plan", status: "todo", visibility: "private", createdByUserId: ownerId, responsibleUserId: ownerId });
    await server.db.insert(instanceUserRoles).values({ userId: f.responsibleUserId!, role: "instance_admin" });
    const searched = await call(f, "paperclip_search_tasks", { query: "plum-heron" });
    expect(searched.body.result.isError, JSON.stringify(searched.body)).toBeUndefined();
    expect(searched.body.result.structuredContent.tasks.map((t: { id: string }) => t.id)).not.toContain(privateId);
    const read = await call(f, "paperclip_read_task", { taskId: privateId });
    expect(read.body.result).toMatchObject({ isError: true });
  }, 60_000);

  it("does not let a delegated actor manage privacy through the person's instance-admin role", async () => {
    const f = await assistantFixture();
    const ownerId = `owner-${randomUUID()}`;
    await server.db.insert(authUsers).values({ id: ownerId, name: "Owner", email: `${ownerId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" });
    const openId = randomUUID();
    await server.db.insert(issues).values({ id: openId, companyId: f.companyId, issueNumber: 98, identifier: `OPEN-${openId.slice(0, 6)}`, title: "Someone else's task", status: "todo", createdByUserId: ownerId, responsibleUserId: ownerId });
    await server.db.insert(instanceUserRoles).values({ userId: f.responsibleUserId!, role: "instance_admin" });
    const app = (source: "assistant_run" | "mcp_oauth" | "session") => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.actor = { type: "board", source, userId: f.responsibleUserId!, companyIds: [f.companyId],
          memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }], isInstanceAdmin: false,
          ...(source === "assistant_run" ? { assistantRunId: f.runId } : {}) };
        next();
      });
      a.use("/api", issueRoutes(server.db, server.storage));
      a.use("/api", projectRoutes(server.db));
      a.use(errorHandler);
      return a;
    };
    for (const source of ["assistant_run", "mcp_oauth"] as const) {
      expect((await request(app(source)).get(`/api/issues/${openId}/privacy-constraints`)).status).toBe(403);
      expect((await request(app(source)).patch(`/api/projects/${f.projectId}`).send({ visibility: "private" })).status).toBe(403);
    }
    // Control: the same person in their own session is an instance admin.
    expect((await request(app("session")).get(`/api/issues/${openId}/privacy-constraints`)).status).toBe(200);
  }, 60_000);

  it("gives viewers read tools only", async () => {
    const f = await assistantFixture();
    await server.db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.responsibleUserId!)));
    const listed = await rpc(f, "tools/list");
    expect(listed.status).toBe(200);
    const names = listed.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("paperclip_search_tasks");
    expect(names).not.toContain("paperclip_create_task");
    expect(names).not.toContain("staples_pin_surface");
    const read = await call(f, "staples_briefing_inputs", {});
    expect(read.body.result.isError, JSON.stringify(read.body)).toBeUndefined();
    expect(read.body.result.structuredContent).toMatchObject({ pendingApprovals: expect.any(Array), openQuestions: expect.any(Array), blockedTasks: expect.any(Array) });
    const write = await call(f, "paperclip_add_comment", { taskId: f.blockerId, requestId: randomUUID(), body: "hi" });
    expect(write.status).toBe(403);
  }, 60_000);
});

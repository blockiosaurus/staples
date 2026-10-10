import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companyMemberships, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { uiPreferencesService } from "../services/ui-preferences.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const ASSISTANT_METADATA = { paperclipBuiltInAgent: { key: "assistant", featureKeys: ["assistant"] } };

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
  async function assistantFixture(options: { conversation?: boolean } = { conversation: true }) {
    const f = await server.fixture({ conversation: options.conversation, disableWakeOnDemand: true });
    await server.db.update(agents).set({ metadata: ASSISTANT_METADATA }).where(eq(agents.id, f.agentId));
    const staffAgentId = randomUUID();
    await server.db.insert(agents).values({ id: staffAgentId, companyId: f.companyId, name: "Staff engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, status: "active" });
    return { ...f, staffAgentId };
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

    const unowned = await assistantFixture({ conversation: false });
    expect(unowned.responsibleUserId).toBeNull();
    expect((await rpc(unowned, "tools/list")).status).toBe(403);

    const finished = await assistantFixture();
    expect((await rpc(finished, "tools/list")).status).toBe(200);
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

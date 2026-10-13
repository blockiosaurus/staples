import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  issueComments,
  builtInManagedResources,
  documents,
  heartbeatRuns,
  inboxDismissals,
  issueDocuments,
  issues,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { listBuiltInAgentDefinitions, builtInAgentService } from "../services/built-in-agents.js";
import { routineService } from "../services/routines.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { briefingService } from "../services/briefing.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import {
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID,
  closeWeeklyUpdateTaskAfterRun,
  ensureWeeklyUpdatesIssue,
  latestWeeklyUpdate,
  saveWeeklyUpdate,
  syncWeeklyUpdateTimezone,
  weeklyUpdateDate,
  weeklyUpdateExcerpt,
} from "../services/assistant-weekly-update.js";
import { AGENT_TEMPLATE_ROUTINE_ORIGIN } from "../services/plan-templates.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("weekly update helpers", () => {
  it("dates the update in the zone and titles it 'Weekly update — <Mon D, YYYY>'", () => {
    const now = new Date("2026-10-13T02:30:00.000Z");
    expect(weeklyUpdateDate(now, "UTC")).toEqual({ iso: "2026-10-13", label: "Oct 13, 2026" });
    // Still Monday evening in Los Angeles.
    expect(weeklyUpdateDate(now, "America/Los_Angeles")).toEqual({ iso: "2026-10-12", label: "Oct 12, 2026" });
  });

  it("previews the first lines as plain text, without a heading that repeats the title", () => {
    const body = "# Weekly update — Oct 12, 2026\n\n## What shipped\n- **Pricing page** ([PAP-3](/PAP/issues/PAP-3))\n- Signup fix\n\n## Spend\n$12 of $50";
    expect(weeklyUpdateExcerpt(body, "Weekly update — Oct 12, 2026")).toBe("What shipped: Pricing page (PAP-3), Signup fix\nSpend: $12 of $50");
    expect(weeklyUpdateExcerpt("word ".repeat(200), null, 20)).toHaveLength(20);
  });

  it("keeps underscores inside words and strips emphasis around them", () => {
    expect(weeklyUpdateExcerpt("## Next week\n- Rename `user_id` in the snake_case export\n- _Ship_ the __new__ *pricing* page", null))
      .toBe("Next week: Rename user_id in the snake_case export, Ship the new pricing page");
    expect(weeklyUpdateExcerpt("Plain first line\n\nSecond line", null)).toBe("Plain first line, Second line");
  });

  it("ships the weekly update routine in the Assistant bundle with a bumped stock version", () => {
    const assistant = listBuiltInAgentDefinitions().find((definition) => definition.key === "assistant")!;
    expect(assistant.bundle?.stockVersion).toBe("2026-10-13c");
    expect(assistant.bundle?.routine).toMatchObject({
      routineKey: "weekly-update", title: "Weekly update", status: "active",
      triggers: [{ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "person", enabled: true }],
    });
    expect(assistant.defaultSkillKeys).toContain("paperclipai/paperclip/staples-weekly-update");
  });

  it("never tells the Assistant to save the weekly update twice for an unknown time zone", () => {
    const skill = readFileSync(new URL("../../../skills/staples-weekly-update/SKILL.md", import.meta.url), "utf8");
    const routine = readFileSync(new URL("../built-ins/agents/assistant/routines/weekly-update.md", import.meta.url), "utf8");
    for (const text of [skill, routine]) {
      expect(text).not.toMatch(/save again\.?:? ?"|and save again/);
      expect(text).toMatch(/do not save again/);
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("assistant weekly update", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 120_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const noWake = { heartbeat: { wakeup: async () => null } };
  const routineSvc = () => routineService(server.db, noWake as never);

  async function weeklyRoutines(companyId: string) {
    return server.db.select().from(routines).where(and(
      eq(routines.companyId, companyId), eq(routines.originId, ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID),
    ));
  }
  async function scheduleOf(routineId: string) {
    return server.db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId));
  }

  /** `hosted`: the Assistant runs on Claude (hosted), so the scheduler has turned the weekly update on. */
  async function setup(options: { hosted?: boolean } = {}) {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const assistant = await builtInAgentService(server.db).ensureAssistant(f.companyId);
    if (options.hosted) {
      await server.db.update(agents).set({ adapterType: "claude_managed" }).where(eq(agents.id, assistant.id));
      await routineSvc().tickScheduledTriggers(new Date());
    }
    const [routine] = await weeklyRoutines(f.companyId);
    if (options.hosted) expect(routine!.status).toBe("active");
    return { ...f, assistantId: assistant.id, routine: routine! };
  }

  it("creates the weekly routine paused for a local Assistant, and the scheduler never runs it unattended there", async () => {
    const f = await setup();
    expect(f.routine).toMatchObject({ title: "Weekly update", status: "paused", assigneeAgentId: f.assistantId });
    const state = await builtInAgentService(server.db).get(f.companyId, "assistant");
    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({ scheduleEnabled: false });

    // Shipped active before this ruling (or switched on by the system): still skipped, with the reason recorded.
    await server.db.update(routines).set({ status: "active" }).where(eq(routines.id, f.routine.id));
    await server.db.update(routineTriggers).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const runs = await server.db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "skipped", failureReason: "assistant_not_hosted", linkedIssueId: null });
    expect(await openTasks(f.companyId, f.routine.id)).toHaveLength(0);
  }, 60_000);

  it("runs it for a local Assistant once a person turns it on themselves", async () => {
    const f = await setup();
    const state = await builtInAgentService(server.db).enableRoutineSchedule(f.companyId, "assistant", "weekly-update", { userId: f.responsibleUserId });
    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({ scheduleEnabled: true });
    await server.db.update(routineTriggers).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const [task] = await openTasks(f.companyId, f.routine.id);
    expect(task).toMatchObject({ title: "Weekly update", assigneeAgentId: f.assistantId, status: "todo" });
  }, 60_000);

  it("turns the routine on when the Assistant moves to hosted, unless a person paused it", async () => {
    const f = await setup();
    await server.db.update(agents).set({ adapterType: "claude_managed" }).where(eq(agents.id, f.assistantId));
    const before = Date.now();
    await routineSvc().tickScheduledTriggers(new Date());
    const [activated] = await weeklyRoutines(f.companyId);
    expect(activated!.status).toBe("active");
    // The next run is the next scheduled Monday, not a catch-up now.
    const [trigger] = await scheduleOf(f.routine.id);
    expect(trigger!.nextRunAt!.getTime()).toBeGreaterThan(before);
    expect(await server.db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id))).toHaveLength(0);
    const [logged] = await server.db.select().from(activityLog).where(and(eq(activityLog.entityId, f.routine.id), eq(activityLog.action, "routine.updated")));
    expect(logged).toMatchObject({ actorType: "system", details: expect.objectContaining({ reason: "assistant_on_hosted" }) });

    // A person pauses it: it stays paused.
    const g = await setup();
    await builtInAgentService(server.db).disableRoutineSchedule(g.companyId, "assistant", "weekly-update", { userId: g.responsibleUserId });
    await server.db.update(agents).set({ adapterType: "claude_managed" }).where(eq(agents.id, g.assistantId));
    await routineSvc().tickScheduledTriggers(new Date());
    expect((await weeklyRoutines(g.companyId))[0]!.status).toBe("paused");
  }, 60_000);

  it("creates one active weekly routine for a hosted Assistant on Mondays at 9:00, never duplicated, also on stock upgrade", async () => {
    const f = await setup({ hosted: true });
    const service = builtInAgentService(server.db);
    expect(await weeklyRoutines(f.companyId)).toHaveLength(1);
    expect(f.routine).toMatchObject({ title: "Weekly update", status: "active", assigneeAgentId: f.assistantId, originKind: "built_in_agent_bundle" });
    const [trigger] = await scheduleOf(f.routine.id);
    // No person zone is known for this company yet: UTC.
    expect(trigger).toMatchObject({ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "UTC", enabled: true });
    expect(trigger!.nextRunAt).not.toBeNull();

    const state = await service.get(f.companyId, "assistant");
    expect(state.resources.find((resource) => resource.resourceKind === "routine"))
      .toMatchObject({ stockVersion: "2026-10-13c", stockStatus: "stock_current", scheduleEnabled: true });

    await service.ensure(f.companyId, "assistant");
    await service.ensure(f.companyId, "assistant");
    expect(await weeklyRoutines(f.companyId)).toHaveLength(1);
    expect(await scheduleOf(f.routine.id)).toHaveLength(1);

    // An Assistant provisioned before this stock version has no routine; the next ensure adds exactly one.
    await server.db.delete(routineTriggers).where(eq(routineTriggers.routineId, f.routine.id));
    await server.db.delete(routines).where(eq(routines.id, f.routine.id));
    await server.db.delete(builtInManagedResources).where(and(
      eq(builtInManagedResources.companyId, f.companyId), eq(builtInManagedResources.resourceKind, "routine"),
    ));
    await service.ensure(f.companyId, "assistant");
    const upgraded = await weeklyRoutines(f.companyId);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({ assigneeAgentId: f.assistantId, status: "active" });
  }, 60_000);

  it("uses the person's zone from template routines, and moves a UTC schedule once the zone is known", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const actor = { agentId: null, userId: f.responsibleUserId, runId: null };
    const template = await routineSvc().create(f.companyId, { title: "Inbox sweep", description: "", assigneeAgentId: f.agentId, priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed" } as never, actor);
    await server.db.update(routines).set({ originKind: AGENT_TEMPLATE_ROUTINE_ORIGIN, originId: f.agentId }).where(eq(routines.id, template.id));
    await routineSvc().createTrigger(template.id, { kind: "schedule", cronExpression: "0 8 * * *", timezone: "Asia/Tokyo", enabled: true } as never, actor);

    await builtInAgentService(server.db).ensureAssistant(f.companyId);
    const [routine] = await weeklyRoutines(f.companyId);
    expect((await scheduleOf(routine!.id))[0]!.timezone).toBe("Asia/Tokyo");
    // A zone already set is kept.
    expect(await syncWeeklyUpdateTimezone(server.db, f.companyId, "Europe/Paris")).toBe(false);
    expect((await scheduleOf(routine!.id))[0]!.timezone).toBe("Asia/Tokyo");

    const g = await setup();
    expect(await syncWeeklyUpdateTimezone(server.db, g.companyId, "not a zone")).toBe(false);
    expect(await syncWeeklyUpdateTimezone(server.db, g.companyId, "America/New_York")).toBe(true);
    expect((await scheduleOf(g.routine.id))[0]!.timezone).toBe("America/New_York");
    // The zone is per company, so the bundle still reads as stock.
    const state = await builtInAgentService(server.db).get(g.companyId, "assistant");
    expect(state.resources.find((resource) => resource.resourceKind === "routine")?.stockStatus).toBe("stock_current");
  }, 60_000);

  it("skips the schedule while the company has no other agents, and runs it as the Assistant's task otherwise", async () => {
    const f = await setup({ hosted: true });
    const past = new Date(Date.now() - 60_000);
    await server.db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
    await server.db.update(routineTriggers).set({ nextRunAt: past }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const skipped = await server.db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ status: "skipped", failureReason: "no_other_agents", linkedIssueId: null });

    await server.db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await server.db.update(routineTriggers).set({ nextRunAt: past }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const [task] = await server.db.select().from(issues).where(and(
      eq(issues.companyId, f.companyId), eq(issues.originKind, "routine_execution"), eq(issues.originId, f.routine.id),
    ));
    expect(task).toMatchObject({ title: "Weekly update", assigneeAgentId: f.assistantId, status: "todo" });
  }, 60_000);

  it("never lets the Assistant hold another routine's task", async () => {
    const f = await setup();
    const other = await routineSvc().create(f.companyId, { title: "Other", description: "", assigneeAgentId: f.agentId, priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    await expect(issueService(server.db).create(f.companyId, {
      title: "Sneaky", status: "todo", assigneeAgentId: f.assistantId, originKind: "routine_execution", originId: other.id,
    })).rejects.toMatchObject({ status: 400 });
    await expect(routineSvc().update(other.id, { assigneeAgentId: f.assistantId }, { agentId: null, userId: f.responsibleUserId, runId: null }))
      .rejects.toMatchObject({ status: 400 });
  }, 60_000);

  async function weeklyRun(options: { responsibleUserId?: "person" | null } = {}) {
    const f = await setup();
    const run = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    const taskId = run.linkedIssueId!;
    expect(taskId).toBeTruthy();
    // The Assistant's run on the routine task, as the scheduler would start it.
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({
      id: runId, companyId: f.companyId, agentId: f.assistantId, status: "running",
      responsibleUserId: options.responsibleUserId === null ? null : f.responsibleUserId,
      runtimeMode: "native", nativeIssueId: taskId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: taskId },
    });
    const token = createLocalAgentJwt(f.assistantId, f.companyId, "claude_local", runId, options.responsibleUserId === null ? null : f.responsibleUserId)!;
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await fetch(`${server.apiUrl}/api/mcp/assistant-tools`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    return { ...f, runId, taskId, rpc, call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }) };
  }

  it("gives a weekly update run its read tools and one write: its own update document", async () => {
    const f = await weeklyRun();
    const listed = await f.rpc("tools/list");
    expect(listed.status).toBe(200);
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["staples_get_briefing", "paperclip_search_tasks", "staples_save_weekly_update"]));
    for (const write of ["paperclip_create_task", "paperclip_add_comment", "paperclip_update_task", "staples_propose_action", "staples_pin_surface"]) {
      expect(names).not.toContain(write);
    }

    const create = await f.call("paperclip_create_task", { requestId: randomUUID(), title: "Not allowed", description: "" });
    expect(create.body.result).toMatchObject({ isError: true, content: [{ text: "A weekly update run can only read and save the weekly update." }] });
    const comment = await f.call("paperclip_add_comment", { taskId: f.blockerId, requestId: randomUUID(), body: "Not allowed" });
    expect(comment.body.result).toMatchObject({ isError: true });
    // The target is never an input.
    const targeted = await f.call("staples_save_weekly_update", { body: "Hello", taskId: f.blockerId });
    expect(targeted.body.result).toMatchObject({ isError: true });
    expect(targeted.body.result.content[0].text).toMatch(/^Invalid arguments/);

    const saved = await f.call("staples_save_weekly_update", { body: "## What shipped\n- The pricing page" });
    expect(saved.body.result.isError, JSON.stringify(saved.body)).toBeUndefined();
    const result = saved.body.result.structuredContent;
    const date = weeklyUpdateDate(new Date(), "UTC");
    expect(result).toMatchObject({ timezone: "UTC", timezoneKnown: false, saved: { key: `weekly-update-${date.iso}`, title: `Weekly update — ${date.label}` } });

    const [updatesIssue] = await server.db.select().from(issues).where(and(
      eq(issues.companyId, f.companyId), eq(issues.originKind, ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND),
    ));
    expect(updatesIssue).toMatchObject({ title: "Weekly updates", status: "backlog", assigneeAgentId: null });
    const docs = await server.db.select({ key: issueDocuments.key, title: documents.title, createdByAgentId: documents.createdByAgentId })
      .from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, updatesIssue!.id));
    expect(docs).toEqual([{ key: `weekly-update-${date.iso}`, title: `Weekly update — ${date.label}`, createdByAgentId: f.assistantId }]);
    const [logged] = await server.db.select().from(activityLog).where(and(
      eq(activityLog.entityId, updatesIssue!.id), eq(activityLog.action, "issue.document_created"),
    ));
    expect(logged).toMatchObject({ actorType: "agent", actorId: f.assistantId, runId: f.runId });

    // Saving closes the routine task; the run then has no tools at all.
    const [task] = await server.db.select().from(issues).where(eq(issues.id, f.taskId));
    expect(task!.status).toBe("done");
    expect((await f.rpc("tools/list")).status).toBe(403);
  }, 60_000);

  it("keeps one Weekly updates task per company and returns the latest update until it is a week old or dismissed", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([ensureWeeklyUpdatesIssue(server.db, f.companyId), ensureWeeklyUpdatesIssue(server.db, f.companyId)]);
    expect(a.id).toBe(b.id);

    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: f.responsibleUserId!, now: Date.now() })).toBeNull();
    const saved = await saveWeeklyUpdate(server.db, { companyId: f.companyId, agentId: f.assistantId, runId: f.runId, body: "## What shipped\n- The pricing page" });
    const again = await saveWeeklyUpdate(server.db, { companyId: f.companyId, agentId: f.assistantId, runId: f.runId, body: "## What shipped\n- The pricing page and signup" });
    expect(again.documentId).toBe(saved.documentId);
    const latest = await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: f.responsibleUserId!, now: Date.now() });
    expect(latest).toMatchObject({
      documentId: saved.documentId, title: saved.title, excerpt: "What shipped: The pricing page and signup",
      href: `/issues/${a.identifier}#document-${saved.key}`,
    });

    // More than a week old: hidden.
    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: f.responsibleUserId!, now: Date.now() + 8 * DAY_MS })).toBeNull();
    // Dismissed by this person: hidden for them only.
    await server.db.insert(inboxDismissals).values({ companyId: f.companyId, userId: f.responsibleUserId!, itemKey: `weekly-update:${saved.documentId}` });
    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: f.responsibleUserId!, now: Date.now() })).toBeNull();
    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: "someone-else", now: Date.now() })).not.toBeNull();

    const weeklyDocs = await server.db.select().from(issueDocuments).where(and(
      eq(issueDocuments.companyId, f.companyId), like(issueDocuments.key, "weekly-update-%"),
    ));
    expect(weeklyDocs).toHaveLength(1);
  }, 60_000);

  async function openTasks(companyId: string, routineId: string) {
    return server.db.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.originKind, "routine_execution"), eq(issues.originId, routineId),
    ));
  }

  it("closes last week's open task so it never blocks this Monday's run", async () => {
    const f = await setup({ hosted: true });
    const first = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    await server.db.update(routineTriggers).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const tasks = await openTasks(f.companyId, f.routine.id);
    expect(tasks).toHaveLength(2);
    const stale = tasks.find((task) => task.id === first.linkedIssueId)!;
    const fresh = tasks.find((task) => task.id !== first.linkedIssueId)!;
    expect(stale.status).toBe("cancelled");
    expect(fresh).toMatchObject({ status: "todo", assigneeAgentId: f.assistantId });
    const notes = await server.db.select().from(issueComments).where(eq(issueComments.issueId, stale.id));
    expect(notes.map((note) => note.body)).toEqual(["No update this week."]);
    const [logged] = await server.db.select().from(activityLog).where(and(
      eq(activityLog.entityId, stale.id), eq(activityLog.action, "issue.updated"),
    ));
    expect(logged).toMatchObject({ actorType: "system", details: expect.objectContaining({ reason: "superseded_by_next_week" }) });
  }, 60_000);

  it("closes the task when its run ends without saving, and touches no other task", async () => {
    const f = await setup();
    const run = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    expect(await closeWeeklyUpdateTaskAfterRun(server.db, { nativeIssueId: f.issueId })).toBe("not_weekly");
    expect(await closeWeeklyUpdateTaskAfterRun(server.db, { contextSnapshot: { issueId: run.linkedIssueId } })).toBe("closed_no_update");
    const [task] = await server.db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    expect(task!.status).toBe("cancelled");
    expect(await closeWeeklyUpdateTaskAfterRun(server.db, { nativeIssueId: run.linkedIssueId })).toBe("not_weekly");
  }, 60_000);

  it("leaves the weekly update's own tasks out of Home's work lists", async () => {
    const f = await setup();
    const run = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    // A control: an ordinary assigned to-do task is listed.
    const control = await issueService(server.db).create(f.companyId, { title: "Ordinary work", status: "todo", assigneeAgentId: f.agentId });
    const briefing = await briefingService(server.db).get({
      companyId: f.companyId, userId: f.responsibleUserId!,
      actor: { type: "board", source: "local_implicit", userId: f.responsibleUserId!, companyIds: [f.companyId], isInstanceAdmin: false } as never,
    });
    const ids = [...briefing.inProgress, ...briefing.doneRecently].map((item) => item.issueId);
    expect(ids).not.toContain(run.linkedIssueId);
    expect(ids).toContain(control.id);
  }, 60_000);

  it("reads only company-visible tasks in a weekly run while task privacy is enforced", async () => {
    const f = await weeklyRun();
    const secretId = randomUUID();
    const publicId = randomUUID();
    const [base] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    await server.db.insert(issues).values([
      { id: secretId, companyId: f.companyId, issueNumber: 900, identifier: `${base!.identifier}-S`, title: "Quarzite secret plan", status: "todo", visibility: "private", responsibleUserId: f.responsibleUserId, createdByUserId: f.responsibleUserId },
      { id: publicId, companyId: f.companyId, issueNumber: 901, identifier: `${base!.identifier}-P`, title: "Quarzite public plan", status: "todo" },
    ]);
    const found = await f.call("paperclip_search_tasks", { query: "Quarzite" });
    expect(found.body.result.isError, JSON.stringify(found.body)).toBeUndefined();
    const ids = found.body.result.structuredContent.tasks.map((task: { id: string }) => task.id);
    expect(ids).toContain(publicId);
    expect(ids).not.toContain(secretId);
    const direct = await f.call("paperclip_read_task", { taskId: secretId });
    expect(direct.body.result).toMatchObject({ isError: true });
    const briefing = await f.call("staples_get_briefing", {});
    expect(briefing.body.result.isError, JSON.stringify(briefing.body)).toBeUndefined();
    expect(JSON.stringify(briefing.body.result.structuredContent)).not.toContain("Quarzite secret plan");
  }, 60_000);

  it("grants weekly mode with no responsible person, and never on a done or cancelled task", async () => {
    const unowned = await weeklyRun({ responsibleUserId: null });
    // No owner in this company and no default reader yet: nobody to read as.
    expect((await unowned.rpc("tools/list")).status).toBe(403);
    // The company's default responsible person reads instead.
    await server.db.update(companies).set({ defaultResponsibleUserId: unowned.responsibleUserId }).where(eq(companies.id, unowned.companyId));
    expect((await unowned.rpc("tools/list")).status).toBe(200);
    await server.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, unowned.taskId));
    expect((await unowned.rpc("tools/list")).status).toBe(403);
    const finished = await weeklyRun();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, finished.taskId));
    expect((await finished.rpc("tools/list")).status).toBe(403);
  }, 60_000);

  it("never saves the weekly update from a chat, which reads with the person's own access", async () => {
    const f = await setup();
    await server.db.update(heartbeatRuns).set({ agentId: f.assistantId }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ assigneeAgentId: f.assistantId, conversationAgentId: f.assistantId }).where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.assistantId, f.companyId, "claude_local", f.runId, f.responsibleUserId)!;
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await fetch(`${server.apiUrl}/api/mcp/assistant-tools`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const listed = await rpc("tools/list");
    expect(listed.status).toBe(200);
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("paperclip_create_task");
    expect(names).not.toContain("staples_save_weekly_update");
    const saved = await rpc("tools/call", { name: "staples_save_weekly_update", arguments: { body: "## What shipped\n- Chat update" } });
    expect(saved.body.result).toMatchObject({ isError: true });
    expect(saved.body.result.content[0].text).toMatch(/Update me now/);
    const docs = await server.db.select().from(issues).where(and(
      eq(issues.companyId, f.companyId), eq(issues.originKind, ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND),
    ));
    expect(docs).toHaveLength(0);
  }, 60_000);

  it("Update me now runs the weekly routine as a weekly update run, even while its schedule is paused", async () => {
    const f = await setup();
    expect(f.routine.status).toBe("paused");
    const service = builtInAgentService(server.db);
    const run = await service.runRoutine(f.companyId, "assistant", "weekly-update", { userId: f.responsibleUserId });
    expect(run.linkedIssueId).toBeTruthy();
    const [task] = await server.db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    expect(task).toMatchObject({ originKind: "routine_execution", originId: f.routine.id, assigneeAgentId: f.assistantId });
    // While that update is being written, a second press is skipped (Home says so).
    const again = await service.runRoutine(f.companyId, "assistant", "weekly-update", { userId: f.responsibleUserId });
    expect(again.status).toBe("skipped");
    expect(await openTasks(f.companyId, f.routine.id)).toHaveLength(1);
  }, 60_000);

  it("shows no card to a person who cannot read the Weekly updates task, and replaces a cancelled one", async () => {
    const f = await setup();
    const saved = await saveWeeklyUpdate(server.db, { companyId: f.companyId, agentId: f.assistantId, runId: f.runId, body: "Hello" });
    await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, saved.issueId));
    const outsider = await issueReadSqlCondition(server.db, {
      type: "board", source: "session", userId: `outsider-${randomUUID()}`, companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }], isInstanceAdmin: false,
    } as never);
    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: "x", now: Date.now(), readCondition: outsider })).toBeNull();
    expect(await latestWeeklyUpdate(server.db, { companyId: f.companyId, userId: "x", now: Date.now(), readCondition: sql<boolean>`true` })).not.toBeNull();

    await server.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, saved.issueId));
    const next = await saveWeeklyUpdate(server.db, { companyId: f.companyId, agentId: f.assistantId, runId: f.runId, body: "Again" });
    expect(next.issueId).not.toBe(saved.issueId);
  }, 60_000);

  it("keeps a person's opt-out: an unassigned or paused weekly routine stays that way on reconcile", async () => {
    const f = await setup();
    const service = builtInAgentService(server.db);
    const actor = { agentId: null, userId: f.responsibleUserId, runId: null };
    await routineSvc().update(f.routine.id, { status: "paused" }, actor);
    await service.ensure(f.companyId, "assistant");
    expect((await weeklyRoutines(f.companyId))[0]).toMatchObject({ status: "paused", assigneeAgentId: f.assistantId });
    await routineSvc().update(f.routine.id, { assigneeAgentId: null }, actor);
    await service.ensure(f.companyId, "assistant");
    const [kept] = await weeklyRoutines(f.companyId);
    expect(kept!.assigneeAgentId).toBeNull();
    expect(await weeklyRoutines(f.companyId)).toHaveLength(1);

    // A binding written before the flag existed counts as assigned: never reassigned either.
    const [binding] = await server.db.select().from(builtInManagedResources).where(and(
      eq(builtInManagedResources.companyId, f.companyId), eq(builtInManagedResources.resourceKind, "routine"),
    ));
    const { assigned: _assigned, ...legacyDefaults } = binding!.defaultsJson as Record<string, unknown>;
    await server.db.update(builtInManagedResources).set({ defaultsJson: legacyDefaults }).where(eq(builtInManagedResources.id, binding!.id));
    await service.ensure(f.companyId, "assistant");
    expect((await weeklyRoutines(f.companyId))[0]!.assigneeAgentId).toBeNull();
  }, 60_000);

  it("leaves a task whose run is still active on Monday, and skips that week's run", async () => {
    const f = await setup({ hosted: true });
    const first = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    await server.db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.assistantId, status: "running", responsibleUserId: f.responsibleUserId,
      runtimeMode: "native", nativeIssueId: first.linkedIssueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: first.linkedIssueId },
    });
    await server.db.update(routineTriggers).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(routineTriggers.routineId, f.routine.id));
    await routineSvc().tickScheduledTriggers(new Date());
    const tasks = await openTasks(f.companyId, f.routine.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).not.toBe("cancelled");
    const runs = await server.db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id));
    expect(runs.map((run) => run.status)).toContain("skipped");
  }, 60_000);

  it("stranded recovery closes a weekly task only when nothing will retry it", async () => {
    const since = new Date(Date.now() - 1000);
    const f = await setup();
    const run = await routineSvc().runRoutine(f.routine.id, { source: "manual" } as never, { agentId: null, userId: f.responsibleUserId, runId: null });
    const taskId = run.linkedIssueId!;
    const ended = randomUUID();
    await server.db.insert(heartbeatRuns).values({
      id: ended, companyId: f.companyId, agentId: f.assistantId, status: "failed", responsibleUserId: f.responsibleUserId,
      runtimeMode: "native", nativeIssueId: taskId, issueId: taskId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: taskId }, finishedAt: new Date(),
    });
    const retry = randomUUID();
    await server.db.insert(heartbeatRuns).values({
      id: retry, companyId: f.companyId, agentId: f.assistantId, status: "scheduled_retry", retryOfRunId: ended,
      runtimeMode: "native", invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: taskId },
      scheduledRetryAt: new Date(Date.now() + 3_600_000),
    });
    const recovery = heartbeatService(server.db);
    const runsBefore = await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const kept = await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: since });
    expect((await server.db.select().from(issues).where(eq(issues.id, taskId)))[0]!.status).not.toBe("cancelled");
    // The pending retry owns the task: generic recovery starts no parallel retry chain.
    expect(kept.issueIds).not.toContain(taskId);
    const runsAfter = await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runsAfter).toHaveLength(runsBefore.length);

    await server.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retry));
    await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: since });
    expect((await server.db.select().from(issues).where(eq(issues.id, taskId)))[0]!.status).toBe("cancelled");
  }, 60_000);
});

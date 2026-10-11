import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { agents, planApplications, type Db } from "@paperclipai/db";
import {
  planAgentCreationOrder,
  planStructureErrors,
  planTaskCreationOrder,
  type ApplyPlan,
  type ApplyPlanResult,
} from "@paperclipai/shared";
import { conflict, HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { canonicalJson, currentBriefRevisionId, planExistingAssigneeViolation, planRuleViolation } from "./assistant-proposed-actions.js";
import { writeCompanyBrief } from "./company-brief.js";
import { getDefaultCompanyGoal, goalService } from "./goals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

/**
 * Hires one agent through the real agent-hire route (POST
 * /api/companies/:companyId/agent-hires) as the person, so lifecycle, default
 * instructions, skills, task-assignment grants, approvals and activity are
 * exactly those of a hire made from the app.
 */
export type PlanHireAgent = (body: Record<string, unknown>) => Promise<{ statusCode: number; json: unknown }>;

/** Throws an HttpError (403) unless the person may assign work to this agent (`tasks:assign`). */
export type PlanAssertCanAssign = (agentId: string) => Promise<void>;

type HiredAgents = ApplyPlanResult["agents"];

/** Thrown once anything has been created: carries what exists so the caller can report it. */
export class PlanPartiallyAppliedError extends HttpError {
  constructor(status: number, message: string, readonly createdAgents: HiredAgents) {
    super(status, message, { code: "plan_partially_applied", agents: createdAgents });
  }
}

export type AppliedPlan = {
  result: ApplyPlanResult;
  /** True when an earlier apply with this key already created everything; nothing was created now. */
  replayed: boolean;
  briefChanged: boolean;
  goal: { id: string; title: string; level: string } | null;
  project: { id: string; name: string } | null;
  tasks: Array<{ clientKey: string; id: string; identifier: string | null; title: string; status: string; assigneeAgentId: string | null }>;
};

/** How long one apply holds its idempotency key; a crashed apply frees it after this. */
const PLAN_APPLY_LEASE_MS = 5 * 60_000;

/** sha256 of the canonical plan, without the retry key. */
export function planHash(plan: ApplyPlan) {
  const { idempotencyKey: _key, ...rest } = plan;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function errorMessage(json: unknown, statusCode: number) {
  const error = json && typeof json === "object" ? (json as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim() ? error.trim().slice(0, 200) : `HTTP ${statusCode}`;
}

function describeHired(plan: ApplyPlan, hired: HiredAgents) {
  const names = new Map(plan.agents.map((agent) => [agent.clientKey, agent.name] as const));
  return Object.entries(hired).map(([key, agent]) => `${names.get(key) ?? key} (${agent.status}, ${agent.id})`).join(", ");
}

/**
 * Everything checkable before anything is created: references and ordering,
 * the hire rules, existing assignees (in the company, not the Assistant,
 * assignable, and assignable by this person), and the brief's base revision.
 * Throws an HttpError.
 */
export async function validatePlanForApply(db: Db, companyId: string, plan: ApplyPlan, assertCanAssign: PlanAssertCanAssign) {
  const structure = planStructureErrors(plan);
  if (structure.length) throw unprocessable(`The plan is not consistent: ${structure.slice(0, 5).join(" ")}`);
  const violation = planRuleViolation(plan) ?? await planExistingAssigneeViolation(db, plan, companyId);
  if (violation) throw unprocessable(violation);
  for (const agentId of new Set(plan.tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id)))) {
    await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
    await assertCanAssign(agentId);
  }
  if (plan.brief) {
    const current = await currentBriefRevisionId(db, companyId);
    if ((plan.brief.baseRevisionId ?? null) !== current) {
      throw conflict("The company brief was changed by someone else. Reload it and try again.", { currentRevisionId: current });
    }
  }
}

type ApplicationRow = typeof planApplications.$inferSelect;

/** A failed or crashed application older than this is not resumed by a new key. */
const PLAN_RESUME_MAX_AGE_MS = 24 * 3600_000;
const ALREADY_RUNNING = "This plan is already being applied. Wait a moment and check the company before trying again.";

/**
 * Atomically take over an earlier application of the same plan for a new
 * key: the old row is marked superseded only if it is still failed (or
 * in_progress with an expired lease), and a row for the new key inherits its
 * hire map. Of two racing resumers holding the same snapshot, only one wins
 * the conditional update; the other gets a 409.
 */
export async function takeOverPlanApplication(db: Db, previous: ApplicationRow, input: { key: string; userId: string | null }): Promise<ApplicationRow> {
  return db.transaction(async (tx) => {
    const now = new Date();
    // Clearing the lease owner fences the previous apply: its later writes match no row.
    const [taken] = await tx.update(planApplications)
      .set({ status: "superseded", leaseUntil: null, leaseOwner: null, updatedAt: now })
      .where(and(
        eq(planApplications.id, previous.id),
        or(
          eq(planApplications.status, "failed"),
          and(
            eq(planApplications.status, "in_progress"),
            // A lease that was never set counts as expired.
            or(isNull(planApplications.leaseUntil), lt(planApplications.leaseUntil, now)),
          ),
        ),
      ))
      .returning();
    if (!taken) throw conflict(ALREADY_RUNNING);
    let [successor] = await tx.insert(planApplications).values({
      companyId: taken.companyId, idempotencyKey: input.key, planHash: taken.planHash,
      agents: taken.agents, createdByUserId: input.userId,
    }).onConflictDoNothing().returning();
    if (!successor) {
      // The new key was inserted concurrently (the same request twice): carry the hires over.
      const [existing] = await tx.select().from(planApplications)
        .where(and(eq(planApplications.companyId, taken.companyId), eq(planApplications.idempotencyKey, input.key)));
      if (!existing || existing.planHash !== taken.planHash) throw conflict("This idempotency key was already used for a different plan.");
      [successor] = await tx.update(planApplications)
        .set({ agents: { ...taken.agents, ...existing.agents }, updatedAt: now })
        .where(eq(planApplications.id, existing.id)).returning();
    }
    await tx.update(planApplications).set({ supersededById: successor!.id }).where(eq(planApplications.id, taken.id));
    return successor!;
  });
}

/**
 * Find or start this key's application and take its lease. Returns the row
 * (with any agents hired by an earlier attempt), or the stored result when
 * the plan was already applied. A key reused for a different plan, or one
 * held by a concurrent apply, is a 409.
 *
 * With a fresh key, the same person's earlier application of the identical
 * plan in this company from the last 24 hours is taken over when it failed
 * or crashed (in_progress with an expired lease), so proposing the same plan
 * again does not hire twice; one still running is a 409.
 */
export async function claimPlanApplication(db: Db, input: { companyId: string; key: string; hash: string; userId: string | null }):
  Promise<{ kind: "applied"; row: ApplicationRow } | { kind: "claimed"; row: ApplicationRow; leaseOwner: string }> {
  const { companyId, key, hash } = input;
  let [row] = await db.select().from(planApplications)
    .where(and(eq(planApplications.companyId, companyId), eq(planApplications.idempotencyKey, key)));
  if (row && row.planHash !== hash) throw conflict("This idempotency key was already used for a different plan.");
  if (row?.status === "applied") return { kind: "applied", row };
  if (row?.status === "superseded") return { kind: "applied", row: await appliedSuccessor(db, row) };
  if (!row) {
    const now = new Date();
    const [earlier] = input.userId ? await db.select().from(planApplications)
      .where(and(
        eq(planApplications.companyId, companyId),
        eq(planApplications.planHash, hash),
        eq(planApplications.createdByUserId, input.userId),
        or(eq(planApplications.status, "failed"), eq(planApplications.status, "in_progress")),
        gt(planApplications.updatedAt, new Date(now.getTime() - PLAN_RESUME_MAX_AGE_MS)),
      ))
      .orderBy(desc(planApplications.updatedAt)).limit(1) : [];
    if (earlier?.status === "in_progress" && earlier.leaseUntil && earlier.leaseUntil > now) throw conflict(ALREADY_RUNNING);
    if (earlier) {
      row = await takeOverPlanApplication(db, earlier, { key, userId: input.userId });
    } else {
      await db.insert(planApplications).values({ companyId, idempotencyKey: key, planHash: hash, createdByUserId: input.userId })
        .onConflictDoNothing();
      [row] = await db.select().from(planApplications)
        .where(and(eq(planApplications.companyId, companyId), eq(planApplications.idempotencyKey, key)));
      if (!row || row.planHash !== hash) throw conflict("This idempotency key was already used for a different plan.");
    }
  }
  const now = new Date();
  const leaseOwner = randomUUID();
  const [leased] = await db.update(planApplications)
    .set({ status: "in_progress", leaseOwner, leaseUntil: new Date(now.getTime() + PLAN_APPLY_LEASE_MS), updatedAt: now })
    .where(and(
      eq(planApplications.id, row.id),
      or(eq(planApplications.status, "in_progress"), eq(planApplications.status, "failed")),
      or(isNull(planApplications.leaseUntil), lt(planApplications.leaseUntil, now)),
    ))
    .returning();
  if (leased) return { kind: "claimed", row: leased, leaseOwner };
  const [current] = await db.select().from(planApplications).where(eq(planApplications.id, row.id));
  if (current?.status === "applied") return { kind: "applied", row: current };
  if (current?.status === "superseded") return { kind: "applied", row: await appliedSuccessor(db, current) };
  throw conflict(ALREADY_RUNNING);
}

/**
 * A superseded key answers with its successor's stored result once the
 * successor applied; until then the retry is refused (409).
 */
async function appliedSuccessor(db: Db, row: ApplicationRow): Promise<ApplicationRow> {
  let current: ApplicationRow | undefined = row;
  for (let hop = 0; current && current.status === "superseded" && hop < 20; hop += 1) {
    if (!current.supersededById) break;
    [current] = await db.select().from(planApplications).where(eq(planApplications.id, current.supersededById));
  }
  if (current?.status === "applied") return current;
  throw conflict("This plan was continued by a newer request. Check the company, or wait for that request to finish.");
}

/** Thrown when a write finds this apply no longer holds the key (it expired and was taken over). */
export class PlanLeaseLostError extends HttpError {
  constructor() {
    super(409, "This apply lost the plan lease to a newer request");
  }
}

/** Set fields on the application only while this apply still holds its lease, renewing it; otherwise PlanLeaseLostError. */
async function writeLeased(
  executor: Pick<Db, "update">,
  application: { id: string; leaseOwner: string },
  set: Partial<typeof planApplications.$inferInsert>,
  renew = true,
) {
  const now = new Date();
  const [row] = await executor.update(planApplications)
    .set({ ...(renew ? { leaseUntil: new Date(now.getTime() + PLAN_APPLY_LEASE_MS) } : {}), updatedAt: now, ...set })
    .where(and(
      eq(planApplications.id, application.id),
      eq(planApplications.status, "in_progress"),
      eq(planApplications.leaseOwner, application.leaseOwner),
    ))
    .returning({ id: planApplications.id });
  if (!row) throw new PlanLeaseLostError();
}

/** Agents an earlier attempt hired that still exist in this company (not terminated), with their current status. */
async function reusableHires(db: Db, companyId: string, recorded: HiredAgents): Promise<HiredAgents> {
  const reusable: HiredAgents = {};
  for (const [key, agent] of Object.entries(recorded ?? {})) {
    const [row] = await db.select({ id: agents.id, status: agents.status }).from(agents)
      .where(and(eq(agents.id, agent.id), eq(agents.companyId, companyId)));
    if (row && row.status !== "terminated") reusable[key] = { ...agent, status: row.status };
  }
  return reusable;
}

function replay(row: ApplicationRow): AppliedPlan {
  return {
    result: row.result as unknown as ApplyPlanResult,
    replayed: true, briefChanged: false, goal: null, project: null, tasks: [],
  };
}

/**
 * Apply a plan for `userId`.
 *
 * Ordering and compensation: agent hires go through the agent-hire route,
 * which commits on its own and cannot join a transaction. So hires run first
 * (managers before their reports); everything else (brief, goal, project,
 * tasks with their blockers, approval links) is then written in one
 * transaction. If a hire or the transaction fails after at least one hire,
 * nothing else is created and PlanPartiallyAppliedError names the agents that
 * now exist. Nothing is deleted automatically.
 *
 * Idempotency: with an `idempotencyKey`, progress is stored in
 * plan_applications. Each hire is recorded as it succeeds; a retry reuses
 * those agents by client key, and once applied the stored result is returned
 * without creating anything.
 */
export async function applyPlan(db: Db, input: {
  companyId: string;
  plan: ApplyPlan;
  userId: string | null;
  idempotencyKey?: string | null;
  hireAgent: PlanHireAgent;
  assertCanAssign: PlanAssertCanAssign;
}): Promise<AppliedPlan> {
  const { companyId, plan, userId } = input;
  const key = input.idempotencyKey ?? null;
  const hash = planHash(plan);

  if (key) {
    const [existing] = await db.select().from(planApplications)
      .where(and(eq(planApplications.companyId, companyId), eq(planApplications.idempotencyKey, key)));
    if (existing && existing.planHash !== hash) throw conflict("This idempotency key was already used for a different plan.");
    if (existing?.status === "applied") return replay(existing);
    if (existing?.status === "superseded") return replay(await appliedSuccessor(db, existing));
  }

  await validatePlanForApply(db, companyId, plan, input.assertCanAssign);

  let application: (ApplicationRow & { leaseOwner: string }) | null = null;
  if (key) {
    const claimed = await claimPlanApplication(db, { companyId, key, hash, userId });
    if (claimed.kind === "applied") return replay(claimed.row);
    application = { ...claimed.row, leaseOwner: claimed.leaseOwner };
  }

  const hired: HiredAgents = application ? await reusableHires(db, companyId, application.agents) : {};
  // Every write during the apply is fenced by the lease owner and renews the lease.
  const holdLease = async () => {
    if (application) await writeLeased(db, application, {});
  };
  const recordHires = async () => {
    if (application) await writeLeased(db, application, { agents: hired });
  };
  const fail = async (error: unknown): Promise<never> => {
    const status = error instanceof HttpError ? error.status : 500;
    const reason = error instanceof HttpError ? error.message : "The plan could not be saved";
    if (application) {
      // Recording the failure must never replace the error the person needs to see.
      try {
        // Only while still holding the lease: never overwrite a newer request's row.
        await writeLeased(db, application, { status: "failed", agents: hired, lastError: reason.slice(0, 1000), leaseUntil: null, leaseOwner: null }, false);
      } catch (recordError) {
        logger.warn({ err: recordError, planApplicationId: application.id }, "failed to record plan application failure");
      }
    }
    if (Object.keys(hired).length === 0) throw error;
    if (error instanceof PlanPartiallyAppliedError) throw error;
    throw new PlanPartiallyAppliedError(status,
      `${reason}. Hired so far: ${describeHired(plan, hired)}. Nothing else from the plan was created; applying the same plan again reuses these agents.`, hired);
  };

  try {
    for (const agent of planAgentCreationOrder(plan.agents)) {
      if (hired[agent.clientKey]) continue;
      // Stop before hiring if a newer request took the plan over.
      await holdLease();
      const body: Record<string, unknown> = { name: agent.name, role: agent.role, adapterType: agent.adapterType };
      if (agent.title !== undefined) body.title = agent.title;
      if (agent.capabilities !== undefined) body.capabilities = agent.capabilities;
      if (agent.budgetMonthlyCents !== undefined) body.budgetMonthlyCents = agent.budgetMonthlyCents;
      if (agent.reportsToClientKey) body.reportsTo = hired[agent.reportsToClientKey]!.id;
      let response: Awaited<ReturnType<PlanHireAgent>>;
      try {
        response = await input.hireAgent(body);
      } catch (error) {
        response = { statusCode: 500, json: { error: error instanceof Error ? error.message : "Hire failed" } };
      }
      const json = (response.json ?? {}) as { agent?: { id?: unknown; status?: unknown }; approval?: { id?: unknown } | null };
      if (response.statusCode >= 400 || typeof json.agent?.id !== "string") {
        const status = response.statusCode >= 400 ? response.statusCode : 500;
        const reason = `Hiring ${agent.name} failed: ${errorMessage(response.json, response.statusCode)}`;
        throw Object.keys(hired).length
          ? new PlanPartiallyAppliedError(status,
            `${reason}. Hired so far: ${describeHired(plan, hired)}. Nothing else from the plan was created; applying the same plan again reuses these agents.`, hired)
          : new HttpError(status, reason);
      }
      hired[agent.clientKey] = {
        id: json.agent.id,
        status: typeof json.agent.status === "string" ? json.agent.status : "idle",
        approvalId: typeof json.approval?.id === "string" ? json.approval.id : null,
      };
      await recordHires();
    }

    // The new agents exist now: check the person may assign them work.
    for (const clientKey of new Set(plan.tasks.map((task) => task.assigneeClientKey).filter((k): k is string => Boolean(k)))) {
      const agent = hired[clientKey]!;
      if (agent.status !== "pending_approval") await input.assertCanAssign(agent.id);
    }
    // Renew right before the transaction; the transaction checks ownership again when it marks the plan applied.
    await holdLease();
  } catch (error) {
    return fail(error);
  }

  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      let brief: ApplyPlanResult["brief"] = null;
      let briefChanged = false;
      if (plan.brief) {
        const written = await writeCompanyBrief(tx, companyId, { body: plan.brief.body, baseRevisionId: plan.brief.baseRevisionId }, { userId });
        brief = { revisionId: written.brief.revisionId, revisionNumber: written.brief.revisionNumber };
        briefChanged = written.changed;
      }

      let goal: AppliedPlan["goal"] = null;
      if (plan.goal) {
        const companyGoal = await getDefaultCompanyGoal(txDb, companyId);
        const created = await goalService(txDb).create(companyId, {
          title: plan.goal.title,
          description: plan.goal.description ?? null,
          level: companyGoal ? "task" : "company",
          status: "active",
          parentId: companyGoal?.id ?? null,
        });
        goal = { id: created!.id, title: created!.title, level: created!.level };
      }

      let project: AppliedPlan["project"] = null;
      if (plan.project) {
        const created = await projectService(txDb).create(companyId, {
          name: plan.project.name,
          description: plan.project.description ?? null,
          status: "planned",
          privacyOwnerUserId: userId,
          ...(goal ? { goalIds: [goal.id] } : {}),
        });
        project = { id: created.id, name: created.name };
      }

      const issues = issueService(db);
      const created = new Map<string, AppliedPlan["tasks"][number]>();
      const pendingAssignments: ApplyPlanResult["pendingAssignments"] = [];
      for (const task of planTaskCreationOrder(plan.tasks)) {
        const newAgent = task.assigneeClientKey ? hired[task.assigneeClientKey]! : null;
        // Work cannot be assigned to an agent awaiting hire approval: such tasks
        // wait unassigned in the backlog, linked to the hire approval.
        const waitsForApproval = newAgent !== null && newAgent.status === "pending_approval";
        const assigneeAgentId = waitsForApproval ? null : (newAgent?.id ?? task.assigneeAgentId ?? null);
        const issue = await issues.create(companyId, {
          title: task.title,
          description: task.description ?? null,
          // Unassigned work goes to the backlog so nothing wakes for it.
          status: assigneeAgentId ? "todo" : "backlog",
          priority: "medium",
          assigneeAgentId,
          parentId: task.parentClientKey ? created.get(task.parentClientKey)!.id : null,
          projectId: project?.id ?? null,
          goalId: goal?.id ?? null,
          blockedByIssueIds: task.blockedByClientKeys.map((blocker) => created.get(blocker)!.id),
          createdByUserId: userId,
          actorResponsibleUserId: userId,
          trustExplicitResponsibleUserId: true,
        }, tx);
        created.set(task.clientKey, {
          clientKey: task.clientKey, id: issue.id, identifier: issue.identifier ?? null, title: issue.title,
          status: issue.status, assigneeAgentId: issue.assigneeAgentId ?? null,
        });
        if (waitsForApproval) {
          pendingAssignments.push({ taskClientKey: task.clientKey, agentClientKey: task.assigneeClientKey!, agentId: newAgent.id, approvalId: newAgent.approvalId });
        }
      }

      const approvalLinks = new Map<string, string[]>();
      for (const pending of pendingAssignments) {
        if (!pending.approvalId) continue;
        approvalLinks.set(pending.approvalId, [...(approvalLinks.get(pending.approvalId) ?? []), created.get(pending.taskClientKey)!.id]);
      }
      for (const [approvalId, issueIds] of approvalLinks) {
        await issueApprovalService(txDb).linkManyForApproval(approvalId, issueIds, { userId });
      }

      const tasks = [...created.values()];
      const result: ApplyPlanResult = {
        brief,
        goal: goal ? { id: goal.id, level: goal.level } : null,
        project: project ? { id: project.id } : null,
        agents: hired,
        tasks: Object.fromEntries(tasks.map((task) => [task.clientKey, {
          id: task.id, identifier: task.identifier, status: task.status, assigneeAgentId: task.assigneeAgentId,
        }])),
        pendingAssignments,
      };
      if (application) {
        // Marked applied in the same transaction that created everything.
        // Fenced: if the lease was lost, this throws and everything above rolls back.
        await writeLeased(tx, application, {
          status: "applied", agents: hired, result: result as unknown as Record<string, unknown>,
          lastError: null, leaseUntil: null, leaseOwner: null,
        }, false);
      }
      return { result, replayed: false, briefChanged, goal, project, tasks };
    });
  } catch (error) {
    if (error instanceof HttpError && Object.keys(hired).length) {
      return fail(new HttpError(error.status,
        `${error.message}. The plan's agents were hired, but its brief, goal, project and tasks were not created`));
    }
    return fail(error);
  }
}

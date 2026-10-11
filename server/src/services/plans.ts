import type { Db } from "@paperclipai/db";
import {
  planAgentCreationOrder,
  planStructureErrors,
  planTaskCreationOrder,
  type ApplyPlan,
  type ApplyPlanResult,
} from "@paperclipai/shared";
import { conflict, HttpError, unprocessable } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { currentBriefRevisionId, planExistingAssigneeViolation, planRuleViolation } from "./assistant-proposed-actions.js";
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

/** Thrown once anything has been created: carries what exists so the caller can report it. */
export class PlanPartiallyAppliedError extends HttpError {
  constructor(status: number, message: string, readonly createdAgents: ApplyPlanResult["agents"]) {
    super(status, message, { code: "plan_partially_applied", agents: createdAgents });
  }
}

export type AppliedPlan = {
  result: ApplyPlanResult;
  briefChanged: boolean;
  goal: { id: string; title: string; level: string } | null;
  project: { id: string; name: string } | null;
  tasks: Array<{ clientKey: string; id: string; identifier: string | null; title: string; status: string; assigneeAgentId: string | null }>;
};

function errorMessage(json: unknown, statusCode: number) {
  const error = json && typeof json === "object" ? (json as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim() ? error.trim().slice(0, 300) : `HTTP ${statusCode}`;
}

/**
 * Everything checkable before anything is created: references and ordering,
 * the hire rules, existing assignees (in the company, not the Assistant, and
 * assignable), and the brief's base revision. Throws an HttpError.
 */
export async function validatePlanForApply(db: Db, companyId: string, plan: ApplyPlan) {
  const structure = planStructureErrors(plan);
  if (structure.length) throw unprocessable(`The plan is not consistent: ${structure.slice(0, 5).join(" ")}`);
  const violation = planRuleViolation(plan) ?? await planExistingAssigneeViolation(db, plan, companyId);
  if (violation) throw unprocessable(violation);
  for (const agentId of new Set(plan.tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id)))) {
    await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
  }
  if (plan.brief) {
    const current = await currentBriefRevisionId(db, companyId);
    if ((plan.brief.baseRevisionId ?? null) !== current) {
      throw conflict("The company brief was changed by someone else. Reload it and try again.", { currentRevisionId: current });
    }
  }
}

/**
 * Apply a validated plan for `userId`.
 *
 * Ordering and compensation: agent hires go through the agent-hire route,
 * which commits on its own and cannot join a transaction. So hires run first
 * (managers before their reports); everything else (brief, goal, project,
 * tasks with their blockers, approval links) is then written in one
 * transaction. If a hire or the transaction fails after at least one hire,
 * nothing else is created and PlanPartiallyAppliedError names the agents that
 * now exist (pending hires keep their approval, which the person can reject).
 * Nothing is deleted automatically.
 */
export async function applyPlan(db: Db, input: {
  companyId: string;
  plan: ApplyPlan;
  userId: string | null;
  hireAgent: PlanHireAgent;
}): Promise<AppliedPlan> {
  const { companyId, plan, userId } = input;
  await validatePlanForApply(db, companyId, plan);

  const hired: ApplyPlanResult["agents"] = {};
  for (const agent of planAgentCreationOrder(plan.agents)) {
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
      const reason = `Hiring ${agent.name} failed: ${errorMessage(response.json, response.statusCode)}`;
      if (Object.keys(hired).length === 0) throw new HttpError(response.statusCode >= 400 ? response.statusCode : 500, reason);
      throw new PlanPartiallyAppliedError(response.statusCode >= 400 ? response.statusCode : 500,
        `${reason}. Already hired: ${Object.values(hired).length} agent(s); nothing else from the plan was created.`, hired);
    }
    hired[agent.clientKey] = {
      id: json.agent.id,
      status: typeof json.agent.status === "string" ? json.agent.status : "idle",
      approvalId: typeof json.approval?.id === "string" ? json.approval.id : null,
    };
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
          blockedByIssueIds: task.blockedByClientKeys.map((key) => created.get(key)!.id),
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
      return {
        result: {
          brief,
          goal: goal ? { id: goal.id, level: goal.level } : null,
          project: project ? { id: project.id } : null,
          agents: hired,
          tasks: Object.fromEntries(tasks.map((task) => [task.clientKey, {
            id: task.id, identifier: task.identifier, status: task.status, assigneeAgentId: task.assigneeAgentId,
          }])),
          pendingAssignments,
        },
        briefChanged,
        goal,
        project,
        tasks,
      };
    });
  } catch (error) {
    if (Object.keys(hired).length === 0) throw error;
    const status = error instanceof HttpError ? error.status : 500;
    const reason = error instanceof HttpError ? error.message : "The plan could not be saved";
    throw new PlanPartiallyAppliedError(status,
      `${reason}. The plan's agents were hired, but its brief, goal, project and tasks were not created.`, hired);
  }
}

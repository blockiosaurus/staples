import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { applyPlanSchema, isUuidLike } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { applyPlan, PlanPartiallyAppliedError, type PlanHireAgent } from "../services/plans.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export type PlanRoutesOptions = {
  /**
   * Performs POST /api/companies/:companyId/agent-hires in-process as `actor`.
   * `origin` is this request's already-verified browser origin (null for a
   * local trusted board), forwarded so the hire passes the same board
   * mutation guard this request passed.
   */
  hireAgent: (actor: Request["actor"], companyId: string, body: Record<string, unknown>, origin: string | null) => ReturnType<PlanHireAgent>;
  pluginWorkerManager?: PluginWorkerManager;
  /** Tests may replace the wake scheduler. */
  heartbeat?: IssueAssignmentWakeupDeps;
};

export function planRoutes(db: Db, options: PlanRoutesOptions) {
  const router = Router();
  const access = accessService(db);
  let heartbeat = options.heartbeat ?? null;
  const wakeScheduler = () => (heartbeat ??= heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager }));

  // The person applies a plan from their own interactive session (the browser
  // runs a confirmed plan proposal this way). Never an agent, the Assistant
  // run, an MCP connection or a board API key.
  router.post("/companies/:companyId/plans/apply", validate(applyPlanSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    if (
      req.actor.type !== "board" ||
      (req.actor.source !== "session" && req.actor.source !== "local_implicit") ||
      !req.actor.userId
    ) {
      throw forbidden("Plans are applied by a person from their own session");
    }
    assertCompanyAccess(req, companyId);
    const plan = applyPlanSchema.parse(req.body);
    // Fail before creating anything when the person cannot hire.
    if (plan.agents.length) {
      const decision = await access.decide({ actor: req.actor, action: "agents:create", resource: { type: "company", companyId } });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    const actor = getActorInfo(req);
    const userId = req.actor.userId;
    const origin = trustedBoardMutationOrigin(req);
    const activityBase = { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId };

    let applied: Awaited<ReturnType<typeof applyPlan>>;
    try {
      applied = await applyPlan(db, {
        companyId, plan, userId,
        hireAgent: (body) => options.hireAgent(req.actor, companyId, body, origin),
      });
    } catch (error) {
      if (!(error instanceof PlanPartiallyAppliedError)) throw error;
      await logActivity(db, {
        ...activityBase, action: "plan.apply_failed", entityType: "company", entityId: companyId,
        details: { reason: error.message, createdAgents: error.createdAgents },
      });
      res.status(error.status).json({ error: error.message, code: "plan_partially_applied", partial: { agents: error.createdAgents } });
      return;
    }

    const { result } = applied;
    if (applied.briefChanged && result.brief) {
      await logActivity(db, {
        ...activityBase, action: "company.brief_updated", entityType: "company", entityId: companyId,
        details: { revisionId: result.brief.revisionId, revisionNumber: result.brief.revisionNumber, length: plan.brief!.body.length, source: "plan" },
      });
    }
    if (applied.goal) {
      await logActivity(db, { ...activityBase, action: "goal.created", entityType: "goal", entityId: applied.goal.id, details: { title: applied.goal.title, source: "plan" } });
    }
    if (applied.project) {
      await logActivity(db, { ...activityBase, action: "project.created", entityType: "project", entityId: applied.project.id, details: { name: applied.project.name, source: "plan" } });
    }
    for (const task of applied.tasks) {
      await logActivity(db, {
        ...activityBase, action: "issue.created", entityType: "issue", entityId: task.id,
        details: { title: task.title, identifier: task.identifier, source: "plan" },
      });
    }
    await logActivity(db, {
      ...activityBase, action: "plan.applied", entityType: "company", entityId: companyId,
      details: {
        briefRevisionId: result.brief?.revisionId ?? null,
        goalId: result.goal?.id ?? null,
        projectId: result.project?.id ?? null,
        agents: result.agents,
        tasks: Object.fromEntries(Object.entries(result.tasks).map(([key, task]) => [key, task.id])),
        pendingAssignments: result.pendingAssignments,
      },
    });
    for (const task of applied.tasks) {
      void queueIssueAssignmentWakeup({
        heartbeat: wakeScheduler(),
        issue: { id: task.id, assigneeAgentId: task.assigneeAgentId, status: task.status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "plan.apply",
        requestedByActorType: "user",
        requestedByActorId: userId,
      });
    }
    res.status(201).json(result);
  });

  return router;
}

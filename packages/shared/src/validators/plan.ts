import { z } from "zod";
import { COMPANY_BRIEF_MAX_CHARS } from "./company-brief.js";

/**
 * A whole starter plan the person confirms in one step: an optional company
 * brief, goal and project, new agents, and tasks that reference each other
 * (and the new agents) by client key.
 */
/** `staples/<slug>`: a Staples agent template (see agent-template types). */
export const PLAN_TEMPLATE_REF_PATTERN = /^staples\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Most setup answers one templated agent may carry. */
export const PLAN_TEMPLATE_ANSWERS_MAX_KEYS = 40;

const planTemplateAnswersSchema = z.record(
  z.string().min(1).max(100),
  z.union([z.string().max(2000), z.array(z.string().max(2000)).max(40)]),
).refine((answers) => Object.keys(answers).length <= PLAN_TEMPLATE_ANSWERS_MAX_KEYS, {
  message: `templateAnswers may hold at most ${PLAN_TEMPLATE_ANSWERS_MAX_KEYS} answers`,
});

/**
 * One new agent. An untemplated agent names its name, role and adapterType.
 * A templated agent (`templateRef`) may leave name, role, title, adapterType
 * and budget to the template; its instructions, skills, routines and starter
 * tasks always come from the template, never from the plan. The server pins
 * `templateVersion` when the plan is proposed; apply installs that version.
 */
export const applyPlanAgentSchema = z.object({
  clientKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80).optional(), role: z.string().optional(), title: z.string().max(80).optional(),
  capabilities: z.string().max(1000).optional(), adapterType: z.string().optional(),
  budgetMonthlyCents: z.number().int().min(0).max(10_000_000).optional(),
  reportsToClientKey: z.string().optional(),
  templateRef: z.string().regex(PLAN_TEMPLATE_REF_PATTERN, "templateRef must be staples/<slug>").optional(),
  templateVersion: z.string().min(1).max(64).optional(),
  /** Setup answers by question id: option ids for choices, text otherwise. */
  templateAnswers: planTemplateAnswersSchema.optional(),
}).strict().superRefine((agent, ctx) => {
  if (agent.templateRef) return;
  for (const key of ["name", "role", "adapterType"] as const) {
    if (agent[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required unless the agent uses a templateRef` });
  }
  for (const key of ["templateVersion", "templateAnswers"] as const) {
    if (agent[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} needs a templateRef` });
  }
});

export const applyPlanSchema = z.object({
  brief: z.object({ body: z.string().min(1).max(COMPANY_BRIEF_MAX_CHARS), baseRevisionId: z.string().uuid().nullable() }).optional(),
  goal: z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).optional() }).optional(),
  project: z.object({ name: z.string().min(1).max(120), description: z.string().max(4000).optional() }).optional(),
  agents: z.array(applyPlanAgentSchema).max(8).default([]),
  tasks: z.array(z.object({
    clientKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: z.string().min(1).max(200), description: z.string().max(8000).optional(),
    assigneeClientKey: z.string().optional(), assigneeAgentId: z.string().uuid().optional(),
    parentClientKey: z.string().optional(), blockedByClientKeys: z.array(z.string()).max(10).default([]),
  }).strict()).max(25).default([]),
  /**
   * Optional retry key (the browser sends the proposal's interaction id as the
   * Idempotency-Key header instead). A retry with the same key resumes the
   * same application: agents already hired are reused, and a plan already
   * applied returns its stored result. Not part of the plan's identity.
   */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/).optional(),
}).strict().superRefine((plan, ctx) => {
  // A templated agent brings its own starter tasks; otherwise a plan needs at least one task.
  if (plan.tasks.length === 0 && !plan.agents.some((agent) => agent.templateRef)) {
    ctx.addIssue({ code: "custom", path: ["tasks"], message: "A plan needs at least one task (or a templated agent)" });
  }
});

export type ApplyPlan = z.infer<typeof applyPlanSchema>;
export type ApplyPlanInput = z.input<typeof applyPlanSchema>;
export type ApplyPlanAgent = ApplyPlan["agents"][number];
export type ApplyPlanTask = ApplyPlan["tasks"][number];

/** What POST /api/companies/:companyId/plans/apply returns: created ids by client key. */
export type ApplyPlanResult = {
  brief: { revisionId: string; revisionNumber: number } | null;
  goal: { id: string; level: string } | null;
  project: { id: string } | null;
  /** `templateRef` is set for agents installed from a template. */
  agents: Record<string, { id: string; status: string; approvalId: string | null; templateRef?: string | null }>;
  /**
   * Plan tasks by their client key, plus a templated agent's tasks under
   * `<agentClientKey>~connect-<capability>` and `<agentClientKey>~starter-<n>`.
   */
  tasks: Record<string, { id: string; identifier: string | null; status: string; assigneeAgentId: string | null }>;
  /** Routines from templates (paused and unassigned while the hire awaits approval). Absent in results stored before templates. */
  routines?: Array<{ id: string; title: string; agentClientKey: string; status: string; assigneeAgentId: string | null }>;
  /** Tasks whose new agent awaits hire approval: created unassigned in the backlog, linked to the approval. */
  pendingAssignments: Array<{ taskClientKey: string; agentClientKey: string; agentId: string; approvalId: string | null }>;
  /**
   * Set when the plan hired agents on the hosted key and the company's hosted
   * limit was raised for them, or could not be raised far enough
   * (`limited`: the monthly budgets come to more than the operator's ceiling).
   */
  hostedLimit?: { fromCents: number; toCents: number; neededCents: number; ceilingCents: number; limited: boolean };
};

export class PlanStructureError extends Error {}

type Node = { clientKey: string };

/** Depth-first topological order over `deps`; throws PlanStructureError naming the first cycle. */
function topologicalOrder<T extends Node>(items: readonly T[], deps: (item: T) => string[], label: string): T[] {
  const byKey = new Map(items.map((item) => [item.clientKey, item] as const));
  const state = new Map<string, "visiting" | "done">();
  const ordered: T[] = [];
  const visit = (key: string, path: string[]) => {
    const current = state.get(key);
    if (current === "done") return;
    if (current === "visiting") {
      throw new PlanStructureError(`${label} contain a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}.`);
    }
    const item = byKey.get(key);
    if (!item) throw new PlanStructureError(`${label} reference unknown clientKey ${key}.`);
    state.set(key, "visiting");
    for (const dep of deps(item)) visit(dep, [...path, key]);
    state.set(key, "done");
    ordered.push(item);
  };
  for (const item of items) visit(item.clientKey, []);
  return ordered;
}

/**
 * Tasks in creation order: a task's parent and blockers are created before
 * it, so their ids are known when it is created. Throws on unknown keys and
 * on cycles in the combined parent + blocked-by graph.
 */
export function planTaskCreationOrder<T extends Pick<ApplyPlanTask, "clientKey" | "parentClientKey" | "blockedByClientKeys">>(tasks: readonly T[]): T[] {
  return topologicalOrder(tasks, (task) => [
    ...(task.parentClientKey ? [task.parentClientKey] : []),
    ...(task.blockedByClientKeys ?? []),
  ], "Tasks (parents and blockers)");
}

/** New agents in hiring order: a manager is hired before the agents that report to it. */
export function planAgentCreationOrder<T extends Pick<ApplyPlanAgent, "clientKey" | "reportsToClientKey">>(agents: readonly T[]): T[] {
  return topologicalOrder(agents, (agent) => (agent.reportsToClientKey ? [agent.reportsToClientKey] : []), "Agent reporting lines");
}

function duplicates(keys: string[]) {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const key of keys) (seen.has(key) ? dups : seen).add(key);
  return [...dups];
}

/** Reference and ordering problems in a parsed plan, as plain sentences. Empty when consistent. */
export function planStructureErrors(plan: ApplyPlan): string[] {
  const errors: string[] = [];
  const agentKeys = new Set(plan.agents.map((agent) => agent.clientKey));
  const taskKeys = new Set(plan.tasks.map((task) => task.clientKey));
  for (const key of duplicates(plan.agents.map((agent) => agent.clientKey))) errors.push(`Each agent clientKey must be unique (agent clientKey ${key} repeats).`);
  for (const key of duplicates(plan.tasks.map((task) => task.clientKey))) errors.push(`Each task clientKey must be unique (task clientKey ${key} repeats).`);
  for (const agent of plan.agents) {
    if (agent.reportsToClientKey !== undefined && !agentKeys.has(agent.reportsToClientKey)) {
      errors.push(`Agent ${agent.clientKey}: reportsToClientKey ${agent.reportsToClientKey} is not an agent in this plan.`);
    }
  }
  for (const task of plan.tasks) {
    if (task.assigneeClientKey !== undefined && task.assigneeAgentId !== undefined) {
      errors.push(`Task ${task.clientKey}: set only one of assigneeClientKey and assigneeAgentId.`);
    }
    if (task.assigneeClientKey !== undefined && !agentKeys.has(task.assigneeClientKey)) {
      errors.push(`Task ${task.clientKey}: assigneeClientKey ${task.assigneeClientKey} is not an agent in this plan.`);
    }
    if (task.parentClientKey !== undefined && !taskKeys.has(task.parentClientKey)) {
      errors.push(`Task ${task.clientKey}: parentClientKey ${task.parentClientKey} is not a task in this plan.`);
    }
    for (const key of task.blockedByClientKeys) {
      if (!taskKeys.has(key)) errors.push(`Task ${task.clientKey}: blockedByClientKeys ${key} is not a task in this plan.`);
    }
  }
  if (errors.length) return errors;
  for (const order of [() => planAgentCreationOrder(plan.agents), () => planTaskCreationOrder(plan.tasks)]) {
    try {
      order();
    } catch (error) {
      if (!(error instanceof PlanStructureError)) throw error;
      errors.push(error.message);
    }
  }
  return errors;
}

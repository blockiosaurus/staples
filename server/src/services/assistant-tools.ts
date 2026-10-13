import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { agents, approvals, authUsers, companies, companyMemberships, issueThreadInteractions, issues, routines, type Db } from "@paperclipai/db";
import { COMPANY_BRIEF_MAX_CHARS, PROPOSED_ACTION_BODY_MAX_BYTES, PROPOSED_ACTION_CATEGORIES, PROPOSED_BRIEF_BODY_MAX_BYTES, PROPOSED_PLAN_BODY_MAX_BYTES, applyPlanSchema, PROPOSED_ACTION_METHODS, createIssueThreadInteractionSchema, isAssistantAgent, paperclipQuestionSchema, type ProposedActionContext } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import { HOSTED_HIRE_ADAPTER_TYPE, PROPOSABLE_HIRE_ADAPTER_TYPES, isProvisionedAssistant, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { hostedInference as hostedInferenceStatus } from "./hosted-inference.js";
import { planBudgetSummary } from "./hosted-inference-access.js";
import { publicMcpCapabilities } from "./public-mcp/capabilities.js";
import { defaultAgentTemplates, planHireAdapterDefaults, planTemplateContext, planTemplateSummariesFor } from "./plan-templates.js";
import { APPROVAL_DECISION_PATH, PROPOSABLE_AGENT_ROLES, ProposedActionError, assertQuestionAddressedTo, pinBriefProposalBody, pinPlanProposalBody, proposedActionDetailsMarkdown, proposedActionHash, validateGovernedAction } from "./assistant-proposed-actions.js";
import { assistantHireDefaults, planHireInheritsConnection } from "./plans.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { logActivity } from "./activity-log.js";
import { WEEKLY_UPDATE_BODY_MAX_CHARS, saveWeeklyUpdate } from "./assistant-weekly-update.js";
import { isAssistantWeeklyUpdateRoutine } from "./assistant-weekly-update-origin.js";
import { McpApiError, McpCapabilityError, object, pick, rows, taskFields, pathId, type ApiDispatch, type Capability } from "./public-mcp/contracts.js";
import type { McpPrincipal } from "./public-mcp/oauth.js";

/** Read tools a person's Assistant may call, reused from the public MCP surface where possible. */
export const ASSISTANT_READ_TOOL_NAMES = [
  "paperclip_connection", "paperclip_list_agents", "paperclip_list_projects", "paperclip_search_tasks",
  "paperclip_read_task", "paperclip_list_deliverables", "paperclip_read_document", "paperclip_list_document_revisions",
  "paperclip_pending_approvals", "paperclip_get_agent", "paperclip_get_project", "paperclip_list_skills",
  "paperclip_get_skill", "staples_company_signals", "staples_briefing_inputs", "staples_get_briefing", "staples_get_company_brief",
  "staples_list_templates", "staples_get_template",
] as const;

/**
 * The Assistant is proposal-only: in a person's chat it can ask them questions
 * and put cards in front of them, and every change (tasks and comments
 * included) runs only when the person confirms it, with their own session. The
 * weekly update save is not here: a chat reads with that person's own task
 * access, so it must never publish a company-wide update (only a weekly update
 * run, which reads company-visible work only, may save one).
 */
export const ASSISTANT_WRITE_TOOL_NAMES = [
  "staples_propose_action", "staples_ask_questions", "staples_propose_plan",
] as const;

export const SAVE_WEEKLY_UPDATE_TOOL = "staples_save_weekly_update";
/**
 * A weekly update run (the Assistant's own weekly update routine task) gets the
 * read tools and this one write, nothing else: no person is in the loop to
 * confirm anything, so every other write stays out of reach.
 */
export const ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES = [SAVE_WEEKLY_UPDATE_TOOL] as const;

const BRIEFING_CAP = 20;

export type AssistantToolContext = {
  companyId: string;
  agentId: string;
  runId: string;
  userId: string;
  /** The run's task (its Assistant conversation), derived from the run row, never from tool input. */
  issueId: string;
  /**
   * "conversation" (default): a person's chat, with that person's authority.
   * "weekly_update": the Assistant's own weekly update routine task; reads as
   * the routine's responsible person, and only staples_save_weekly_update writes.
   */
  mode?: "conversation" | "weekly_update";
  /** Reads see only company-visible tasks and projects (weekly update runs). */
  companyVisibleOnly?: boolean;
  membership: { companyId: string; membershipRole: string | null; status: string };
  company: { id: string; name: string; issuePrefix: string; status: string };
  canWrite: boolean;
};

/**
 * Resolve the Assistant's authority from the authenticated run, never from
 * tool arguments: the caller must be the Assistant's own live run, and the run's
 * responsible person must be an active member of the run's company.
 */
export async function assistantToolContext(db: Db, actor: Request["actor"]): Promise<AssistantToolContext> {
  if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || !actor.companyId) {
    throw forbidden("Assistant tools require an authenticated Assistant run");
  }
  // Provisioning record plus marker; a marker in agent metadata alone is not authority.
  if (!(await isProvisionedAssistant(db, { id: actor.agentId, companyId: actor.companyId }))) {
    throw forbidden("Assistant tools are only available to the Assistant");
  }
  // Locks the task/run and accepts any acknowledged steering, so the
  // responsible person is the one currently attached to this live run.
  const { run } = await captureRunIdentity(db, { companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId });
  const snapshot = run.contextSnapshot ?? {};
  const issueId = run.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : null);
  const userId = run.responsibleUserId;
  // The person's authority is lent only inside their own Assistant conversation.
  if (!issueId) throw forbidden("Assistant tools are only available in the person's Assistant conversation");
  const [issue] = await db.select({
    conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId, generation: issues.conversationSessionGeneration,
    originKind: issues.originKind, originId: issues.originId, assigneeAgentId: issues.assigneeAgentId, status: issues.status,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)));
  if (!issue) throw forbidden("Run task is unavailable");
  if (!issue.conversationAgentId && await isOwnWeeklyUpdateTask(db, actor.companyId, actor.agentId, issue)) {
    return weeklyUpdateContext(db, { companyId: actor.companyId, agentId: actor.agentId, runId: run.id, issueId, userId: userId ?? null });
  }
  if (!userId) throw forbidden("Assistant tools require a responsible person");
  if (issue.conversationAgentId !== actor.agentId || issue.conversationUserId !== userId) {
    throw forbidden("Assistant tools are only available in the person's Assistant conversation");
  }
  if (Number(snapshot.conversationSessionGeneration ?? 0) !== issue.generation) {
    throw forbidden("Conversation session has changed");
  }
  const membership = await activeMembership(db, actor.companyId, userId);
  if (!membership) throw forbidden("The responsible person is not an active member of this company");
  const company = await liveCompany(db, actor.companyId);
  return {
    companyId: actor.companyId, agentId: actor.agentId, runId: run.id, userId, issueId, membership, company,
    canWrite: membership.membershipRole !== "viewer", mode: "conversation",
  };
}

async function activeMembership(db: Db, companyId: string, userId: string) {
  const [membership] = await db.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    ));
  return membership ?? null;
}

async function liveCompany(db: Db, companyId: string) {
  const [company] = await db.select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status })
    .from(companies).where(eq(companies.id, companyId));
  if (!company || company.status === "archived") throw forbidden("Company is unavailable");
  return company;
}

/** The run's task is an open execution task of the Assistant's own weekly update routine, assigned to it. */
async function isOwnWeeklyUpdateTask(
  db: Db, companyId: string, agentId: string,
  issue: { originKind: string | null; originId: string | null; assigneeAgentId: string | null; status: string },
) {
  if (issue.originKind !== "routine_execution" || !issue.originId || issue.assigneeAgentId !== agentId) return false;
  if (issue.status === "done" || issue.status === "cancelled") return false;
  const [routine] = await db.select({ originKind: routines.originKind, originId: routines.originId, assigneeAgentId: routines.assigneeAgentId })
    .from(routines).where(and(eq(routines.id, issue.originId), eq(routines.companyId, companyId)));
  return isAssistantWeeklyUpdateRoutine(routine) && routine!.assigneeAgentId === agentId;
}

/**
 * Who a weekly update run reads as: the run's responsible person when they are
 * an active member, else the company's default responsible person or owner
 * (the routine has no chat owner). Always with a viewer role, and with task
 * privacy narrowed to company-visible work: the update is published on a
 * company-visible task, so it must never summarize anyone's private tasks.
 * Writes are limited to the weekly update document regardless.
 */
async function weeklyUpdateContext(
  db: Db, input: { companyId: string; agentId: string; runId: string; issueId: string; userId: string | null },
): Promise<AssistantToolContext> {
  const company = await liveCompany(db, input.companyId);
  let userId = input.userId;
  let membership = userId ? await activeMembership(db, input.companyId, userId) : null;
  if (!membership) {
    const [company] = await db.select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
      .from(companies).where(eq(companies.id, input.companyId));
    const [owner] = await db.select({ userId: companyMemberships.principalId }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"), eq(companyMemberships.membershipRole, "owner"),
    )).orderBy(companyMemberships.createdAt).limit(1);
    userId = company?.defaultResponsibleUserId ?? owner?.userId ?? null;
    membership = userId ? await activeMembership(db, input.companyId, userId) : null;
    if (!membership && owner?.userId && owner.userId !== userId) {
      userId = owner.userId;
      membership = await activeMembership(db, input.companyId, userId);
    }
  }
  if (!userId || !membership) throw forbidden("The weekly update needs an active member of this company to read as");
  return {
    companyId: input.companyId, agentId: input.agentId, runId: input.runId, userId, issueId: input.issueId,
    // Reads only as the person: the one write is checked by name, not by role.
    membership: { ...membership, membershipRole: "viewer" }, company, canWrite: false, mode: "weekly_update",
    companyVisibleOnly: true,
  };
}

/** The board actor every dispatched API call runs as: the person, scoped to one company, attributed to the run. */
export function assistantBoardActor(context: AssistantToolContext): Request["actor"] {
  return {
    type: "board", source: "assistant_run", userId: context.userId,
    companyIds: [context.companyId], memberships: [context.membership],
    isInstanceAdmin: false, assistantRunId: context.runId,
    ...(context.companyVisibleOnly ? { companyVisibleOnly: true } : {}),
  };
}

/**
 * Public MCP capabilities read principal.grant/company. The synthesized grant
 * carries only identity derived from the run; it is never persisted and no
 * OAuth receipt or scope check applies to it.
 */
export function assistantPrincipal(context: AssistantToolContext): McpPrincipal {
  const grant = {
    id: `assistant-run:${context.runId}`, companyId: context.companyId, userId: context.userId,
    clientId: "staples-assistant", scopes: context.canWrite ? ["paperclip:read", "paperclip:write"] : ["paperclip:read"],
  };
  return { grant: grant as unknown as McpPrincipal["grant"], actor: assistantBoardActor(context), company: context.company };
}

/** Agents hidden from and unassignable by the Assistant: the provisioned one plus anything carrying the marker. */
async function assistantAgentIds(db: Db, companyId: string) {
  const companyAgents = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
  const ids = new Set(companyAgents.filter((agent) => isAssistantAgent(agent)).map((agent) => agent.id));
  const provisioned = await resolveCompanyAssistantAgentId(db, companyId);
  if (provisioned) ids.add(provisioned);
  return ids;
}

/**
 * The Assistant's own adapter (and engine, when set), so it can recommend the
 * model the person already connected for new hires. Credentials and other
 * config never leave the server.
 */
async function assistantRuntimeSummary(db: Db, companyId: string) {
  const id = await resolveCompanyAssistantAgentId(db, companyId);
  if (!id) return null;
  const [row] = await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId)));
  if (!row) return null;
  const engine = object(row.adapterConfig).engine;
  return {
    adapterType: row.adapterType,
    ...(engine === "cli" || engine === "acp" ? { engine } : {}),
    note: "New hires on this adapter get the Assistant's connected model when the plan is applied.",
  };
}

/**
 * What new hires may run on in this company, and what to recommend: Claude
 * (hosted) when the company runs on it (`hostedInference` true means the
 * server's key pays, under hard-stop monthly caps), else the Assistant's own
 * adapter. Booleans and adapter names only; never a key.
 */
async function hiringSummary(db: Db, companyId: string) {
  const defaults = await planHireAdapterDefaults(db, companyId);
  const recommendedAdapterType = defaults.hostedHires
    ? HOSTED_HIRE_ADAPTER_TYPE
    : defaults.fallbackAdapterType && defaults.hireAdapterTypes.includes(defaults.fallbackAdapterType)
      ? defaults.fallbackAdapterType
      : defaults.hireAdapterTypes.includes(HOSTED_HIRE_ADAPTER_TYPE) ? HOSTED_HIRE_ADAPTER_TYPE : null;
  return {
    hostedInference: hostedInferenceStatus().available,
    adapterTypes: defaults.hireAdapterTypes,
    recommendedAdapterType,
    ...(recommendedAdapterType === HOSTED_HIRE_ADAPTER_TYPE
      ? { note: "Recommend Claude (hosted), adapterType claude_managed, for new hires. It runs in Anthropic's cloud with no setup; its model and spending caps are set by the server." }
      : {}),
  };
}

function capability(name: string) {
  const found = publicMcpCapabilities.find((c) => c.name === name);
  if (!found) throw new Error(`Missing public MCP capability ${name}`);
  return found;
}

const companyField = { companyId: z.uuid().optional().describe("Optional. Defaults to the Assistant's company; any other company is rejected.") };

function assistantCapabilities(db: Db): Capability[] {
  const reused = (name: string, override?: Partial<Capability>): Capability => ({ ...capability(name), ...override });
  return [
    reused("paperclip_connection", {
      run: async (p) => ({
        user: { id: p.actor.userId }, companyId: p.company.id, company: p.company,
        permissions: p.grant.scopes, runId: p.actor.assistantRunId,
        execution: "The Assistant acts as this person with their company permissions. Tasks run through Paperclip scheduling, budgets and approvals.",
        assistant: await assistantRuntimeSummary(db, p.company.id),
        hiring: await hiringSummary(db, p.company.id),
      }),
    }),
    reused("paperclip_list_agents", {
      run: async (p, a, api, origin) => {
        const result = await capability("paperclip_list_agents").run(p, a, api, origin);
        const hidden = await assistantAgentIds(db, p.company.id);
        return { agents: rows(result.agents).filter((agent) => !hidden.has(String(object(agent).id))) };
      },
    }),
    ...["paperclip_list_projects", "paperclip_search_tasks", "paperclip_read_task", "paperclip_list_deliverables",
      "paperclip_read_document", "paperclip_list_document_revisions", "paperclip_pending_approvals",
      "paperclip_get_project", "paperclip_list_skills", "paperclip_get_skill"].map((name) => reused(name)),
    reused("paperclip_get_agent", {
      run: async (p, a, api, origin) => {
        if ((await assistantAgentIds(db, p.company.id)).has(String(a.agentId))) throw new McpCapabilityError("Agent not found.");
        return capability("paperclip_get_agent").run(p, a, api, origin);
      },
    }),
    {
      name: "staples_company_signals", description: "Read the company's usage signals (counts of agents, tasks, projects, approvals, questions and spend) to tailor guidance.",
      schema: z.object(companyField).strict(),
      run: async (p, _a, api) => ({ signals: await api(p, "GET", `/companies/${pathId(p.company.id)}/signals`) }),
    },
    {
      name: "staples_briefing_inputs",
      description: `Gather briefing inputs for this person: pending approvals, open questions awaiting them, and blocked tasks (at most ${BRIEFING_CAP} each).`,
      schema: z.object(companyField).strict(),
      run: async (p, _a, api) => {
        const companyPath = `/companies/${pathId(p.company.id)}`;
        const [approvals, attention, blocked] = await Promise.all([
          api(p, "GET", `${companyPath}/approvals?status=pending`),
          api(p, "GET", `${companyPath}/attention?all=true`),
          api(p, "GET", `${companyPath}/issues?status=blocked&limit=${BRIEFING_CAP}`),
        ]);
        return {
          pendingApprovals: rows(approvals).slice(0, BRIEFING_CAP).map((v) => pick(v, ["id", "type", "status", "requestedByAgentId", "requestedByUserId", "createdAt"])),
          openQuestions: rows(object(attention).items)
            .filter((item) => object(item).sourceKind === "issue_thread_interaction")
            .slice(0, BRIEFING_CAP)
            .map((item) => {
              const subject = object(object(item).subject);
              const metadata = object(subject.metadata);
              return { interactionId: subject.id, issueId: metadata.issueId ?? null, kind: metadata.kind ?? null, title: subject.title ?? null,
                whyNow: object(item).whyNow ?? null, href: subject.href ?? null, createdAt: object(item).createdAt ?? null };
            }),
          blockedTasks: rows(blocked).slice(0, BRIEFING_CAP).map((v) => pick(v, taskFields)),
        };
      },
    },
    {
      name: "staples_get_briefing",
      description: "Read this person's Home briefing: the ranked items waiting on them (questions, confirmations, approvals, blocked work, budget), each with a title, why it matters now, a link and a recommendation when one is stored on the item. Computed for the acting person only. Use it for \"what needs me\", \"what's going on\", \"catch me up\".",
      schema: z.object(companyField).strict(),
      run: async (p, _a, api) => ({ briefing: await api(p, "GET", `/companies/${pathId(p.company.id)}/briefing`) }),
    },
    {
      name: PROPOSE_ACTION_TOOL, write: true,
      description: [
        "Propose one exact governed API call for this person to confirm. Nothing runs until they click Confirm on the card in this conversation; their browser then performs the call with their own session and you are woken with the result.",
        `Changing the company brief is governed too: propose PUT /api/companies/<companyId>/brief with category brief and body { body: <the whole new brief in markdown, at most ${COMPANY_BRIEF_MAX_CHARS} characters>, baseRevisionId: <revisionId from staples_get_company_brief> }. Batch edits: one proposal per topic, not per sentence. To create a whole plan (brief, goal, project, agents and tasks) in one card, use staples_propose_plan instead.`,
        "Task work is proposed here too: create a task (POST /api/companies/<companyId>/issues with title, and optionally description, priority, status backlog or todo, assigneeAgentId (a staff agent, never the Assistant) or assigneeUserId, projectId, parentId), edit one (PATCH /api/issues/<id> changing only title, description, status (never done, cancelled, blocked or in_review), priority, assigneeAgentId, assigneeUserId, projectId or parentId; not a closed task), comment on one (POST /api/issues/<id>/comments with { body }), answer an open question an agent asked the person (POST /api/issues/<id>/interactions/<interactionId>/respond with { answers }, only answers the person gave you), and pin a sidebar item (PATCH /api/companies/<companyId>/ui-preferences/me with { pin: [<surfaceId>] }). None of these may target a chat.",
        "The other allowed actions are governed ones: approval approve/reject/request-revision, the company brief (category brief), agent hire/create/pause/resume/terminate (adapterType is required; CEO-level hires are done in the Agents page), budget policy and budget updates, secret create/update/delete (never include secret values; an update may only change name, description or status), revoking a connection, grant or delegation (DELETE with body null), DELETE with body null under this company or one of its tasks (removing tool policies, the skill policy, issue approval links, watchdogs or skill files is not proposable), and a whole starter plan (category plan; propose it with staples_propose_plan). Creating or changing connections is not proposable: point the person to the Connectors page to set them up.",
        "The path must start with /api/ and refer to this company. category is derived from the path. Optionally pass staleCheck { path, field: \"updatedAt\", expected } with a GET path whose updatedAt must be unchanged when the person confirms.",
      ].join(" "),
      schema: z.object({
        ...companyField,
        method: z.enum(PROPOSED_ACTION_METHODS),
        path: z.string().min(5).max(1000).describe("Exact API path including the leading /api/, e.g. /api/approvals/<id>/approve."),
        body: z.unknown().optional().describe(`JSON request body, or null. At most ${PROPOSED_ACTION_BODY_MAX_BYTES} bytes serialized (${PROPOSED_BRIEF_BODY_MAX_BYTES} for a brief proposal, ${PROPOSED_PLAN_BODY_MAX_BYTES} for a plan).`),
        summary: z.string().trim().min(1).max(500).describe("One sentence shown on the Confirm card, in plain language."),
        category: z.enum(PROPOSED_ACTION_CATEGORIES).optional().describe("Ignored: the server derives the category from the path."),
        staleCheck: z.object({ path: z.string().min(5).max(1000), field: z.literal("updatedAt"), expected: z.string().trim().min(1).max(100) }).strict().optional(),
      }).strict(),
      // Dispatched in createAssistantTools: it needs the run's conversation, not just the principal.
      run: async () => { throw new McpCapabilityError("Tool is unavailable to the Assistant."); },
    },
    {
      name: ASK_QUESTIONS_TOOL, write: true,
      description: [
        "Ask the person up to 8 questions as a card in this conversation. Use it instead of asking in plain text. Ask only the questions that can be answered right now, in rounds, and number the ids in order (q1, q2, ...).",
        "Every single_select or multi_select question must mark the option you recommend with recommended: true (exactly one for single_select), worded so that accepting it is a yes. Use answerMode text for open answers, and customAnswer { enabled: true } to allow an other answer.",
        "After asking, end your turn: you are woken with the answers when the person submits. Do not guess the answers.",
      ].join(" "),
      schema: z.object({
        ...companyField,
        title: z.string().trim().max(240).optional().describe("Short heading for the card."),
        questions: z.array(paperclipQuestionSchema).min(1).max(8),
      }).strict(),
      // Dispatched in createAssistantTools: it needs the run's conversation, not just the principal.
      run: async () => { throw new McpCapabilityError("Tool is unavailable to the Assistant."); },
    },
    {
      name: PROPOSE_PLAN_TOOL, write: true,
      description: [
        "Propose a whole starter plan for this person to confirm in one card: optionally the company brief (the whole new brief), a goal and a project, new agents, and 0 to 25 tasks. Nothing is created until they click Create plan; their browser then applies it with their own session and you are woken with the result.",
        "Agents and tasks refer to each other by clientKey (lowercase letters, digits and dashes). A task's assignee is assigneeClientKey (a new agent in this plan) or assigneeAgentId (an existing staff agent, never the Assistant), or none. parentClientKey and blockedByClientKeys refer to other tasks in the plan and must not form a cycle.",
        "A hire that matches a template (staples_list_templates) is a templated agent: give it clientKey, templateRef and templateAnswers (the answers to the template's setup questions, keyed by question id); name, role, title and capabilities are optional and come from the template. Never write instructions for a templated hire. A templated agent may have no tasks: its template adds its own starter tasks and routines.",
        `New agents: role one of ${PROPOSABLE_AGENT_ROLES.join(", ")} (never ceo); adapterType one of the company's hiring.adapterTypes from paperclip_connection (${PROPOSABLE_HIRE_ADAPTER_TYPES.join(", ")}, and ${HOSTED_HIRE_ADAPTER_TYPE} when listed there), preferring hiring.recommendedAdapterType; a templated agent may omit it (the server picks the recommended one); no other settings. If the company requires approval for new agents, their tasks are created unassigned in the backlog and linked to the hire approval.`,
        `brief.baseRevisionId is the revisionId from staples_get_company_brief, or null when there is no brief. The whole plan must serialize to at most ${PROPOSED_PLAN_BODY_MAX_BYTES} bytes.`,
      ].join(" "),
      schema: z.object({
        ...companyField,
        plan: applyPlanSchema,
        summary: z.string().trim().min(1).max(500).describe("One sentence shown on the card, in plain language."),
      }).strict(),
      // Dispatched in createAssistantTools: it needs the run's conversation, not just the principal.
      run: async () => { throw new McpCapabilityError("Tool is unavailable to the Assistant."); },
    },
    {
      name: SAVE_WEEKLY_UPDATE_TOOL, write: true,
      description: [
        "Save this week's update for the company: what shipped, what's blocked and what you need from the person, spend against budget, and next week, as Markdown (follow the staples-weekly-update skill).",
        "It is saved as the document \"Weekly update — <date>\" on the company's \"Weekly updates\" task, which the server creates and owns; you cannot choose another task or key. Saving again the same day replaces that day's update.",
        "Returns the task, the document key, an href to share, and timezone/timezoneKnown (when false, dates use UTC; do not save again, just say so in a final chat line).",
      ].join(" "),
      schema: z.object({
        ...companyField,
        body: z.string().trim().min(1).max(WEEKLY_UPDATE_BODY_MAX_CHARS).describe("The update as Markdown, without a title."),
      }).strict(),
      // Dispatched in createAssistantTools: it needs the run's identity, not just the principal.
      run: async () => { throw new McpCapabilityError("Tool is unavailable to the Assistant."); },
    },
    {
      name: "staples_list_templates",
      description: "List the hireable agent templates (ready-made agents such as an email secretary or a bookkeeper): ref, name, summary, the apps each needs and its outward actions. Check it when the person wants a hire that might match one, then read the match with staples_get_template.",
      schema: z.object(companyField).strict(),
      run: async () => ({ templates: await defaultAgentTemplates().list() }),
    },
    {
      name: "staples_get_template",
      description: "Read one agent template by ref: its description and setupQuestions (each with a recommendation) with this person's and company's names filled in. Ask the setup questions with staples_ask_questions, then propose a plan whose agent carries templateRef and templateAnswers.",
      schema: z.object({ ...companyField, ref: z.string().trim().min(1).max(200) }).strict(),
      run: async (p, a) => {
        const ctx = await planTemplateContext(db, p.company.id, p.actor.userId ?? null);
        return { template: await defaultAgentTemplates().get(String(a.ref), { companyName: ctx.companyName, personName: ctx.personName }) };
      },
    },
    {
      name: "staples_get_company_brief",
      description: "Read the company brief (mission, glossary, key decisions) that every agent sees. Returns null when there is none. Read it before proposing a change so your proposal starts from the current text.",
      schema: z.object(companyField).strict(),
      run: async (p, _a, api) => ({ brief: await api(p, "GET", `/companies/${pathId(p.company.id)}/brief`) }),
    },
  ];
}

const PROPOSE_ACTION_TOOL = "staples_propose_action";
const ASK_QUESTIONS_TOOL = "staples_ask_questions";
const PROPOSE_PLAN_TOOL = "staples_propose_plan";

/** Adapter config keys that run or shape a host process. */
const COMMAND_LIKE_KEY = /command|^cmd$|args$|^env$|script|shell|executable|entrypoint|binary/i;
const clip = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function commandLikeKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) commandLikeKeys(item, found);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (COMMAND_LIKE_KEY.test(key) && !found.includes(key) && found.length < 20) found.push(key.slice(0, 120));
      commandLikeKeys(child, found);
    }
  }
  return found;
}

/**
 * For approval decisions, read the approval and describe what is being
 * decided, so the card does not rely on the Assistant's summary. Server-owned:
 * not hashed, and the Assistant cannot supply it. `approvalUpdatedAt` pins the
 * approval revision the decision was proposed against (checked at claim).
 */
async function approvalDecisionContext(db: Db, companyId: string, path: string): Promise<ProposedActionContext | null> {
  const approvalId = APPROVAL_DECISION_PATH.exec(path)?.[1];
  if (!approvalId) return null;
  const [approval] = await db.select({
    type: approvals.type, payload: approvals.payload, updatedAt: approvals.updatedAt,
    requestedByAgentId: approvals.requestedByAgentId, requestedByUserId: approvals.requestedByUserId,
  }).from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
  if (!approval) return null;
  let requestedBy: string | null = null;
  if (approval.requestedByAgentId) {
    const [agent] = await db.select({ name: agents.name }).from(agents)
      .where(and(eq(agents.id, approval.requestedByAgentId), eq(agents.companyId, companyId)));
    requestedBy = clip(agent?.name, 200);
  } else if (approval.requestedByUserId) {
    const [user] = await db.select({ name: authUsers.name, email: authUsers.email }).from(authUsers).where(eq(authUsers.id, approval.requestedByUserId));
    requestedBy = clip(user?.name, 200) ?? clip(user?.email, 200);
  }
  const context: ProposedActionContext = {
    source: "approval", approvalType: approval.type.slice(0, 80), requestedBy, approvalUpdatedAt: approval.updatedAt.toISOString(),
  };
  if (approval.type === "hire_agent") {
    const payload = object(approval.payload);
    context.agentName = clip(payload.name, 200);
    context.agentRole = clip(payload.role, 80);
    context.adapterType = clip(payload.adapterType, 120);
    context.adapterConfigCommandFields = commandLikeKeys(payload.adapterConfig).sort();
  }
  return context;
}

/**
 * Which of a plan's new agents will inherit the Assistant's model connection,
 * for the card only: computed here from the database, never from the Assistant's
 * input, and not read by apply (which decides for itself when it hires).
 */
export async function planHireConnectionsFor(db: Db, companyId: string, body: unknown) {
  const plan = applyPlanSchema.safeParse(body);
  if (!plan.success || !plan.data.agents.length) return [];
  const assistant = await assistantHireDefaults(db, companyId);
  const binding = assistant?.aiConnection;
  if (!binding) return [];
  const provider = "provider" in binding ? binding.provider : null;
  return plan.data.agents
    .filter((agent) => planHireInheritsConnection(agent, assistant))
    .map((agent) => ({ clientKey: agent.clientKey, provider }));
}

/**
 * The plan card's budget line (display only, like planHireConnectionsFor): the
 * hires' monthly budgets, and the hosted limit they fit or will raise.
 */
export async function planBudgetFor(db: Db, companyId: string, body: unknown) {
  const plan = applyPlanSchema.safeParse(body);
  if (!plan.success) return null;
  return planBudgetSummary(db, companyId, plan.data);
}

/**
 * Create a governed Confirm card on the run's own Assistant conversation,
 * addressed to the run's person. The interaction is created directly through
 * the service because proposedAction is server-owned and refused on the
 * public create route.
 */
async function proposeAction(db: Db, context: AssistantToolContext, args: Record<string, unknown>) {
  if (!context.issueId) throw new McpCapabilityError("Proposed actions can only be made from this person's Assistant conversation.");
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId,
  }).from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, context.companyId)));
  if (!issue || issue.conversationAgentId !== context.agentId || issue.conversationUserId !== context.userId) {
    throw new McpCapabilityError("Proposed actions can only be made from this person's Assistant conversation.");
  }
  // The continuation wake goes to the issue's assignee; it must be the Assistant.
  if (issue.assigneeAgentId !== context.agentId) {
    throw new McpCapabilityError("This conversation is not assigned to the Assistant, so it could not be told the outcome. Ask the person to reassign it first.");
  }
  const method = String(args.method);
  const path = String(args.path);
  let body: unknown = args.body === undefined ? null : args.body;
  const summary = String(args.summary).trim();
  const staleCheck = args.staleCheck as { path: string; field: "updatedAt"; expected: string } | undefined;
  let category: Awaited<ReturnType<typeof validateGovernedAction>>["category"];
  let hash: string;
  try {
    ({ category } = await validateGovernedAction(db, { method, path, body, staleCheckPath: staleCheck?.path ?? null }, context.companyId));
    await assertQuestionAddressedTo(db, path, context.userId);
    // Brief proposals (and a plan's brief) replace a specific revision; the server pins it.
    if (category === "brief") body = await pinBriefProposalBody(db, context.companyId, body);
    if (category === "plan") body = await pinPlanProposalBody(db, context.companyId, body, { userId: context.userId });
    hash = proposedActionHash({ method, path, body });
  } catch (error) {
    if (error instanceof ProposedActionError) throw new McpCapabilityError(error.message);
    throw error;
  }
  const planHireConnections = category === "plan" ? await planHireConnectionsFor(db, context.companyId, body) : [];
  const planTemplateSummaries = category === "plan" ? await planTemplateSummariesFor(body) : [];
  const planBudget = category === "plan" ? await planBudgetFor(db, context.companyId, body) : null;
  const approvalContext = category === "approval" ? await approvalDecisionContext(db, context.companyId, path) : null;
  const proposedAction = {
    version: 1 as const, method: method as (typeof PROPOSED_ACTION_METHODS)[number], path, body, summary, category, hash,
    ...(staleCheck ? { staleCheck: { path: staleCheck.path, field: "updatedAt" as const, expected: staleCheck.expected } } : {}),
    ...(approvalContext ? { context: approvalContext } : {}),
    ...(planHireConnections.length ? { planHireConnections } : {}),
    ...(planTemplateSummaries.length ? { planTemplateSummaries } : {}),
    ...(planBudget ? { planBudget } : {}),
  };
  const interaction = await issueThreadInteractionService(db).create(issue, {
    kind: "request_confirmation",
    // The Assistant is the conversation's assignee; wake it on Confirm and on Cancel.
    continuationPolicy: "wake_assignee",
    addresseeUserId: context.userId,
    sourceRunId: context.runId,
    idempotencyKey: `assistant-proposed-action:${context.runId}:${hash}`,
    title: summary.slice(0, 240),
    payload: {
      version: 1, prompt: summary, acceptLabel: category === "brief" ? "Update brief" : category === "plan" ? "Create plan" : "Confirm", rejectLabel: "Cancel",
      detailsMarkdown: proposedActionDetailsMarkdown({ method, path, body }),
      supersedeOnUserComment: false,
      proposedAction,
    },
  }, { agentId: context.agentId, runId: context.runId }, { allowProposedAction: true });
  await logActivity(db, {
    companyId: context.companyId, actorType: "agent", actorId: context.agentId, agentId: context.agentId, runId: context.runId,
    action: "issue.thread_interaction_created", entityType: "issue", entityId: issue.id,
    details: { interactionId: interaction.id, interactionKind: interaction.kind, proposedAction: { method, path, category, hash }, addresseeUserId: context.userId },
  });
  return {
    interaction: { id: interaction.id, issueId: interaction.issueId, status: interaction.status },
    proposedAction: { method, path, category, hash },
    next: "The person will see a Confirm card. Do not claim the action happened; you will be woken with the result.",
  };
}

/**
 * Ask the person questions as an Assistant-authored card on the run's own
 * conversation. Created through the service (not the person's API session) so
 * the card's author and source run are the Assistant; the answers wake it.
 */
async function askQuestions(db: Db, context: AssistantToolContext, args: Record<string, unknown>) {
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId,
  }).from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, context.companyId)));
  if (!issue || issue.conversationAgentId !== context.agentId || issue.conversationUserId !== context.userId) {
    throw new McpCapabilityError("Questions can only be asked from this person's Assistant conversation.");
  }
  if (issue.assigneeAgentId !== context.agentId) {
    throw new McpCapabilityError("This conversation is not assigned to the Assistant, so it could not be woken with the answers. Ask the person to reassign it first.");
  }
  const questions = args.questions as unknown[];
  const title = typeof args.title === "string" && args.title ? args.title : undefined;
  const questionSet = { schema: "paperclip.question_set.v1" as const, ...(title ? { title } : {}), questions };
  const hash = createHash("sha256").update(JSON.stringify({ title: title ?? null, questions })).digest("hex").slice(0, 24);
  const idempotencyKey = `assistant-questions:${context.runId}:${hash}`;
  // One open card at a time: a replay of the same ask is fine, a new ask is not.
  const pending = await db.select({ id: issueThreadInteractions.id, issueId: issueThreadInteractions.issueId, status: issueThreadInteractions.status, idempotencyKey: issueThreadInteractions.idempotencyKey })
    .from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.kind, "ask_user_questions"),
      eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.createdByAgentId, context.agentId),
    ));
  const replay = pending.find((row) => row.idempotencyKey === idempotencyKey);
  if (replay) {
    return {
      interaction: { id: replay.id, issueId: replay.issueId, status: replay.status },
      next: "The person will see the question card. End your turn; you will be woken with their answers.",
    };
  }
  if (pending.length > 0) {
    throw new McpCapabilityError("A question card is still waiting for the person. Wait for their answers or continue without asking.");
  }
  const data = createIssueThreadInteractionSchema.parse({
    kind: "ask_user_questions",
    continuationPolicy: "wake_assignee",
    addresseeUserId: context.userId,
    sourceRunId: context.runId,
    idempotencyKey,
    ...(title ? { title } : {}),
    payload: { version: 1, ...(title ? { title } : {}), questionSet },
  });
  let interaction;
  try {
    interaction = await issueThreadInteractionService(db).create(issue, data, { agentId: context.agentId, runId: context.runId });
  } catch (error) {
    const details = (error as { details?: { code?: string; questionIds?: string[] } }).details;
    if (details?.code === "question_recommendation_required") {
      const ids = (details.questionIds ?? []).join(", ");
      throw new McpCapabilityError(`Every select question needs exactly one option marked recommended: true (at least one for multi_select). Fix these questions and ask again: ${ids}.`);
    }
    throw error;
  }
  await logActivity(db, {
    companyId: context.companyId, actorType: "agent", actorId: context.agentId, agentId: context.agentId, runId: context.runId,
    action: "issue.thread_interaction_created", entityType: "issue", entityId: issue.id,
    details: { interactionId: interaction.id, interactionKind: interaction.kind, addresseeUserId: context.userId },
  });
  return {
    interaction: { id: interaction.id, issueId: interaction.issueId, status: interaction.status },
    next: "The person will see the question card. End your turn; you will be woken with their answers.",
  };
}

/**
 * The Assistant's one write outside a person's confirmation: its own weekly
 * update document. The target task and key are resolved by the server; in a
 * weekly update run the routine task is closed once the update is saved.
 */
async function saveWeeklyUpdateTool(db: Db, context: AssistantToolContext, args: Record<string, unknown>) {
  try {
    const saved = await saveWeeklyUpdate(db, {
      companyId: context.companyId, agentId: context.agentId, runId: context.runId, body: String(args.body ?? ""),
      executionIssueId: context.issueId,
    });
    return {
      saved: { taskId: saved.issueId, taskIdentifier: saved.issueIdentifier, documentId: saved.documentId, key: saved.key, title: saved.title },
      href: `/${context.company.issuePrefix}${saved.href}`,
      timezone: saved.timezone, timezoneKnown: saved.timezoneKnown,
      next: "Saved, and the routine task is closed. End your run.",
    };
  } catch (error) {
    if (error instanceof McpCapabilityError) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new McpCapabilityError(message.startsWith("The weekly update") ? message : "The weekly update could not be saved. Try again.");
  }
}

function exposedSchema(schema: Capability["schema"]) {
  // companyId is authority, not input: the run's company is always used.
  return "companyId" in schema.shape ? schema.omit({ companyId: true }) : schema;
}

function safeMessage(error: unknown) {
  if (error instanceof McpCapabilityError || error instanceof McpApiError) return error.message;
  if (error instanceof z.ZodError) {
    return "Invalid arguments: " + error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  }
  return "The Assistant tool failed. Inspect the task in Paperclip before trying again.";
}

export type AssistantToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

export function createAssistantTools(db: Db, options: { dispatch: ApiDispatch; origin?: string }) {
  const all = assistantCapabilities(db);
  const byName = new Map(all.map((c) => [c.name, c]));
  const writeNames = new Set<string>([...ASSISTANT_WRITE_TOOL_NAMES, ...ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES]);
  const weeklyRunWriteNames = new Set<string>(ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES);
  const origin = (options.origin ?? "").replace(/\/+$/, "");

  return {
    isWriteTool: (name: string) => writeNames.has(name),
    isKnownTool: (name: string) => byName.has(name),
    /** Viewers see read tools only; a weekly update run sees the read tools and the weekly update save. */
    definitions(canWrite: boolean, mode: AssistantToolContext["mode"] = "conversation") {
      const names: readonly string[] = mode === "weekly_update"
        ? [...ASSISTANT_READ_TOOL_NAMES, ...ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES]
        : canWrite ? [...ASSISTANT_READ_TOOL_NAMES, ...ASSISTANT_WRITE_TOOL_NAMES] : ASSISTANT_READ_TOOL_NAMES;
      return names.map((name) => {
        const c = byName.get(name)!;
        return { name: c.name, description: c.description, inputSchema: z.toJSONSchema(exposedSchema(c.schema)) };
      });
    },
    /** Callers must have rejected write tools for viewers before calling. */
    async call(context: AssistantToolContext, name: string, input: unknown): Promise<AssistantToolResult> {
      try {
        const c = byName.get(name);
        if (!c) throw new McpCapabilityError("Tool is unavailable to the Assistant.");
        if (context.mode === "weekly_update") {
          if (writeNames.has(name) && !weeklyRunWriteNames.has(name)) {
            throw new McpCapabilityError("A weekly update run can only read and save the weekly update.");
          }
        } else if (weeklyRunWriteNames.has(name)) {
          throw new McpCapabilityError("The weekly update is saved only by the weekly update routine. Ask the person to use Update me now on Home.");
        } else if (writeNames.has(name) && !context.canWrite) throw new McpCapabilityError("This person has read-only access.");
        const raw = { ...object(input) };
        if (raw.companyId !== undefined && raw.companyId !== context.companyId) throw new McpCapabilityError("Company does not match the Assistant's company.");
        // Tools without a companyId input (e.g. paperclip_connection) are strict, so only inject it where declared.
        const { companyId: _requestedCompanyId, ...rest } = raw;
        const args = c.schema.parse("companyId" in c.schema.shape ? { ...rest, companyId: context.companyId } : rest);
        const result = name === PROPOSE_ACTION_TOOL
          ? await proposeAction(db, context, args)
          : name === PROPOSE_PLAN_TOOL
          ? await proposeAction(db, context, {
            method: "POST", path: `/api/companies/${context.companyId}/plans/apply`, body: args.plan, summary: args.summary,
          })
          : name === ASK_QUESTIONS_TOOL
          ? await askQuestions(db, context, args)
          : name === SAVE_WEEKLY_UPDATE_TOOL
          ? await saveWeeklyUpdateTool(db, context, args)
          : await c.run(assistantPrincipal(context), args, options.dispatch, origin);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: safeMessage(error) }] };
      }
    },
  };
}
export type AssistantTools = ReturnType<typeof createAssistantTools>;

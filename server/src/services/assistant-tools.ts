import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, companies, companyMemberships, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { askUserQuestionsAnswerSchema, isAssistantAgent, surfaceIdSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import { publicMcpCapabilities } from "./public-mcp/capabilities.js";
import { McpApiError, McpCapabilityError, object, pick, rows, taskFields, pathId, type ApiDispatch, type Capability } from "./public-mcp/contracts.js";
import type { McpPrincipal } from "./public-mcp/oauth.js";

/** Read tools a person's Assistant may call, reused from the public MCP surface where possible. */
export const ASSISTANT_READ_TOOL_NAMES = [
  "paperclip_connection", "paperclip_list_agents", "paperclip_list_projects", "paperclip_search_tasks",
  "paperclip_read_task", "paperclip_list_deliverables", "paperclip_read_document", "paperclip_list_document_revisions",
  "paperclip_pending_approvals", "paperclip_get_agent", "paperclip_get_project", "paperclip_list_skills",
  "paperclip_get_skill", "staples_company_signals", "staples_briefing_inputs",
] as const;

/** Low-risk writes. Governed actions (finish, block, delete, configure, approvals) are not exposed. */
export const ASSISTANT_WRITE_TOOL_NAMES = [
  "paperclip_create_task", "paperclip_add_comment", "paperclip_update_task", "staples_answer_question", "staples_pin_surface",
] as const;

/** `paperclip_update_task` may only touch these fields. */
export const ASSISTANT_UPDATE_TASK_FIELDS = [
  "title", "description", "status", "priority", "assigneeAgentId", "assigneeUserId", "projectId", "parentId",
] as const;
/** Terminal and blocking transitions are governed (finish/block/cancel), not low-risk edits. */
const GOVERNED_STATUSES = new Set(["done", "cancelled", "blocked"]);
const BRIEFING_CAP = 20;

export type AssistantToolContext = {
  companyId: string;
  agentId: string;
  runId: string;
  userId: string;
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
  const [agent] = await db.select({ id: agents.id, metadata: agents.metadata, status: agents.status })
    .from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, actor.companyId)));
  if (!agent || !isAssistantAgent(agent)) throw forbidden("Assistant tools are only available to the Assistant");
  // Locks the task/run and accepts any acknowledged steering, so the
  // responsible person is the one currently attached to this live run.
  const { run } = await captureRunIdentity(db, { companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId });
  const snapshot = run.contextSnapshot ?? {};
  const issueId = run.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : null);
  if (issueId) {
    const [issue] = await db.select({ conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId, generation: issues.conversationSessionGeneration })
      .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)));
    if (!issue) throw forbidden("Run task is unavailable");
    if (issue.conversationAgentId && Number(snapshot.conversationSessionGeneration ?? 0) !== issue.generation) {
      throw forbidden("Conversation session has changed");
    }
  }
  const userId = run.responsibleUserId;
  if (!userId) throw forbidden("Assistant tools require a responsible person");
  const [membership] = await db.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(
      eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    ));
  if (!membership) throw forbidden("The responsible person is not an active member of this company");
  const [company] = await db.select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status })
    .from(companies).where(eq(companies.id, actor.companyId));
  if (!company || company.status === "archived") throw forbidden("Company is unavailable");
  return {
    companyId: actor.companyId, agentId: actor.agentId, runId: run.id, userId, membership, company,
    canWrite: membership.membershipRole !== "viewer",
  };
}

/** The board actor every dispatched API call runs as: the person, scoped to one company, attributed to the run. */
export function assistantBoardActor(context: AssistantToolContext): Request["actor"] {
  return {
    type: "board", source: "assistant_run", userId: context.userId,
    companyIds: [context.companyId], memberships: [context.membership],
    isInstanceAdmin: false, assistantRunId: context.runId,
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

async function assistantAgentIds(db: Db, companyId: string) {
  const companyAgents = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
  return new Set(companyAgents.filter((agent) => isAssistantAgent(agent)).map((agent) => agent.id));
}

function capability(name: string) {
  const found = publicMcpCapabilities.find((c) => c.name === name);
  if (!found) throw new Error(`Missing public MCP capability ${name}`);
  return found;
}

const companyField = { companyId: z.uuid().optional().describe("Optional. Defaults to the Assistant's company; any other company is rejected.") };

function assistantCapabilities(db: Db): Capability[] {
  const reused = (name: string, override?: Partial<Capability>): Capability => ({ ...capability(name), ...override });
  const rejectAssistantAssignee = async (companyId: string, assigneeAgentId: unknown) => {
    if (typeof assigneeAgentId === "string" && (await assistantAgentIds(db, companyId)).has(assigneeAgentId)) {
      throw new McpCapabilityError("Tasks cannot be assigned to the Assistant. Choose a staff agent from paperclip_list_agents.");
    }
  };
  return [
    reused("paperclip_connection", {
      run: async (p) => ({
        user: { id: p.actor.userId }, companyId: p.company.id, company: p.company,
        permissions: p.grant.scopes, runId: p.actor.assistantRunId,
        execution: "The Assistant acts as this person with their company permissions. Tasks run through Paperclip scheduling, budgets and approvals.",
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
      "paperclip_read_document", "paperclip_list_document_revisions", "paperclip_pending_approvals", "paperclip_get_agent",
      "paperclip_get_project", "paperclip_list_skills", "paperclip_get_skill", "paperclip_add_comment"].map((name) => reused(name)),
    reused("paperclip_create_task", {
      run: async (p, a, api, origin) => {
        await rejectAssistantAssignee(p.company.id, a.assigneeAgentId);
        return capability("paperclip_create_task").run(p, a, api, origin);
      },
    }),
    reused("paperclip_update_task", {
      description: `Edit a task's ${ASSISTANT_UPDATE_TASK_FIELDS.join(", ")} as the connected person. Finishing, blocking or cancelling a task is not available here. Reuse requestId on retries.`,
      run: async (p, a, api, origin) => {
        const changes = object(a.changes);
        await rejectAssistantAssignee(p.company.id, changes.assigneeAgentId);
        return capability("paperclip_update_task").run(p, a, api, origin);
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
      name: "staples_answer_question", write: true,
      description: "Answer an open ask_user_questions interaction on this person's behalf. Only questions addressed to this person (or to no one in particular) can be answered. Answer only with choices the person actually made.",
      schema: z.object({ ...companyField, issueId: z.uuid(), interactionId: z.uuid(), answers: z.array(askUserQuestionsAnswerSchema).min(1).max(20) }).strict(),
      run: async (p, a, api) => {
        const [interaction] = await db.select({
          kind: issueThreadInteractions.kind, status: issueThreadInteractions.status,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId, addresseeUserId: issueThreadInteractions.addresseeUserId,
        }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, String(a.interactionId)), eq(issueThreadInteractions.issueId, String(a.issueId)),
          eq(issueThreadInteractions.companyId, p.company.id),
        ));
        if (!interaction || interaction.kind !== "ask_user_questions" || interaction.status !== "pending"
          || interaction.addresseeAgentId !== null
          || (interaction.addresseeUserId !== null && interaction.addresseeUserId !== p.actor.userId)) {
          throw new McpCapabilityError("No open question on that task is awaiting this person.");
        }
        // The respond route enforces issue access, conversation ownership and the resolver policy.
        const result = await api(p, "POST", `/issues/${pathId(a.issueId)}/interactions/${pathId(a.interactionId)}/respond`, { answers: a.answers });
        return { interaction: pick(result, ["id", "issueId", "kind", "status", "resolvedAt"]) };
      },
    },
    {
      name: "staples_pin_surface", write: true,
      description: "Pin a navigation surface for this person so it stays visible in their sidebar.",
      schema: z.object({ ...companyField, surfaceId: surfaceIdSchema }).strict(),
      run: async (p, a, api) => ({
        preferences: await api(p, "PATCH", `/companies/${pathId(p.company.id)}/ui-preferences/me`, { pin: [a.surfaceId] }),
      }),
    },
  ];
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
  const writeNames = new Set<string>(ASSISTANT_WRITE_TOOL_NAMES);
  const origin = (options.origin ?? "").replace(/\/+$/, "");

  return {
    isWriteTool: (name: string) => writeNames.has(name),
    isKnownTool: (name: string) => byName.has(name),
    /** Viewers see read tools only. */
    definitions(canWrite: boolean) {
      const names: readonly string[] = canWrite ? [...ASSISTANT_READ_TOOL_NAMES, ...ASSISTANT_WRITE_TOOL_NAMES] : ASSISTANT_READ_TOOL_NAMES;
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
        if (writeNames.has(name) && !context.canWrite) throw new McpCapabilityError("This person has read-only access.");
        const raw = { ...object(input) };
        if (raw.companyId !== undefined && raw.companyId !== context.companyId) throw new McpCapabilityError("Company does not match the Assistant's company.");
        if (name === "paperclip_update_task") {
          const changes = object(raw.changes);
          const disallowed = Object.keys(changes).filter((key) => !(ASSISTANT_UPDATE_TASK_FIELDS as readonly string[]).includes(key));
          if (disallowed.length) throw new McpCapabilityError(`These task fields cannot be changed by the Assistant: ${disallowed.join(", ")}.`);
          if (typeof changes.status === "string" && GOVERNED_STATUSES.has(changes.status)) {
            throw new McpCapabilityError(`The Assistant cannot set status to ${changes.status}. Ask the person to do it in Paperclip.`);
          }
        }
        const args = c.schema.parse({ ...raw, companyId: context.companyId });
        const result = await c.run(assistantPrincipal(context), args, options.dispatch, origin);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: safeMessage(error) }] };
      }
    },
  };
}
export type AssistantTools = ReturnType<typeof createAssistantTools>;

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, routines } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  isAssistantAgent,
  type AgentEligibilityAgent,
  type AgentOrgChainHealth,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { isAssistantWeeklyUpdateRoutine } from "./assistant-weekly-update-origin.js";

type AgentAssignmentKind = "work" | "routine";

type AssignabilityAgent = AgentEligibilityAgent;

type AgentAssignmentConflictReason =
  | "pending_approval"
  | "assignee_terminated"
  | "assignee_unknown_status"
  | "ancestor_terminated"
  | "ancestor_missing"
  | "ancestor_cross_company"
  | "ancestor_cycle"
  | "ancestor_depth_exceeded";

function assignmentMessage(kind: AgentAssignmentKind, reason: AgentAssignmentConflictReason) {
  if (reason === "pending_approval") {
    return kind === "routine"
      ? "Cannot assign routines to pending approval agents"
      : "Cannot assign work to pending approval agents";
  }
  if (reason === "assignee_terminated") {
    return kind === "routine"
      ? "Cannot assign routines to terminated agents"
      : "Cannot assign work to terminated agents";
  }
  if (reason === "assignee_unknown_status") {
    return kind === "routine"
      ? "Cannot assign routines to agents with an unsupported lifecycle status"
      : "Cannot assign work to agents with an unsupported lifecycle status";
  }
  return kind === "routine"
    ? "Cannot assign routines to agents with an invalid org chain"
    : "Cannot assign work to agents with an invalid org chain";
}

function conflictDetails(input: {
  companyId: string;
  assigneeAgentId: string;
  reason: AgentAssignmentConflictReason;
  chain: AssignabilityAgent[];
  invalidAncestorAgentId?: string | null;
  missingAncestorAgentId?: string | null;
}) {
  return {
    code: "agent_not_assignable",
    reason: input.reason,
    companyId: input.companyId,
    assigneeAgentId: input.assigneeAgentId,
    invalidAncestorAgentId: input.invalidAncestorAgentId ?? null,
    missingAncestorAgentId: input.missingAncestorAgentId ?? null,
    ancestorChain: input.chain.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      status: agent.status,
      reportsTo: agent.reportsTo,
    })),
  };
}

async function getAgent(db: Db, agentId: string): Promise<(AssignabilityAgent & { metadata: unknown }) | null> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

async function listCompanyAgents(db: Db, companyId: string): Promise<AssignabilityAgent[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

function assignmentReasonFromHealth(health: AgentOrgChainHealth): AgentAssignmentConflictReason {
  if (health.reason === "terminated_ancestor") return "ancestor_terminated";
  if (health.reason === "missing_manager") return "ancestor_missing";
  if (health.reason === "cycle") return "ancestor_cycle";
  return "ancestor_missing";
}

async function isOwnWeeklyUpdateRoutine(db: Db, companyId: string, routineId: string | null | undefined) {
  if (!routineId) return false;
  const [routine] = await db
    .select({ originKind: routines.originKind, originId: routines.originId })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)));
  return isAssistantWeeklyUpdateRoutine(routine);
}

export async function assertAssignableAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  options: {
    kind?: AgentAssignmentKind;
    /** The issue's conversation agent; the Assistant may only hold its own conversation issues. */
    conversationAgentId?: string | null;
    /**
     * The routine being assigned, or the routine an execution task was created
     * from. The Assistant may hold its own weekly update routine and that
     * routine's tasks; the routine's origin is checked here, never trusted.
     */
    routineId?: string | null;
  } = {},
) {
  if (!agentId) return;
  const kind = options.kind ?? "work";
  const assignee = await getAgent(db, agentId);
  if (!assignee) throw notFound("Assignee agent not found");
  if (assignee.companyId !== companyId) {
    throw unprocessable("Assignee must belong to same company");
  }
  if (isAssistantAgent(assignee)) {
    const ownConversation = kind === "work" && options.conversationAgentId === agentId;
    if (!ownConversation && !(await isOwnWeeklyUpdateRoutine(db, companyId, options.routineId))) {
      throw badRequest("The Assistant can't be assigned tasks", { code: "assistant_not_assignable", assigneeAgentId: agentId });
    }
  }

  const companyAgents = await listCompanyAgents(db, companyId);
  const eligibility = getAgentWorkEligibility({ agent: assignee, agents: companyAgents });
  const chain = eligibility.orgChainHealth.fullChain.map((entry) => ({
    id: entry.id,
    companyId: entry.companyId,
    name: entry.name,
    status: entry.status,
    reportsTo: entry.reportsTo,
  }));

  if (eligibility.assignable) return;

  if (eligibility.assignabilityReason === "pending_approval") {
    throw conflict(assignmentMessage(kind, "pending_approval"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "pending_approval",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "terminated") {
    throw conflict(assignmentMessage(kind, "assignee_terminated"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_terminated",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "unknown_status") {
    throw conflict(assignmentMessage(kind, "assignee_unknown_status"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_unknown_status",
      chain,
    }));
  }

  const reason = assignmentReasonFromHealth(eligibility.orgChainHealth);
  const firstInvalidAncestor = eligibility.orgChainHealth.firstInvalidAncestor;
  throw conflict(assignmentMessage(kind, reason), conflictDetails({
    companyId,
    assigneeAgentId: agentId,
    reason,
    chain,
    invalidAncestorAgentId:
      firstInvalidAncestor && firstInvalidAncestor.status !== "missing"
        ? firstInvalidAncestor.id
        : null,
    missingAncestorAgentId:
      firstInvalidAncestor?.status === "missing"
        ? firstInvalidAncestor.id
        : null,
  }));
}

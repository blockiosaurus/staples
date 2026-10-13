import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { agents, issues, routines, type Db } from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY, ASSISTANT_WEEKLY_UPDATE_ROUTINE_KEY, isAssistantAgent } from "@paperclipai/shared";

/** A bundle trigger time zone resolved per company: the person's zone when known, otherwise UTC. */
export const PERSON_TIMEZONE = "person";

/** `routines.originKind`/`originId` of the Assistant bundle's weekly update routine. Imports no services, so any service can use it. */
export const ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND = "built_in_agent_bundle";
export const ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID = `${ASSISTANT_BUILT_IN_AGENT_KEY}:${ASSISTANT_WEEKLY_UPDATE_ROUTINE_KEY}`;

export function isAssistantWeeklyUpdateRoutine(routine: { originKind?: string | null; originId?: string | null } | null | undefined) {
  return routine?.originKind === ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND
    && routine.originId === ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID;
}

/** True when the company has an agent other than the Assistant that is not terminated. */
export async function companyHasStaffAgents(db: Pick<Db, "select">, companyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
  return rows.some((row) => !isAssistantAgent(row));
}

/** SQL: the task is not one of the weekly update routine's own tasks (Home shows the update card instead). */
export function notWeeklyUpdateTaskCondition(): SQL<boolean> {
  return sql<boolean>`not coalesce(${issues.originKind} = 'routine_execution' and ${issues.originId} in (
    select ${routines.id}::text from ${routines}
    where ${routines.companyId} = ${issues.companyId}
      and ${routines.originKind} = ${ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND}
      and ${routines.originId} = ${ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID}
  ), false)`;
}

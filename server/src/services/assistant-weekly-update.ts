import { and, desc, eq, inArray, isNull, like, ne, sql, type SQL } from "drizzle-orm";
import {
  documents,
  inboxDismissals,
  issueDocuments,
  issues,
  routineTriggers,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND,
  BRIEFING_WEEKLY_UPDATE_EXCERPT_MAX,
  WEEKLY_UPDATE_CARD_MAX_AGE_DAYS,
  WEEKLY_UPDATE_DOCUMENT_KEY_PREFIX,
  weeklyUpdateDismissalKey,
  type BriefingWeeklyUpdate,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { documentService } from "./documents.js";
import { issueService } from "./issues.js";
import { AGENT_TEMPLATE_ROUTINE_ORIGIN, normalizePersonTimezone } from "./plan-templates.js";
import { logger } from "../middleware/logger.js";
import {
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID,
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND,
  PERSON_TIMEZONE,
  companyHasStaffAgents,
  isAssistantWeeklyUpdateRoutine,
} from "./assistant-weekly-update-origin.js";

export {
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID,
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND,
  PERSON_TIMEZONE,
  companyHasStaffAgents,
  isAssistantWeeklyUpdateRoutine,
};

/**
 * The Assistant's weekly update. A bundle routine wakes the Assistant on
 * Mondays; it reads the company with its read-only tools and saves one
 * document on the company's single "Weekly updates" task. That task is created
 * and owned by the server, and the save is the Assistant's only write outside
 * a person's confirmation: it can target nothing else (see
 * `staples_save_weekly_update` in assistant-tools.ts).
 */

export const WEEKLY_UPDATES_ISSUE_TITLE = "Weekly updates";
export const WEEKLY_UPDATES_ISSUE_DESCRIPTION =
  "The Assistant saves a short update here every week: what shipped, what's blocked, spend against budget, and next week.";
export const WEEKLY_UPDATE_BODY_MAX_CHARS = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date `now` falls on in `timeZone`: a document key suffix and a display label. */
export function weeklyUpdateDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const iso = `${part("year")}-${part("month")}-${part("day")}`;
  const label = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }).format(now);
  return { iso, label };
}

export function weeklyUpdateTitle(label: string) {
  return `Weekly update — ${label}`;
}

/**
 * The person's time zone for the company, as the template routines recorded
 * it (a template's "person" zone is the browser zone of whoever applied the
 * plan). Null when no template routine carries a zone other than UTC.
 */
export async function companyPersonTimezone(db: Pick<Db, "select">, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ timezone: routineTriggers.timezone })
    .from(routineTriggers)
    .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
    .where(and(
      eq(routines.companyId, companyId),
      eq(routines.originKind, AGENT_TEMPLATE_ROUTINE_ORIGIN),
      eq(routineTriggers.kind, "schedule"),
      ne(routineTriggers.timezone, "UTC"),
    ))
    .orderBy(desc(routineTriggers.createdAt))
    .limit(1);
  return normalizePersonTimezone(rows[0]?.timezone ?? null);
}

async function weeklyUpdateRoutine(db: Pick<Db, "select">, companyId: string) {
  const [routine] = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(
      eq(routines.companyId, companyId),
      eq(routines.originKind, ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_KIND),
      eq(routines.originId, ASSISTANT_WEEKLY_UPDATE_ROUTINE_ORIGIN_ID),
    ));
  if (!routine) return null;
  const [trigger] = await db
    .select({ id: routineTriggers.id, timezone: routineTriggers.timezone })
    .from(routineTriggers)
    .where(and(eq(routineTriggers.routineId, routine.id), eq(routineTriggers.kind, "schedule")))
    .orderBy(routineTriggers.createdAt)
    .limit(1);
  return { id: routine.id, trigger: trigger ?? null };
}

/**
 * The zone the weekly update is dated and scheduled in: the routine's own
 * schedule zone, else the person's zone, else UTC (`known: false`).
 */
export async function weeklyUpdateTimezone(db: Pick<Db, "select">, companyId: string): Promise<{ timezone: string; known: boolean }> {
  const routine = await weeklyUpdateRoutine(db, companyId);
  const routineZone = routine?.trigger?.timezone && routine.trigger.timezone !== "UTC"
    ? normalizePersonTimezone(routine.trigger.timezone)
    : null;
  if (routineZone) return { timezone: routineZone, known: true };
  const personZone = await companyPersonTimezone(db, companyId);
  return personZone ? { timezone: personZone, known: true } : { timezone: "UTC", known: false };
}

/**
 * Move the weekly update schedule onto the person's zone once one is known
 * (for example when a plan is applied from their browser). Only a schedule
 * still on the UTC default is moved; a zone someone chose is kept. Best effort.
 */
export async function syncWeeklyUpdateTimezone(db: Db, companyId: string, personTimezone: string | null | undefined) {
  const timezone = normalizePersonTimezone(personTimezone);
  if (!timezone || timezone === "UTC") return false;
  try {
    const routine = await weeklyUpdateRoutine(db, companyId);
    if (!routine?.trigger || routine.trigger.timezone !== "UTC") return false;
    const { routineService } = await import("./routines.js");
    await routineService(db).updateTrigger(routine.trigger.id, { timezone }, { agentId: null, userId: null, runId: null });
    await logActivity(db, {
      companyId, actorType: "system", actorId: "assistant-weekly-update",
      action: "routine.trigger_updated", entityType: "routine", entityId: routine.id,
      details: { triggerId: routine.trigger.id, timezone, source: "assistant_weekly_update_person_timezone" },
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, companyId }, "could not move the weekly update schedule to the person's time zone");
    return false;
  }
}

async function findWeeklyUpdatesIssue(db: Pick<Db, "select">, companyId: string, readCondition?: SQL<boolean>) {
  const [row] = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND),
      eq(issues.originId, companyId),
      // A cancelled or hidden task is retired: the next save starts a fresh one.
      ne(issues.status, "cancelled"),
      isNull(issues.hiddenAt),
      readCondition,
    ))
    .orderBy(issues.createdAt)
    .limit(1);
  return row ?? null;
}

/** The company's single "Weekly updates" task, created (unassigned, in the backlog) when missing. */
export async function ensureWeeklyUpdatesIssue(db: Db, companyId: string) {
  const existing = await findWeeklyUpdatesIssue(db, companyId);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    // One creator per company at a time, so concurrent saves never make two.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant-weekly-updates:${companyId}`}))`);
    const raced = await findWeeklyUpdatesIssue(tx as unknown as Db, companyId);
    if (raced) return raced;
    const created = await issueService(db).create(companyId, {
      title: WEEKLY_UPDATES_ISSUE_TITLE,
      description: WEEKLY_UPDATES_ISSUE_DESCRIPTION,
      status: "backlog",
      priority: "low",
      originKind: ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND,
      originId: companyId,
    }, tx as unknown as Db);
    await logActivity(tx as unknown as Db, {
      companyId, actorType: "system", actorId: "assistant-weekly-update",
      action: "issue.created", entityType: "issue", entityId: created.id,
      details: { title: created.title, identifier: created.identifier ?? null, source: "assistant_weekly_update" },
    });
    return { id: created.id, identifier: created.identifier ?? null };
  });
}

export interface SaveWeeklyUpdateInput {
  companyId: string;
  agentId: string;
  runId: string;
  body: string;
  /** The routine's execution task for this run, closed once the update is saved. */
  executionIssueId?: string | null;
  now?: Date;
}

/**
 * Save this week's update as the document "Weekly update — <date>" on the
 * company's "Weekly updates" task. The target is always resolved here, never
 * taken from the caller. Saving again on the same date replaces that day's
 * update with a new revision.
 */
export async function saveWeeklyUpdate(db: Db, input: SaveWeeklyUpdateInput) {
  const body = input.body.trim();
  if (!body) throw new Error("The weekly update is empty.");
  if (body.length > WEEKLY_UPDATE_BODY_MAX_CHARS) {
    throw new Error(`The weekly update is longer than ${WEEKLY_UPDATE_BODY_MAX_CHARS} characters.`);
  }
  const now = input.now ?? new Date();
  const zone = await weeklyUpdateTimezone(db, input.companyId);
  const date = weeklyUpdateDate(now, zone.timezone);
  const key = `${WEEKLY_UPDATE_DOCUMENT_KEY_PREFIX}${date.iso}`;
  const title = weeklyUpdateTitle(date.label);
  const issue = await ensureWeeklyUpdatesIssue(db, input.companyId);
  const [existing] = await db
    .select({ latestRevisionId: documents.latestRevisionId })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, key)));
  const result = await documentService(db).upsertIssueDocument({
    issueId: issue.id,
    key,
    title,
    format: "markdown",
    body,
    changeSummary: existing ? "Weekly update revised" : "Weekly update",
    baseRevisionId: existing?.latestRevisionId ?? null,
    createdByAgentId: input.agentId,
    createdByRunId: input.runId,
  });
  await logActivity(db, {
    companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId, runId: input.runId,
    action: result.created ? "issue.document_created" : "issue.document_updated",
    entityType: "issue", entityId: issue.id,
    details: {
      key, documentId: result.document.id, title, revisionNumber: result.document.latestRevisionNumber,
      source: "assistant_weekly_update", timezone: zone.timezone, timezoneKnown: zone.known,
    },
  });
  if (input.executionIssueId) await closeExecutionIssue(db, input);
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    documentId: result.document.id,
    key,
    title,
    href: `/issues/${issue.identifier ?? issue.id}#document-${key}`,
    timezone: zone.timezone,
    timezoneKnown: zone.known,
  };
}

/** The routine task this run was woken on is finished once its update is saved. */
async function closeExecutionIssue(db: Db, input: SaveWeeklyUpdateInput) {
  try {
    const [row] = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, input.executionIssueId!), eq(issues.companyId, input.companyId)));
    if (!row || row.status === "done" || row.status === "cancelled") return;
    await issueService(db).update(row.id, { status: "done", actorAgentId: input.agentId, actorRunId: input.runId });
    await logActivity(db, {
      companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId, runId: input.runId,
      action: "issue.updated", entityType: "issue", entityId: row.id,
      details: { status: "done", _previous: { status: row.status }, source: "assistant_weekly_update" },
    });
    const { routineService } = await import("./routines.js");
    await routineService(db).syncRunStatusForIssue(row.id);
  } catch (error) {
    logger.warn({ err: error, issueId: input.executionIssueId }, "could not close the weekly update routine task");
  }
}

export const NO_UPDATE_THIS_WEEK_NOTE = "No update this week.";

/**
 * Close an open weekly update routine task without an update: its run ended
 * without saving, or a newer Monday found it still open. Cancelled with a
 * plain note, as the system, so the routine is never stuck behind it and
 * nothing re-wakes the Assistant on it. Returns whether it closed the task.
 * Never throws.
 */
export async function closeWeeklyUpdateTaskWithoutUpdate(
  db: Db,
  issueId: string,
  reason: "run_finished_without_update" | "superseded_by_next_week",
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: issues.id, companyId: issues.companyId, status: issues.status, originKind: issues.originKind, originId: issues.originId })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!row || row.originKind !== "routine_execution" || !row.originId) return false;
    if (row.status === "done" || row.status === "cancelled") return false;
    const [routine] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(and(eq(routines.id, row.originId), eq(routines.companyId, row.companyId)));
    if (!isAssistantWeeklyUpdateRoutine(routine)) return false;
    const svc = issueService(db);
    await svc.update(row.id, { status: "cancelled" });
    await svc.addComment(row.id, NO_UPDATE_THIS_WEEK_NOTE, {}, { authorType: "system" });
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "assistant-weekly-update",
      action: "issue.updated", entityType: "issue", entityId: row.id,
      details: { status: "cancelled", _previous: { status: row.status }, reason, source: "assistant_weekly_update" },
    });
    const { routineService } = await import("./routines.js");
    await routineService(db).syncRunStatusForIssue(row.id);
    return true;
  } catch (error) {
    logger.warn({ err: error, issueId }, "could not close the weekly update routine task");
    return false;
  }
}

/** After an Assistant run ends: a weekly update task it left open (no save) is closed. */
export async function closeWeeklyUpdateTaskAfterRun(
  db: Db,
  run: { nativeIssueId?: string | null; contextSnapshot?: Record<string, unknown> | null },
) {
  const snapshotIssueId = run.contextSnapshot?.issueId;
  const issueId = run.nativeIssueId ?? (typeof snapshotIssueId === "string" ? snapshotIssueId : null);
  if (!issueId) return false;
  return closeWeeklyUpdateTaskWithoutUpdate(db, issueId, "run_finished_without_update");
}

/** Markdown to a short plain-text preview: the first few lines, minus a heading that repeats the title. */
export function weeklyUpdateExcerpt(body: string, title: string | null, max = BRIEFING_WEEKLY_UPDATE_EXCERPT_MAX): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .trim())
    .filter(Boolean);
  if (lines.length && title && lines[0]!.toLowerCase() === title.toLowerCase()) lines.shift();
  const text = lines.slice(0, 4).join(" ");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The latest weekly update for Home: saved in the last
 * WEEKLY_UPDATE_CARD_MAX_AGE_DAYS days and not dismissed by this person.
 */
export async function latestWeeklyUpdate(
  db: Pick<Db, "select">,
  input: {
    companyId: string; userId: string; now: number;
    /** The caller's task read predicate (issueReadSqlCondition): no card for a task they cannot read. */
    readCondition?: SQL<boolean>;
  },
): Promise<BriefingWeeklyUpdate | null> {
  const issue = await findWeeklyUpdatesIssue(db, input.companyId, input.readCondition);
  if (!issue) return null;
  const [doc] = await db
    .select({
      id: documents.id,
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.issueId, issue.id),
      eq(issueDocuments.companyId, input.companyId),
      like(issueDocuments.key, `${WEEKLY_UPDATE_DOCUMENT_KEY_PREFIX}%`),
    ))
    .orderBy(desc(documents.updatedAt))
    .limit(1);
  if (!doc) return null;
  if (input.now - new Date(doc.updatedAt).getTime() > WEEKLY_UPDATE_CARD_MAX_AGE_DAYS * DAY_MS) return null;
  const [dismissed] = await db
    .select({ id: inboxDismissals.id })
    .from(inboxDismissals)
    .where(and(
      eq(inboxDismissals.companyId, input.companyId),
      eq(inboxDismissals.userId, input.userId),
      inArray(inboxDismissals.itemKey, [weeklyUpdateDismissalKey(doc.id)]),
    ));
  if (dismissed) return null;
  const title = doc.title?.trim() || "Weekly update";
  return {
    documentId: doc.id,
    title,
    excerpt: weeklyUpdateExcerpt(doc.body ?? "", title),
    href: `/issues/${issue.identifier ?? issue.id}#document-${doc.key}`,
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

import type { Db } from "@paperclipai/db";
import { agents as agentsTable, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export const LIVE_RUN_STATUSES = ["queued", "running"] as const;

/**
 * The row shape served by `GET /companies/:companyId/live-runs`. Built fresh
 * per call so each query owns its aliased SQL fragments.
 */
export function liveRunColumns() {
  return {
    id: heartbeatRuns.id,
    runtimeMode: heartbeatRuns.runtimeMode,
    companyId: heartbeatRuns.companyId,
    status: heartbeatRuns.status,
    invocationSource: heartbeatRuns.invocationSource,
    triggerDetail: heartbeatRuns.triggerDetail,
    contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
    contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
    startedAt: heartbeatRuns.startedAt,
    finishedAt: heartbeatRuns.finishedAt,
    createdAt: heartbeatRuns.createdAt,
    agentId: heartbeatRuns.agentId,
    agentName: agentsTable.name,
    agentAppearance: agentsTable.appearance,
    adapterType: agentsTable.adapterType,
    logBytes: heartbeatRuns.logBytes,
    livenessState: heartbeatRuns.livenessState,
    livenessReason: heartbeatRuns.livenessReason,
    continuationAttempt: heartbeatRuns.continuationAttempt,
    lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
    nextAction: heartbeatRuns.nextAction,
    lastOutputAt: heartbeatRuns.lastOutputAt,
    lastOutputSeq: heartbeatRuns.lastOutputSeq,
    lastOutputStream: heartbeatRuns.lastOutputStream,
    lastOutputBytes: heartbeatRuns.lastOutputBytes,
    processStartedAt: heartbeatRuns.processStartedAt,
    scopeKind: heartbeatRuns.scopeKind,
    issueId: heartbeatRuns.issueId,
    inputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'inputTokens')::numeric`.as("inputTokens"),
    cachedInputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'cachedInputTokens')::numeric`.as("cachedInputTokens"),
    outputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'outputTokens')::numeric`.as("outputTokens"),
    totalTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'totalTokens')::numeric`.as("totalTokens"),
    costUsd: sql<number | null>`coalesce(
        (${heartbeatRuns.resultJson} ->> 'costUsd')::numeric,
        (${heartbeatRuns.resultJson} ->> 'cost_usd')::numeric,
        (${heartbeatRuns.resultJson} ->> 'total_cost_usd')::numeric
      )`.as("costUsd"),
  };
}

export type LiveRunColumns = ReturnType<typeof liveRunColumns>;

/** Queued and running runs for one company, newest first (unlimited until `.limit()`). */
export function liveRunsQuery(db: Db, companyId: string, columns: LiveRunColumns = liveRunColumns()) {
  return db
    .select(columns)
    .from(heartbeatRuns)
    .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt));
}

/** Live (queued/running) runs for a company, newest first. */
export async function listLiveRuns(db: Db, companyId: string, options: { limit?: number } = {}) {
  const query = liveRunsQuery(db, companyId);
  return options.limit === undefined ? await query : await query.limit(options.limit);
}

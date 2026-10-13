import type { AssistantPageContext } from "@paperclipai/shared";
import type { SetIssueTitle } from "@paperclipai/shared";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import type {
  AcceptedPlanDecompositionSummary,
  AskUserQuestionsAnswer,
  Approval,
  CompactIssue,
  CreateIssueTreeHold,
  DocumentRevision,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  Issue,
  IssueAccessGrant,
  IssueAccessGrantSubjectType,
  IssueVisibility,
  IssuePrivacyConstraints,
  IssueChanges,
  IssueAttachment,
  IssueCostSummary,
  IssueComment,
  IssueQueuedCommentQueue,
  IssueDocument,
  IssueLabel,
  IssueRecoveryAction,
  IssueRetryNowResponse,
  StalledReviewDecision,
  StalledReviewDecisionResponse,
  IssueThreadInteraction,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWatchdog,
  IssueWorkProduct,
  RunnerGoalActionAccepted,
  RunnerGoalActionRequest,
  RunnerGoalProjection,
  PreviewIssueTreeControl,
  ReleaseIssueTreeHold,
  ReleaseIssueTreeHoldResponse,
  UpsertIssueWatchdog,
  UpsertIssueDocument,
} from "@paperclipai/shared";
import { api, ApiError, detachInflightGet, requestResponse, type RequestOptions } from "./client";
import type { RequestConfirmationProposedActionPayload } from "@paperclipai/shared";

/** The outcome the person's browser reports when accepting a proposed action. */
export interface ProposedActionAcceptResult {
  status: "executed" | "failed" | "stale";
  httpStatus?: number;
  message?: string;
  /** Echo of the stored proposal hash. */
  hash: string;
}

/** Stored proposal paths include the `/api` prefix; the api client adds it again. */
function proposedActionClientPath(path: string) {
  if (!path.startsWith("/api/")) throw new Error("Proposed action paths must start with /api/");
  return path.slice("/api".length);
}

/** One line, capped: the message is relayed into the Assistant's wake prompt. */
function shortMessage(value: string) {
  const trimmed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

/**
 * Perform an Assistant-proposed call exactly as stored (method, path, body)
 * with the person's own session, through the app's api client. Never throws:
 * failures are reported as a `failed` result for the accept call.
 */
/** "$110" from cents; cents kept only when there are some. */
function wholeDollars(cents: number) {
  const value = cents / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** What a plan apply did to the company's hosted limit, if anything. */
function hostedLimitSentence(limit: { fromCents?: unknown; toCents?: unknown; neededCents?: unknown; limited?: unknown } | undefined): string {
  if (!limit || typeof limit.fromCents !== "number" || typeof limit.toCents !== "number") return "";
  const raised = limit.toCents > limit.fromCents
    ? ` Hosted limit raised from ${wholeDollars(limit.fromCents)} to ${wholeDollars(limit.toCents)}.`
    : "";
  if (limit.limited !== true || typeof limit.neededCents !== "number") return raised;
  return `${raised} The agents' monthly budgets come to ${wholeDollars(limit.neededCents)}, more than the hosted limit allows, so some may stop before their budgets run out.`;
}

/** One line for the Assistant about what a plan apply created. */
function planApplySummary(status: number, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as {
    agents?: Record<string, unknown>; tasks?: Record<string, unknown>; pendingAssignments?: unknown[]; routines?: unknown[];
    hostedLimit?: { fromCents?: unknown; toCents?: unknown; neededCents?: unknown; limited?: unknown };
  };
  const count = (value: unknown) => (value && typeof value === "object" ? Object.keys(value).length : 0);
  const agents = count(record.agents);
  const tasks = count(record.tasks);
  const routines = Array.isArray(record.routines) ? record.routines.length : 0;
  const pending = Array.isArray(record.pendingAssignments) ? record.pendingAssignments.length : 0;
  const parts = [`${agents} agent${agents === 1 ? "" : "s"}`, `${tasks} task${tasks === 1 ? "" : "s"}`];
  if (routines) parts.push(`${routines} routine${routines === 1 ? "" : "s"}`);
  const waiting = pending ? ` ${pending} task${pending === 1 ? " waits" : "s wait"} for hire approval.` : "";
  return `${status === 200 ? "Plan was already created" : "Plan created"}: ${parts.join(", ")}.${waiting}${hostedLimitSentence(record.hostedLimit)}`;
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export async function executeProposedAction(
  action: Pick<RequestConfirmationProposedActionPayload, "method" | "path" | "body"> & { category?: string },
  options: { idempotencyKey?: string } = {},
): Promise<Omit<ProposedActionAcceptResult, "hash">> {
  try {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    // Plans may install agent templates whose routines run on the person's time zone.
    if (action.category === "plan") {
      const timeZone = browserTimeZone();
      if (timeZone) headers["X-Staples-Timezone"] = timeZone;
    }
    const response = await requestResponse(proposedActionClientPath(action.path), {
      method: action.method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(action.body === null || action.body === undefined ? {} : { body: JSON.stringify(action.body) }),
    });
    let message = `HTTP ${response.status}`;
    if (response.ok && action.category === "plan") {
      const summary = planApplySummary(response.status, await response.clone().json().catch(() => null));
      if (summary) message = shortMessage(summary);
    }
    return { status: response.ok ? "executed" : "failed", httpStatus: response.status, message };
  } catch (error) {
    if (error instanceof ApiError) return { status: "failed", httpStatus: error.status, message: shortMessage(error.message) };
    return { status: "failed", message: shortMessage(error instanceof Error ? error.message : "The request could not be sent") };
  }
}

/** Read the stale-check field fresh (never from cache). Returns null when it cannot be read. */
export async function readProposedActionStaleValue(
  staleCheck: NonNullable<RequestConfirmationProposedActionPayload["staleCheck"]>,
): Promise<string | null> {
  try {
    const value = await api.get<Record<string, unknown>>(proposedActionClientPath(staleCheck.path), { cache: "no-store" });
    const field = value?.[staleCheck.field];
    return typeof field === "string" ? field : null;
  } catch {
    return null;
  }
}
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";

function hasCommentReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  return (
    typeof row.id === "string" &&
    uuid.test(row.id) &&
    typeof row.issueId === "string" &&
    uuid.test(row.issueId) &&
    typeof row.body === "string"
  );
}

async function confirmedCommentResponse<T>(
  request: Promise<T>,
  valid: (response: T) => boolean,
): Promise<T> {
  try {
    const response = await request;
    if (!valid(response)) throw new CommentSubmissionUnknownError();
    return response;
  } catch (error) {
    // A rejected request is distinct from a lost/invalid receipt. A server 5xx
    // may also happen after commit; it cannot establish that nothing was saved.
    if (error instanceof ApiError && error.status < 500) throw error;
    throw new CommentSubmissionUnknownError();
  }
}

export type IssueUpdateResponse = Issue & {
  comment?: IssueComment | null;
  changes: IssueChanges;
  blockedByIssueIds?: string[];
};

export type ResolveRecoveryActionResponse = {
  issue: Issue;
  recoveryAction: IssueRecoveryAction;
};

export type IssueListFilters = {
  attention?: "blocked";
  status?: string;
  projectId?: string;
  parentId?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  labelId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  descendantOf?: string;
  createdFromIssueId?: string;
  includeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated" | "id";
  afterId?: string;
  sortDir?: "asc" | "desc";
};

function issueListSearchParams(filters?: IssueListFilters) {
  const params = new URLSearchParams();
  if (filters?.attention) params.set("attention", filters.attention);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentId) params.set("parentId", filters.parentId);
  if (filters?.assigneeAgentId)
    params.set("assigneeAgentId", filters.assigneeAgentId);
  if (filters?.participantAgentId)
    params.set("participantAgentId", filters.participantAgentId);
  if (filters?.assigneeUserId)
    params.set("assigneeUserId", filters.assigneeUserId);
  if (filters?.touchedByUserId)
    params.set("touchedByUserId", filters.touchedByUserId);
  if (filters?.inboxArchivedByUserId)
    params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
  if (filters?.unreadForUserId)
    params.set("unreadForUserId", filters.unreadForUserId);
  if (filters?.labelId) params.set("labelId", filters.labelId);
  if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
  if (filters?.executionWorkspaceId)
    params.set("executionWorkspaceId", filters.executionWorkspaceId);
  if (filters?.originKind) params.set("originKind", filters.originKind);
  if (filters?.originKindPrefix)
    params.set("originKindPrefix", filters.originKindPrefix);
  if (filters?.originId) params.set("originId", filters.originId);
  if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
  if (filters?.createdFromIssueId) params.set("createdFromIssueId", filters.createdFromIssueId);
  if (filters?.includeRoutineExecutions)
    params.set("includeRoutineExecutions", "true");
  if (filters?.includeBlockedBy) params.set("includeBlockedBy", "true");
  if (filters?.includeBlockedInboxAttention)
    params.set("includeBlockedInboxAttention", "true");
  if (filters?.includeLiveDescendantSummary)
    params.set("includeLiveDescendantSummary", "true");
  if (filters?.hasPlanDocument !== undefined) {
    params.set("hasPlanDocument", filters.hasPlanDocument ? "true" : "false");
  }
  if (filters?.q) params.set("q", filters.q);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined)
    params.set("offset", String(filters.offset));
  if (filters?.sortField) params.set("sortField", filters.sortField);
  if (filters?.sortDir) params.set("sortDir", filters.sortDir);
  if (filters?.afterId) params.set("afterId", filters.afterId);
  return params;
}

export const issuesApi = {
  /** Fetch every page for bounded task-detail relations, not just the default first page. */
  listAll: async (companyId: string, filters: Omit<IssueListFilters, "limit" | "offset" | "sortField" | "sortDir" | "afterId" | "attention">, options?: RequestOptions): Promise<Issue[]> => {
    const pageSize = 500;
    const tasks = new Map<string, Issue>();
    let afterId: string | undefined;
    for (;;) {
      const page = await issuesApi.list(companyId, { ...filters, limit: pageSize, sortField: "id", sortDir: "asc", afterId }, options);
      for (const task of page) tasks.set(task.id, task);
      if (page.length < pageSize) return [...tasks.values()];
      afterId = page[page.length - 1]!.id;
    }
  },
  list: (
    companyId: string,
    filters?: IssueListFilters,
    options?: RequestOptions,
  ) => {
    const params = issueListSearchParams(filters);
    const qs = params.toString();
    const path = `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`;
    return options ? api.get<Issue[]>(path, options) : api.get<Issue[]>(path);
  },
  listCompact: (
    companyId: string,
    filters?: IssueListFilters,
    options?: RequestOptions,
  ) => {
    const params = issueListSearchParams(filters);
    params.set("view", "compact");
    const path = `/companies/${companyId}/issues?${params.toString()}`;
    return options
      ? api.get<CompactIssue[]>(path, options)
      : api.get<CompactIssue[]>(path);
  },
  count: (
    companyId: string,
    filters: {
      attention: "blocked";
      status?: string;
      assigneeAgentId?: string;
      assigneeUserId?: string;
      projectId?: string;
      labelId?: string;
      q?: string;
    },
  ) => {
    const params = new URLSearchParams();
    params.set("attention", filters.attention);
    if (filters.status) params.set("status", filters.status);
    if (filters.assigneeAgentId)
      params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters.assigneeUserId)
      params.set("assigneeUserId", filters.assigneeUserId);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (filters.labelId) params.set("labelId", filters.labelId);
    if (filters.q) params.set("q", filters.q);
    return api.get<{ count: number }>(
      `/companies/${companyId}/issues/count?${params.toString()}`,
    );
  },
  listLabels: (companyId: string) =>
    api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string, options?: RequestOptions) =>
    options
      ? api.get<Issue>(`/issues/${id}`, options)
      : api.get<Issue>(`/issues/${id}`),
  getRunnerGoal: (id: string, agentId?: string | null) => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    return api.get<RunnerGoalProjection>(`/issues/${id}/runner-goal${query}`);
  },
  actOnRunnerGoal: (id: string, request: RunnerGoalActionRequest) =>
    api.post<RunnerGoalActionAccepted>(
      `/issues/${id}/runner-goal/actions`,
      request,
    ),
  getWatchdog: (id: string) =>
    api.get<IssueWatchdog | null>(`/issues/${id}/watchdog`),
  upsertWatchdog: (id: string, data: UpsertIssueWatchdog) =>
    api.put<IssueWatchdog>(`/issues/${id}/watchdog`, data),
  deleteWatchdog: (id: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/watchdog`),
  markRead: (id: string) =>
    api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  markUnread: (id: string) =>
    api.delete<{ id: string; removed: boolean }>(`/issues/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(
      `/issues/${id}/inbox-archive`,
      {},
    ),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(
      `/issues/${id}/inbox-archive`,
    ),
  setTitle: (id: string, data: SetIssueTitle) =>
    api.put<{ id: string; title: string; titleNeedsGeneration: boolean; changed: boolean }>(`/issues/${id}/title`, data),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  update: (id: string, data: Record<string, unknown>) => {
    const response = api.patch<IssueUpdateResponse>(`/issues/${id}`, data);
    return typeof data.comment === "string"
      ? confirmedCommentResponse(response, (value) =>
          hasCommentReceipt(value?.comment),
        )
      : response;
  },
  decideStalledReview: (id: string, data: StalledReviewDecision) =>
    api.post<StalledReviewDecisionResponse>(
      `/issues/${id}/stalled-review-decision`,
      data,
    ),
  retryWorkspaceExport: (id: string, data: { actionId: string; runId: string; repairNote: string }) =>
    api.post<{ runId: string; resultId: string; leaseId: string; status: "queued" }>(`/issues/${id}/recovery-actions/retry-workspace-export`, data),
  resolveRecoveryAction: (
    id: string,
    data: {
      executionReconciliation?: ExecutionReconciliation;
      workspaceBaseRef?: { requestedRef: string; branch: string };
      actionId?: string;
      outcome: "restored" | "false_positive" | "blocked" | "cancelled";
      sourceIssueStatus: "todo" | "done" | "in_review" | "blocked";
      resolutionNote?: string | null;
    },
  ) =>
    api.post<ResolveRecoveryActionResponse>(
      `/issues/${id}/recovery-actions/resolve`,
      data,
    ),
  previewTreeControl: (id: string, data: PreviewIssueTreeControl) =>
    api.post<IssueTreeControlPreview>(
      `/issues/${id}/tree-control/preview`,
      data,
    ),
  createTreeHold: (id: string, data: CreateIssueTreeHold) =>
    api.post<{ hold: IssueTreeHold; preview: IssueTreeControlPreview }>(
      `/issues/${id}/tree-holds`,
      data,
    ),
  getTreeHold: (id: string, holdId: string) =>
    api.get<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}`),
  listTreeHolds: (
    id: string,
    filters?: {
      status?: "active" | "released";
      mode?: "pause" | "resume" | "cancel" | "restore";
      includeMembers?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.mode) params.set("mode", filters.mode);
    if (filters?.includeMembers) params.set("includeMembers", "true");
    const qs = params.toString();
    return api.get<IssueTreeHold[]>(
      `/issues/${id}/tree-holds${qs ? `?${qs}` : ""}`,
    );
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootIssueId: string;
        issueId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: {
          strategy: "manual" | "after_active_runs_finish";
          note?: string | null;
        } | null;
      } | null;
    }>(`/issues/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseIssueTreeHold) =>
    api.post<ReleaseIssueTreeHoldResponse>(
      `/issues/${id}/tree-holds/${holdId}/release`,
      data,
    ),
  checkMonitorNow: (id: string) =>
    api.post<{ ok: true }>(`/issues/${id}/monitor/check-now`, {}),
  retryScheduledRetryNow: (id: string) =>
    api.post<IssueRetryNowResponse>(
      `/issues/${id}/scheduled-retry/retry-now`,
      {},
    ),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (
    id: string,
    filters?: {
      after?: string;
      order?: "asc" | "desc";
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.after) params.set("after", filters.after);
    if (filters?.order) params.set("order", filters.order);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<IssueComment[]>(
      `/issues/${id}/comments${qs ? `?${qs}` : ""}`,
    );
  },
  getQueuedComments: (id: string) =>
    api.get<IssueQueuedCommentQueue>(`/issues/${id}/queued-comments`),
  editQueuedComment: (
    id: string,
    commentId: string,
    data: { body: string; queueId: string; revision: string },
  ) =>
    api.patch<IssueQueuedCommentQueue>(
      `/issues/${id}/queued-comments/${commentId}`,
      data,
    ),
  reorderQueuedComments: (
    id: string,
    data: { orderedCommentIds: string[]; queueId: string; revision: string },
  ) =>
    api.put<IssueQueuedCommentQueue>(
      `/issues/${id}/queued-comments/order`,
      data,
    ),
  interruptQueuedComments: (
    id: string,
    data: { queueId: string; targetRunId: string | null; revision: string },
  ) => api.post<IssueQueuedCommentQueue>(`/issues/${id}/queued-comments/interrupt`, data),
  interruptLatestQueuedComments: async (id: string, expectedTargetRunId: string | null): Promise<IssueQueuedCommentQueue> => {
    const queue = await issuesApi.getQueuedComments(id);
    if (!queue.queueId || (queue.targetRunId && queue.targetRunId !== expectedTargetRunId)) {
      throw new Error("The queued messages changed. Refresh and try again.");
    }
    return issuesApi.interruptQueuedComments(id, {
      queueId: queue.queueId, revision: queue.revision, targetRunId: queue.targetRunId,
    });
  },
  steerQueuedComment: (
    id: string,
    commentId: string,
    data: { queueId: string; targetRunId: string; revision: string },
  ) =>
    api.post<IssueQueuedCommentQueue>(
      `/issues/${id}/queued-comments/${commentId}/steer`,
      data,
    ),
  discardQueuedComment: (
    id: string,
    commentId: string,
    data: { queueId: string; revision: string },
  ) =>
    api.delete<IssueQueuedCommentQueue>(
      `/issues/${id}/queued-comments/${commentId}`,
      data,
    ),
  listInteractions: (id: string) =>
    api.get<IssueThreadInteraction[]>(`/issues/${id}/interactions`),
  listAcceptedPlanDecompositions: (id: string) =>
    api.get<AcceptedPlanDecompositionSummary[]>(
      `/issues/${id}/accepted-plan-decompositions`,
    ),
  createInteraction: (id: string, data: Record<string, unknown>) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions`, data),
  acceptInteraction: (
    id: string,
    interactionId: string,
    data?: {
      selectedClientKeys?: string[];
      selectedOptionIds?: string[];
      rememberAction?: boolean;
      proposedActionResult?: ProposedActionAcceptResult;
    },
  ) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/accept`,
      data ?? {},
    ),
  /** Reserve an Assistant proposed action before the browser executes it; the server re-validates it. */
  claimProposedAction: (id: string, interactionId: string, hash: string) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/claim-proposed-action`,
      { hash },
    ),
  rejectInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/reject`,
      reason ? { reason } : {},
    ),
  cancelInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/cancel`,
      reason ? { reason } : {},
    ),
  skipInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/skip`,
      reason ? { reason } : {},
    ),
  respondToInteraction: (
    id: string,
    interactionId: string,
    data: {
      answers: AskUserQuestionsAnswer[];
      summaryMarkdown?: string | null;
    },
  ) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/respond`,
      data,
    ),
  submitInteractionVerdicts: (
    id: string,
    interactionId: string,
    verdicts: {
      id: string;
      verdict: "approve" | "reject" | "defer";
      reason?: string | null;
    }[],
  ) =>
    api.post<IssueThreadInteraction>(
      `/issues/${id}/interactions/${interactionId}/verdicts`,
      { verdicts },
    ),
  getComment: (id: string, commentId: string) =>
    api.get<IssueComment>(`/issues/${id}/comments/${commentId}`),
  listFeedbackVotes: (id: string) =>
    api.get<FeedbackVote[]>(`/issues/${id}/feedback-votes`),
  getCostSummary: (id: string, options: { excludeRoot?: boolean } = {}) => {
    const qs = options.excludeRoot ? "?excludeRoot=true" : "";
    return api.get<IssueCostSummary>(`/issues/${id}/cost-summary${qs}`);
  },
  listFeedbackTraces: (
    id: string,
    filters?: Record<string, string | boolean | undefined>,
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(
      `/issues/${id}/feedback-traces${qs ? `?${qs}` : ""}`,
    );
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/issues/${id}/feedback-votes`, data),
  addComment: (
    id: string,
    body: string,
    reopen?: boolean,
    interrupt?: boolean,
    attachmentIds?: string[],
    clientRequestId?: string,
    options?: { metadata?: { pageContext?: AssistantPageContext } },
  ) =>
    confirmedCommentResponse(
      api.post<IssueComment>(`/issues/${id}/comments`, {
        body,
        ...(options?.metadata?.pageContext
          ? { metadata: { version: 1, pageContext: options.metadata.pageContext } }
          : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
      }),
      hasCommentReceipt,
    ),
  cancelComment: (id: string, commentId: string) =>
    api.delete<IssueComment>(`/issues/${id}/comments/${commentId}?mode=cancel`),
  deleteComment: (id: string, commentId: string) =>
    api.delete<IssueComment>(`/issues/${id}/comments/${commentId}`),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<IssueDocument[]>(
      `/issues/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  getDocument: (id: string, key: string) =>
    api.get<IssueDocument>(
      `/issues/${id}/documents/${encodeURIComponent(key)}`,
    ),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(
      `/issues/${id}/documents/${encodeURIComponent(key)}`,
      data,
    ),
  lockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(
      `/issues/${id}/documents/${encodeURIComponent(key)}/lock`,
      {},
    ),
  unlockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(
      `/issues/${id}/documents/${encodeURIComponent(key)}/unlock`,
      {},
    ),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(
      `/issues/${id}/documents/${encodeURIComponent(key)}/revisions`,
    ),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<IssueDocument>(
      `/issues/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`,
      {},
    ),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(
      `/issues/${id}/documents/${encodeURIComponent(key)}`,
    ),
  listAttachments: (id: string) =>
    api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(
      `/companies/${companyId}/issues/${issueId}/attachments`,
      form,
    );
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  // --- Privacy / sharing (PAP-16066) -------------------------------------
  // Enriched grants for the share sheet: implicit-by-source rows (assignment /
  // project) plus explicit grants, each carrying subjectDisplayName / avatar /
  // agentVisibility from the server enrichment pass.
  privacyConstraints: (id: string) => api.get<IssuePrivacyConstraints>(`/issues/${id}/privacy-constraints`),
  listAccessGrants: (id: string, options?: RequestOptions) =>
    options
      ? api.get<IssueAccessGrant[]>(`/issues/${id}/access-grants`, options)
      : api.get<IssueAccessGrant[]>(`/issues/${id}/access-grants`),
  createAccessGrant: (
    id: string,
    data: { subjectType: IssueAccessGrantSubjectType; subjectId: string },
  ) => api.post<IssueAccessGrant>(`/issues/${id}/access-grants`, data),
  revokeAccessGrant: (id: string, grantId: string) =>
    api.post<IssueAccessGrant>(`/issues/${id}/access-grants/${grantId}/revoke`, {}),
  setVisibility: (id: string, visibility: IssueVisibility) =>
    api.patch<IssueUpdateResponse>(`/issues/${id}`, { visibility }),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string, options?: { refreshPullRequests?: boolean; signal?: AbortSignal; fresh?: boolean }) => {
    const path = `/issues/${id}/work-products${options?.refreshPullRequests ? "?refreshPullRequests=true" : ""}`;
    // Query invalidations must not rejoin a request that read rows before the write.
    if (options?.fresh) detachInflightGet(path);
    return api.get<IssueWorkProduct[]>(path, { signal: options?.signal });
  },
  ensureWorkProductReviewDocument: (id: string, workProductId: string) =>
    api.post<IssueDocument>(
      `/issues/${id}/work-products/${workProductId}/review-document`,
      {},
    ),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) =>
    api.delete<IssueWorkProduct>(`/work-products/${id}`),
};

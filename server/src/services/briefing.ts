import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  costEvents,
  issueRelations,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import {
  BRIEFING_AGENT_ACTIONS_WINDOW_HOURS,
  askUserQuestionsPayloadToQuestionSet,
  BRIEFING_DONE_RECENTLY_LIMIT,
  BRIEFING_DONE_RECENTLY_WINDOW_DAYS,
  BRIEFING_IN_PROGRESS_LIMIT,
  BRIEFING_NEEDS_YOU_LIMIT,
  type AskUserQuestionsPayload,
  type AttentionItem,
  type AttentionSourceKind,
  type Briefing,
  type BriefingAction,
  type BriefingItem,
  type BriefingItemKind,
  type BriefingRecommendation,
  type BriefingRecommendationAnswer,
  type BriefingSpend,
} from "@paperclipai/shared";
import { autopilotCategoriesFromMetadata } from "./agent-autopilot.js";
import {
  budgetIncidentCopy,
  clipReason,
  COSTS_HREF,
  failureCause,
  failureReason,
  raiseBudgetAction,
  type BudgetIncidentFacts,
  type FailureCause,
} from "./briefing-reasons.js";
import { attentionService } from "./attention.js";
import { HOSTED_BILLED_CENTS_METRIC, budgetService } from "./budgets.js";
import { getUtcMonthStart } from "./dashboard.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { issueService } from "./issues.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { listLiveRuns } from "./live-runs.js";
import { appChoiceLabel, appDisplayName, connectionAppSlug } from "./plan-templates.js";
import { toolNamePatternMatches } from "./tool-access-policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Calls created up to this long before the roll-up window may still complete inside it. */
const AGENT_ACTIONS_CREATED_SLACK_MS = HOUR_MS;

/** Attention source kinds shown under "Needs you", mapped to briefing kinds. */
const NEEDS_YOU_KIND_BY_SOURCE: Partial<Record<AttentionSourceKind, BriefingItemKind>> = {
  approval: "approval",
  issue_thread_interaction: "confirmation",
  blocker_attention: "blocked_task",
  budget_alert: "budget_incident",
  review: "review",
  failed_run: "failed_run",
  agent_error_alert: "agent_error",
};

/** Confirmation payload keys whose accept runs a server-owned flow with its own card. */
const SERVER_OWNED_CONFIRMATION_KEYS = [
  "toolAction",
  "secretProposal",
  "proposedAction",
  "connectionAuthorization",
] as const;

export interface BriefingServiceOptions {
  now?: () => number;
  /** Test seam: the attention feed source. Defaults to `attentionService(db)`. */
  attention?: Pick<ReturnType<typeof attentionService>, "list">;
  /** Test seam: agent and company-cost read decisions. Defaults to `authorizationService(db)`. */
  authorization?: Pick<ReturnType<typeof authorizationService>, "decide">;
}

export interface BriefingGetInput {
  companyId: string;
  userId: string;
  actor: AuthorizationActor;
}

function toIso(value: Date | string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Remove the company prefix from an attention href so the link is company-relative. */
export function companyRelativeHref(href: string | null | undefined, prefix: string): string | null {
  if (!href) return null;
  const marker = `/${prefix}`;
  if (href === marker) return "/";
  if (href.startsWith(`${marker}/`) || href.startsWith(`${marker}#`) || href.startsWith(`${marker}?`)) {
    const rest = href.slice(marker.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return href;
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const TITLE_MAX = 120;
const WAITING_LABEL_MAX = 80;

interface NeedsYouContext {
  companyId: string;
  prefix: string;
  companyName: string;
  nowIso: string;
  interactionById: Map<string, { id: string; issueId: string; kind: string; payload: unknown }>;
  issueById: Map<string, { id: string; identifier: string | null; title: string }>;
  agentById: Map<string, { id: string; status: string; pauseReason: string | null }>;
  incidents: BudgetIncidentFacts[];
}
export const RECOMMENDATION_LABEL_MAX = 60;

/**
 * The person-facing title of an interaction: what is actually being asked,
 * rather than the generic attention title. Null when the payload has nothing usable.
 */
export function interactionTitle(kind: string, payload: unknown): string | null {
  const record = readRecord(payload);
  if (kind === "ask_user_questions") {
    const questionSet = readRecord(record.questionSet);
    const setTitle = nonEmptyString(questionSet.title) ?? nonEmptyString(record.title);
    if (setTitle) return clipText(setTitle, TITLE_MAX);
    const questions = Array.isArray(questionSet.questions) && questionSet.questions.length > 0
      ? questionSet.questions
      : Array.isArray(record.questions) ? record.questions : [];
    const firstPrompt = nonEmptyString(readRecord(questions[0]).prompt);
    if (!firstPrompt) return null;
    const more = questions.length - 1;
    return `${clipText(firstPrompt, TITLE_MAX)}${more > 0 ? ` (+${more} more)` : ""}`;
  }
  const title = nonEmptyString(record.title) ?? nonEmptyString(record.prompt);
  return title ? clipText(title, TITLE_MAX) : null;
}

function issuePath(issue: { id: string; identifier: string | null }) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function joinSubtitle(...parts: Array<string | null | undefined>): string | null {
  const present = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return present.length > 0 ? present.join(" · ") : null;
}

/**
 * Derive the recommended answer for an ask_user_questions payload (question-set
 * or legacy form). Inline only when every question carries a recommendation.
 */
export function askUserQuestionsRecommendation(payload: unknown): BriefingRecommendation | undefined {
  const record = readRecord(payload);
  if (!Array.isArray(record.questions) && !record.questionSet) return undefined;
  let questionSet;
  try {
    questionSet = askUserQuestionsPayloadToQuestionSet({
      questions: Array.isArray(record.questions) ? (record.questions as AskUserQuestionsPayload["questions"]) : [],
      questionSet: record.questionSet as AskUserQuestionsPayload["questionSet"],
      submitLabel: nonEmptyString(record.submitLabel),
    });
  } catch {
    return undefined;
  }
  const questions = Array.isArray(questionSet?.questions) ? questionSet.questions : [];
  if (questions.length === 0) return undefined;

  const derived = questions.map((question): { answer: BriefingRecommendationAnswer; label: string } | null => {
    if (question.answerMode === "text") {
      const text = nonEmptyString(question.initialText);
      return text ? { answer: { questionId: question.id, text }, label: text } : null;
    }
    const recommended = (question.options ?? []).filter((option) => option.recommended === true);
    if (question.answerMode === "single_select") {
      if (recommended.length !== 1) return null;
      return { answer: { questionId: question.id, optionIds: [recommended[0]!.id] }, label: recommended[0]!.label };
    }
    if (recommended.length === 0) return null;
    return {
      answer: { questionId: question.id, optionIds: recommended.map((option) => option.id) },
      label: recommended.map((option) => option.label).join(", "),
    };
  });

  if (derived.every((entry) => entry !== null)) {
    const complete = derived as Array<{ answer: BriefingRecommendationAnswer; label: string }>;
    return {
      label: clipText(complete.map((entry) => entry.label).join(" · "), RECOMMENDATION_LABEL_MAX),
      inline: true,
      answers: complete.map((entry) => entry.answer),
    };
  }
  const first = derived.find((entry) => entry !== null);
  return first ? { label: first.label, inline: false } : undefined;
}

/** Derive the recommendation for a request_confirmation payload. */
export function requestConfirmationRecommendation(payload: unknown): BriefingRecommendation {
  const record = readRecord(payload);
  const acceptLabel = nonEmptyString(record.acceptLabel);
  const serverOwned = SERVER_OWNED_CONFIRMATION_KEYS.some((key) => record[key] !== undefined && record[key] !== null);
  if (serverOwned) return { label: acceptLabel ?? "Review", inline: false };
  return { label: acceptLabel ?? "Confirm", inline: true, accept: true };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function listLabel(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * "Riley sent 3 emails" when every counted action is in the template's email
 * category, otherwise "Riley took 3 actions in GitHub".
 */
export function agentActionsTitle(agentName: string, count: number, capabilities: ReadonlySet<string>, appNames: string[]): string {
  if (capabilities.size === 1 && capabilities.has("email")) return `${agentName} sent ${plural(count, "email")}`;
  const apps = listLabel([...new Set(appNames)]);
  return `${agentName} took ${plural(count, "action")}${apps ? ` in ${apps}` : ""}`;
}

export function briefingService(db: Db, serviceOptions: BriefingServiceOptions = {}) {
  const attention = serviceOptions.attention
    ?? attentionService(db, serviceOptions.now ? { now: serviceOptions.now } : {});
  const issueSvc = issueService(db);

  async function companyFacts(companyId: string) {
    const row = await db
      .select({ issuePrefix: companies.issuePrefix, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return { prefix: row?.issuePrefix ?? "PAP", name: row?.name ?? "" };
  }

  async function needsYou(
    input: BriefingGetInput,
    prefix: string,
    companyName: string,
    readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>,
    nowIso: string,
  ): Promise<{ items: BriefingItem[]; issueIds: Set<string> }> {
    const feed = await attention.list(input.companyId, {
      userId: input.userId,
      actor: input.actor,
      all: true,
      allowUnscopedAll: true,
    });
    const kept = feed.items.filter((item) => NEEDS_YOU_KIND_BY_SOURCE[item.sourceKind] !== undefined);

    const interactionIds = kept
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.id);
    const interactionRows = interactionIds.length === 0 ? [] : await db
      .select({
        id: issueThreadInteractions.id,
        issueId: issueThreadInteractions.issueId,
        kind: issueThreadInteractions.kind,
        payload: issueThreadInteractions.payload,
      })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        inArray(issueThreadInteractions.id, interactionIds),
      ));
    const interactionById = new Map(interactionRows.map((row) => [row.id, row]));
    const interactionIssueIds = [...new Set(interactionRows.map((row) => row.issueId))];
    const issueRows = interactionIssueIds.length === 0 ? [] : await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, interactionIssueIds), readCondition));
    const issueById = new Map(issueRows.map((row) => [row.id, row]));

    // Current agent state decides between "Resume" and other fixes.
    const agentIds = [...new Set(kept.flatMap((item) => {
      if (item.sourceKind === "agent_error_alert") return [item.subject.id];
      if (item.sourceKind === "failed_run") {
        const agentId = nonEmptyString(readRecord(item.subject.metadata).agentId);
        return agentId ? [agentId] : [];
      }
      return [];
    }))];
    const agentRows = agentIds.length === 0 ? [] : await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)));
    const agentById = new Map(agentRows.map((row) => [row.id, row]));
    const incidents = kept
      .filter((item) => item.sourceKind === "budget_alert")
      .map((item) => budgetFacts(item))
      .filter((facts): facts is BudgetIncidentFacts => facts !== null);

    const context: NeedsYouContext = { companyId: input.companyId, prefix, companyName, nowIso, interactionById, issueById, agentById, incidents };
    const items = kept
      .map((item) => toNeedsYouItem(item, context))
      .filter((item): item is BriefingItem => item !== null)
      .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
    // Every task a Needs you row covers, so In progress never lists it twice.
    const issueIds = new Set<string>();
    for (const item of kept) {
      if (item.subject.kind === "issue") issueIds.add(item.subject.id);
      if (item.relatedIssue?.id) issueIds.add(item.relatedIssue.id);
    }
    for (const item of items) if (item.issueId) issueIds.add(item.issueId);
    return { items, issueIds };
  }

  function budgetFacts(item: AttentionItem): BudgetIncidentFacts | null {
    const metadata = readRecord(item.subject.metadata);
    const policyId = nonEmptyString(metadata.policyId);
    const scopeId = nonEmptyString(metadata.scopeId);
    const scopeType = metadata.scopeType;
    if (!policyId || !scopeId || (scopeType !== "company" && scopeType !== "agent" && scopeType !== "project")) return null;
    const amountLimit = Number(metadata.amountLimit);
    const amountObserved = Number(metadata.amountObserved);
    const observedPercent = Number(metadata.observedPercent);
    return {
      incidentId: item.subject.id,
      policyId,
      metric: nonEmptyString(metadata.metric) ?? "billed_cents",
      scopeType,
      scopeId,
      scopeName: nonEmptyString(metadata.scopeName),
      thresholdType: nonEmptyString(metadata.thresholdType) ?? "hard",
      amountLimit: Number.isFinite(amountLimit) ? amountLimit : 0,
      amountObserved: Number.isFinite(amountObserved) ? amountObserved : 0,
      observedPercent: Number.isFinite(observedPercent) ? observedPercent : null,
    };
  }

  /** The open incident that stopped this agent: its own limit first, then the company's. */
  function incidentFor(incidents: BudgetIncidentFacts[], agentId: string | null, companyId: string, hosted: boolean) {
    const metricMatches = (facts: BudgetIncidentFacts) =>
      hosted ? facts.metric === HOSTED_BILLED_CENTS_METRIC : facts.metric !== HOSTED_BILLED_CENTS_METRIC;
    const candidates = incidents.filter((facts) => metricMatches(facts) && facts.thresholdType === "hard");
    return (agentId ? candidates.find((facts) => facts.scopeType === "agent" && facts.scopeId === agentId) : undefined)
      ?? candidates.find((facts) => facts.scopeType === "company" && facts.scopeId === companyId)
      ?? null;
  }

  /** The fix for a failed run or errored agent, by cause. Unknown causes get none: Ask Assistant covers them. */
  function failureAction(
    cause: FailureCause,
    kind: "run" | "agent",
    agentId: string | null,
    runId: string | null,
    errorCode: string | null,
    companyId: string,
    incidents: BudgetIncidentFacts[],
  ): BriefingAction | undefined {
    if (cause === "hosted_limit" || cause === "budget_reached") {
      const incident = incidentFor(incidents, agentId, companyId, cause === "hosted_limit");
      return incident ? raiseBudgetAction(incident) : { kind: "open_settings", label: "Review limits", href: COSTS_HREF };
    }
    if (!agentId) return undefined;
    if (cause === "agent_paused") return { kind: "resume_agent", label: "Resume", agentId };
    if (cause === "not_connected") {
      const view = errorCode === "binding_missing" ? "tools" : errorCode?.startsWith("user_secret") ? "secrets" : "runtime";
      return { kind: "open_settings", label: "Open settings", href: `/agents/${agentId}/${view}` };
    }
    if (kind === "agent") return { kind: "clear_agent_error", label: "Dismiss error", agentId };
    if ((cause === "timed_out" || cause === "out_of_credit") && runId) return { kind: "retry_run", label: "Try again", agentId, runId };
    return undefined;
  }

  function toNeedsYouItem(item: AttentionItem, context: NeedsYouContext): BriefingItem | null {
    const { prefix, nowIso, interactionById, issueById } = context;
    let kind = NEEDS_YOU_KIND_BY_SOURCE[item.sourceKind];
    if (!kind) return null;
    const metadata = readRecord(item.subject.metadata);
    const metadataIssueId = nonEmptyString(metadata.issueId);
    let issueId: string | null =
      item.relatedIssue?.id ?? (item.subject.kind === "issue" ? item.subject.id : null) ?? metadataIssueId;
    let recommendation: BriefingRecommendation | undefined;
    let title = item.subject.title ?? item.whyNow;
    let subtitle: string | null = null;
    let reason: string | null = null;
    let action: BriefingAction | undefined;

    if (item.sourceKind === "issue_thread_interaction") {
      const row = interactionById.get(item.subject.id);
      if (!row) return null;
      issueId = row.issueId;
      title = interactionTitle(row.kind, row.payload) ?? title;
      const issue = issueById.get(row.issueId);
      if (issue) subtitle = joinSubtitle(issue.identifier, issue.title);
      if (row.kind === "ask_user_questions") {
        kind = "question";
        recommendation = askUserQuestionsRecommendation(row.payload);
      } else if (row.kind === "request_confirmation") {
        kind = "confirmation";
        recommendation = requestConfirmationRecommendation(row.payload);
      } else {
        kind = "confirmation";
      }
    } else if (item.sourceKind === "failed_run") {
      const agentId = nonEmptyString(metadata.agentId);
      const agent = agentId ? context.agentById.get(agentId) : undefined;
      const errorCode = nonEmptyString(metadata.errorCode);
      const cause = agent?.status === "paused" && agent.pauseReason === "budget"
        ? "budget_reached"
        : failureCause({
          errorCode,
          error: nonEmptyString(metadata.error) ?? nonEmptyString(metadata.retryExhaustedReason),
          runStatus: item.subject.status,
          agentPaused: agent?.status === "paused",
        });
      const agentName = nonEmptyString(metadata.agentName) ?? item.originAgentName;
      title = agentName ? `${agentName} couldn't finish its work` : title;
      reason = failureReason(cause, agentName, "run");
      action = failureAction(cause, "run", agentId, item.subject.id, errorCode, context.companyId, context.incidents);
    } else if (item.sourceKind === "agent_error_alert") {
      const agentId = item.subject.id;
      const agent = context.agentById.get(agentId);
      const errorReason = nonEmptyString(metadata.errorReason);
      const cause = failureCause({ error: errorReason, agentPaused: agent?.status === "paused" });
      reason = failureReason(cause, item.subject.title, "agent");
      action = failureAction(cause, "agent", agentId, null, null, context.companyId, context.incidents);
    } else if (item.sourceKind === "budget_alert") {
      const facts = budgetFacts(item);
      if (facts) {
        const copy = budgetIncidentCopy(facts, context.companyName);
        title = copy.title;
        reason = copy.reason;
        action = raiseBudgetAction(facts);
      }
    } else if (item.sourceKind === "blocker_attention") {
      reason = item.whyNow ? clipReason(item.whyNow) : null;
    }

    const issueIdentifier = item.relatedIssue?.identifier ?? item.subject.identifier ?? null;
    const fallbackHref = issueIdentifier || issueId ? `/issues/${issueIdentifier ?? issueId}` : "/decisions";
    return {
      kind,
      id: item.subject.id,
      title,
      subtitle: subtitle ?? joinSubtitle(issueIdentifier, item.originAgentName),
      href: companyRelativeHref(item.subject.href, prefix) ?? fallbackHref,
      issueId,
      ...(recommendation ? { recommendation } : {}),
      ...(reason ? { reason } : {}),
      ...(action ? { action } : {}),
      createdAt: toIso(item.createdAt, nowIso),
    };
  }

  async function inProgress(
    input: BriefingGetInput,
    readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>,
    nowIso: string,
  ): Promise<BriefingItem[]> {
    const listStatus = (status: string) => issueSvc.list(input.companyId, {
      status,
      readCondition,
      sortField: "updated",
      sortDir: "desc",
    });
    const [liveRuns, activeIssues, todoIssues, blockedIssues, agentRows] = await Promise.all([
      listLiveRuns(db, input.companyId),
      listStatus("in_progress"),
      listStatus("todo"),
      listStatus("blocked"),
      db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, input.companyId)),
    ]);
    const agentNameById = new Map(agentRows.map((row) => [row.id, row.name]));

    const runIssueIds = [...new Set(liveRuns.map((run) => run.issueId).filter((id): id is string => !!id))];
    // Conversation, hidden and harness issues never surface here, and only
    // issues the person can read do.
    const readableRunIssues = runIssueIds.length === 0 ? [] : await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        inArray(issues.id, runIssueIds),
        executionIssueCondition(),
        readCondition,
      ));
    const runIssueById = new Map(readableRunIssues.map((issue) => [issue.id, issue]));

    const liveItems: BriefingItem[] = [];
    const representedIssueIds = new Set<string>();
    const representedAgentIds = new Set<string>();
    for (const run of liveRuns) {
      if (run.issueId) {
        const issue = runIssueById.get(run.issueId);
        // The run's issue was filtered out (conversation, hidden, unreadable): skip the run entirely.
        if (!issue) continue;
        // One row per task: the newest live run represents it.
        if (representedIssueIds.has(issue.id)) continue;
        representedIssueIds.add(issue.id);
        liveItems.push({
          kind: "live_run",
          id: run.id,
          title: issue.title,
          subtitle: joinSubtitle(issue.identifier, run.agentName),
          href: issuePath(issue),
          issueId: issue.id,
          createdAt: toIso(run.startedAt ?? run.createdAt, nowIso),
        });
      } else {
        // Issue-less runs: one row per agent.
        if (representedAgentIds.has(run.agentId)) continue;
        representedAgentIds.add(run.agentId);
        liveItems.push({
          kind: "live_run",
          id: run.id,
          title: run.agentName,
          subtitle: null,
          href: `/agents/${run.agentId}`,
          issueId: null,
          createdAt: toIso(run.startedAt ?? run.createdAt, nowIso),
        });
      }
    }

    const taskItems: BriefingItem[] = activeIssues
      .filter((issue) => !representedIssueIds.has(issue.id))
      .map((issue) => ({
        kind: "active_task" as const,
        id: issue.id,
        title: issue.title,
        subtitle: joinSubtitle(
          issue.identifier,
          issue.assigneeAgentId ? agentNameById.get(issue.assigneeAgentId) ?? null : null,
        ),
        href: issuePath(issue),
        issueId: issue.id,
        createdAt: toIso(issue.startedAt ?? issue.updatedAt, nowIso),
      }));

    const assignedName = (issue: { assigneeAgentId: string | null }) =>
      issue.assigneeAgentId ? agentNameById.get(issue.assigneeAgentId) ?? null : null;
    const upNextItems: BriefingItem[] = todoIssues
      .filter((issue) => !representedIssueIds.has(issue.id) && (issue.assigneeAgentId || issue.assigneeUserId))
      .map((issue) => ({
        kind: "queued_task" as const,
        id: issue.id,
        title: issue.title,
        subtitle: joinSubtitle(issue.identifier, assignedName(issue)),
        href: issuePath(issue),
        issueId: issue.id,
        label: "Up next",
        createdAt: toIso(issue.updatedAt, nowIso),
      }));

    const waiting = blockedIssues.filter((issue) => !representedIssueIds.has(issue.id));
    const blockerTitleById = await openBlockerTitles(input.companyId, waiting.map((issue) => issue.id), readCondition);
    const waitingItems: BriefingItem[] = waiting.map((issue) => {
      const blocker = blockerTitleById.get(issue.id);
      return {
        kind: "waiting_task" as const,
        id: issue.id,
        title: issue.title,
        subtitle: joinSubtitle(issue.identifier, assignedName(issue)),
        href: issuePath(issue),
        issueId: issue.id,
        label: blocker ? clipText(`Waiting on ${blocker}`, WAITING_LABEL_MAX) : "Waiting",
        createdAt: toIso(issue.updatedAt, nowIso),
      };
    });

    return [...liveItems, ...taskItems, ...upNextItems, ...waitingItems];
  }

  /** The title of one unfinished blocker the person can read, per blocked task. */
  async function openBlockerTitles(
    companyId: string,
    blockedIssueIds: string[],
    readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>,
  ): Promise<Map<string, string>> {
    if (blockedIssueIds.length === 0) return new Map();
    const rows = await db
      .select({ blockedId: issueRelations.relatedIssueId, title: issues.title, updatedAt: issues.updatedAt })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, blockedIssueIds),
        eq(issues.companyId, companyId),
        notInArray(issues.status, ["done", "cancelled"]),
        readCondition,
      ));
    const map = new Map<string, string>();
    for (const row of rows.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))) {
      if (!map.has(row.blockedId)) map.set(row.blockedId, row.title);
    }
    return map;
  }

  async function doneRecently(
    input: BriefingGetInput,
    readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>,
    now: number,
    nowIso: string,
  ): Promise<BriefingItem[]> {
    const since = now - BRIEFING_DONE_RECENTLY_WINDOW_DAYS * DAY_MS;
    const doneIssues = await issueSvc.list(input.companyId, {
      status: "done",
      readCondition,
      updatedSince: new Date(since).toISOString(),
      sortField: "updated",
      sortDir: "desc",
    });
    const agentIds = [...new Set(doneIssues.map((issue) => issue.assigneeAgentId).filter((id): id is string => !!id))];
    const agentRows = agentIds.length === 0 ? [] : await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)));
    const agentNameById = new Map(agentRows.map((row) => [row.id, row.name]));
    return doneIssues
      .filter((issue) => toTime(issue.completedAt) >= since)
      .sort((a, b) => toTime(b.completedAt) - toTime(a.completedAt))
      .map((issue) => ({
        kind: "done_task" as const,
        id: issue.id,
        title: issue.title,
        subtitle: joinSubtitle(
          issue.identifier,
          issue.assigneeAgentId ? agentNameById.get(issue.assigneeAgentId) ?? null : null,
        ),
        href: issuePath(issue),
        issueId: issue.id,
        createdAt: toIso(issue.completedAt, nowIso),
      }));
  }

  /**
   * One row per templated agent the person can see: its succeeded write-risk
   * tool calls in the template's outward categories over the last 24 hours.
   */
  async function agentActionRollups(input: BriefingGetInput, now: number, nowIso: string): Promise<BriefingItem[]> {
    const since = new Date(now - BRIEFING_AGENT_ACTIONS_WINDOW_HOURS * HOUR_MS);
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), sql`(${agents.metadata} -> 'staplesTemplate') is not null`));
    const templated = agentRows
      .map((row) => ({ ...row, categories: autopilotCategoriesFromMetadata(row.metadata) }))
      .filter((row) => row.categories.length > 0);
    if (templated.length === 0) return [];
    const authz = serviceOptions.authorization ?? authorizationService(db);
    const decisions = await Promise.all(templated.map((row) => authz.decide({
      actor: input.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: input.companyId, agentId: row.id },
    })));
    const visible = templated.filter((_, index) => decisions[index]?.allowed);
    if (visible.length === 0) return [];

    // Grouped in SQL: one row per agent, tool and connection with its count and
    // latest time. The created_at bound (with slack for calls that ran long)
    // lets the (company_id, created_at) index narrow the scan; the completion
    // time check keeps the rolling window exact.
    const doneAt = sql<Date>`coalesce(${toolInvocations.completedAt}, ${toolInvocations.createdAt})`;
    const invocationRows = await db
      .select({
        agentId: toolInvocations.agentId,
        toolName: toolInvocations.toolName,
        upstreamToolName: toolInvocations.upstreamToolName,
        connectionId: toolInvocations.connectionId,
        count: sql<number>`count(*)::int`,
        latestAt: sql<string>`max(${doneAt})`,
      })
      .from(toolInvocations)
      .where(and(
        eq(toolInvocations.companyId, input.companyId),
        gte(toolInvocations.createdAt, new Date(since.getTime() - AGENT_ACTIONS_CREATED_SLACK_MS)),
        inArray(toolInvocations.agentId, visible.map((row) => row.id)),
        eq(toolInvocations.riskLevel, "write"),
        eq(toolInvocations.status, "succeeded"),
        sql`${doneAt} >= ${since.toISOString()}::timestamptz`,
      ))
      .groupBy(
        toolInvocations.agentId,
        toolInvocations.toolName,
        toolInvocations.upstreamToolName,
        toolInvocations.connectionId,
      );
    if (invocationRows.length === 0) return [];

    const connectionIds = [...new Set(invocationRows.map((row) => row.connectionId).filter((id): id is string => !!id))];
    const connectionRows = connectionIds.length === 0 ? [] : await db
      .select({
        id: toolConnections.id,
        config: toolConnections.config,
        transportConfig: toolConnections.transportConfig,
        applicationMetadata: toolApplications.metadata,
      })
      .from(toolConnections)
      .leftJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
      .where(and(eq(toolConnections.companyId, input.companyId), inArray(toolConnections.id, connectionIds)));
    const slugByConnectionId = new Map(connectionRows.map((row) => [row.id, connectionAppSlug(row)]));

    const items: BriefingItem[] = [];
    for (const agent of visible) {
      let count = 0;
      let latest = 0;
      const capabilities = new Set<string>();
      const appNames: string[] = [];
      for (const row of invocationRows) {
        if (row.agentId !== agent.id) continue;
        const names = [row.toolName, row.upstreamToolName].filter((name): name is string => !!name);
        const slug = row.connectionId ? slugByConnectionId.get(row.connectionId) ?? null : null;
        const matching = agent.categories.filter((category) =>
          category.toolPatterns.some((pattern) => names.some((name) => toolNamePatternMatches(pattern, name)))
          && !category.destructiveToolPatterns.some((pattern) => names.some((name) => toolNamePatternMatches(pattern, name))));
        // Patterns may overlap across categories (e.g. "*publish*"): prefer the one served by this app.
        const category = matching.find((candidate) => slug && candidate.anyOf.includes(slug)) ?? matching[0];
        if (!category) continue;
        count += Number(row.count);
        latest = Math.max(latest, toTime(row.latestAt));
        capabilities.add(category.capability);
        appNames.push(slug && category.anyOf.includes(slug)
          ? appDisplayName(slug)
          : category.anyOf.length ? appChoiceLabel(category.anyOf) : category.label);
      }
      if (count === 0) continue;
      items.push({
        kind: "agent_actions",
        id: agent.id,
        title: agentActionsTitle(agent.name, count, capabilities, appNames),
        subtitle: "Last 24 hours",
        href: `/agents/${agent.id}`,
        issueId: null,
        createdAt: toIso(latest ? new Date(latest) : null, nowIso),
      });
    }
    return items;
  }

  /**
   * This calendar month's spend (all cost events, as on the dashboard), with
   * the active person-set company budget and the active hosted cap (whose
   * spend counts hosted inference only), from the budget overview. Null when
   * the person may not read the company's costs.
   */
  async function spend(input: BriefingGetInput, now: number): Promise<BriefingSpend | null> {
    // Costs follow the costs routes' boundary: company-scope read.
    const authz = serviceOptions.authorization ?? authorizationService(db);
    const decision = await authz.decide({ actor: input.actor, action: "company_scope:read", resource: { type: "company", companyId: input.companyId } });
    if (!decision.allowed) return null;
    const companyId = input.companyId;
    const end = new Date(now);
    const [[row], overview] = await Promise.all([
      db.select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, getUtcMonthStart(end)), lte(costEvents.occurredAt, end))),
      budgetService(db).overview(companyId),
    ]);
    const companyPolicy = (metric: string) => overview.policies.find((policy) =>
      policy.scopeType === "company" && policy.scopeId === companyId && policy.metric === metric
      && policy.windowKind === "calendar_month_utc" && policy.isActive && policy.amount > 0);
    const budget = companyPolicy("billed_cents");
    const hosted = companyPolicy(HOSTED_BILLED_CENTS_METRIC);
    return {
      monthSpendCents: Math.round(Number(row?.total ?? 0)),
      companyBudgetCents: budget ? budget.amount : null,
      hosted: hosted ? { capCents: hosted.amount, spentCents: Math.round(hosted.observedAmount) } : null,
    };
  }

  return {
    get: async (input: BriefingGetInput): Promise<Briefing> => {
      const now = serviceOptions.now?.() ?? Date.now();
      const nowIso = new Date(now).toISOString();
      const [company, readCondition] = await Promise.all([
        companyFacts(input.companyId),
        issueReadSqlCondition(db, input.actor),
      ]);
      const [needsResult, movingAll, doneTasks, rollups, monthSpend] = await Promise.all([
        needsYou(input, company.prefix, company.name, readCondition, nowIso),
        inProgress(input, readCondition, nowIso),
        doneRecently(input, readCondition, now, nowIso),
        agentActionRollups(input, now, nowIso),
        spend(input, now),
      ]);
      const needs = needsResult.items;
      // A blocked task already under Needs you is not listed again as waiting.
      const moving = movingAll.filter((item) => item.kind !== "waiting_task" || !needsResult.issueIds.has(item.id));
      // Newest first across finished tasks and agent roll-ups.
      const done = [...doneTasks, ...rollups].sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
      return {
        needsYou: needs.slice(0, BRIEFING_NEEDS_YOU_LIMIT),
        inProgress: moving.slice(0, BRIEFING_IN_PROGRESS_LIMIT),
        doneRecently: done.slice(0, BRIEFING_DONE_RECENTLY_LIMIT),
        counts: { needsYou: needs.length, inProgress: moving.length, doneRecently: done.length },
        spend: monthSpend,
        generatedAt: nowIso,
      };
    },
  };
}

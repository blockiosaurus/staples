/**
 * Home briefing: what needs the person, what is moving, and what finished
 * recently. Built server-side from data already stored on each source item;
 * no model calls are involved.
 */
export type BriefingSection = "needsYou" | "inProgress" | "doneRecently";

export type BriefingItemKind =
  | "approval"
  | "question"
  | "confirmation"
  | "blocked_task"
  | "budget_incident"
  | "review"
  | "failed_run"
  | "agent_error"
  | "active_task"
  | "live_run"
  /** In progress: an assigned task waiting its turn ("Up next"). */
  | "queued_task"
  /** In progress: a blocked task that does not need the person ("Waiting on …"). */
  | "waiting_task"
  | "done_task"
  /** Done recently: one roll-up per templated agent of its outward write actions in the last 24 hours. */
  | "agent_actions";

export interface BriefingRecommendationAnswer {
  questionId: string;
  optionIds?: string[];
  text?: string;
}

export interface BriefingRecommendation {
  /** e.g. "Developers" or "Accept 3 recommendations". */
  label: string;
  /** True when Home may resolve the item in one click. */
  inline: boolean;
  /** ask_user_questions: the recommended answer per question. */
  answers?: BriefingRecommendationAnswer[];
  /** request_confirmation: accepting is the recommendation. */
  accept?: true;
}

/** The one-click fix a Needs you row offers. */
export type BriefingActionKind =
  | "retry_run"
  | "resume_agent"
  | "clear_agent_error"
  | "raise_budget"
  | "open_settings";

/** The budget a "raise_budget" action raises: the incident's own policy and metric. */
export interface BriefingBudgetTarget {
  incidentId: string;
  policyId: string;
  /** "billed_cents" (all spend) or "hosted_billed_cents" (hosted inference only). */
  metric: string;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  limitCents: number;
  observedCents: number;
  /** Twice the limit, and always above what has been spent; at most `maxCents`. */
  suggestedCents: number;
  /**
   * The most a person may raise it to: for a hosted limit, the operator's
   * ceiling (a limit already above it is kept, not raised). Null when there is
   * no ceiling. Home offers no raise when the limit is already at it.
   */
  maxCents: number | null;
}

export interface BriefingAction {
  kind: BriefingActionKind;
  /** e.g. "Try again", "Resume", "Dismiss error", "Raise limit". */
  label: string;
  /** retry_run, resume_agent, clear_agent_error. */
  agentId?: string;
  /** retry_run: the failed run to retry. */
  runId?: string;
  /** raise_budget. */
  budget?: BriefingBudgetTarget;
  /** open_settings: company-relative link. */
  href?: string;
}

export interface BriefingItem {
  kind: BriefingItemKind;
  /** Source id (interaction, approval, issue, run, agent or incident id). */
  id: string;
  title: string;
  /** e.g. "TES-12 · Riley". */
  subtitle?: string | null;
  /** Company-relative link, e.g. "/issues/TES-12". */
  href: string;
  /** The issue an interaction lives on; needed to resolve it. */
  issueId?: string | null;
  recommendation?: BriefingRecommendation;
  /** Needs you: why it needs the person, in one plain sentence (at most 140 characters). */
  reason?: string | null;
  /** Needs you: the fix Home can run in place. */
  action?: BriefingAction;
  /** In progress: a short state label, e.g. "Up next" or "Waiting on Write the brief". */
  label?: string | null;
  createdAt: string;
}

/**
 * This calendar month's (UTC) spend for Home. `companyBudgetCents` is the
 * person-set company budget (counts all spend), when one is active.
 * `hosted` is the company's hosted-inference cap (counts hosted spend only),
 * when one is active.
 */
export interface BriefingSpend {
  monthSpendCents: number;
  companyBudgetCents: number | null;
  hosted: { capCents: number; spentCents: number } | null;
}

/** The latest weekly update the Assistant wrote, for the Home card. */
export interface BriefingWeeklyUpdate {
  /** The document id (also the dismissal target). */
  documentId: string;
  /** e.g. "Weekly update — Oct 13, 2026". */
  title: string;
  /** The first few lines as plain text (at most 280 characters); each heading starts a new line ("\n"). */
  excerpt: string;
  /** Company-relative link to the document on the "Weekly updates" task. */
  href: string;
  /** When the update was last saved. */
  updatedAt: string;
}

export interface Briefing {
  /** Capped at 20, newest first. */
  needsYou: BriefingItem[];
  /**
   * Capped at 20: live runs first, then in-progress tasks, then assigned
   * to-do tasks ("Up next"), then blocked tasks not already under Needs you
   * ("Waiting on …"). One row per task.
   */
  inProgress: BriefingItem[];
  /**
   * Done within the last 7 days, newest first, capped at 10. Includes one
   * "agent_actions" roll-up per templated agent with outward write actions in
   * the last 24 hours.
   */
  doneRecently: BriefingItem[];
  /** Uncapped totals. */
  counts: { needsYou: number; inProgress: number; doneRecently: number };
  /** This month's spend against the company's budgets; null when the person may not read costs. */
  spend: BriefingSpend | null;
  /**
   * The latest weekly update, when it was saved in the last
   * WEEKLY_UPDATE_CARD_MAX_AGE_DAYS days and the person has not dismissed it.
   */
  weeklyUpdate: BriefingWeeklyUpdate | null;
  generatedAt: string;
}

export const BRIEFING_NEEDS_YOU_LIMIT = 20;
export const BRIEFING_REASON_MAX = 140;
export const BRIEFING_IN_PROGRESS_LIMIT = 20;
export const BRIEFING_DONE_RECENTLY_LIMIT = 10;
export const BRIEFING_DONE_RECENTLY_WINDOW_DAYS = 7;
/** Window of the per-agent outward action roll-up. */
export const BRIEFING_AGENT_ACTIONS_WINDOW_HOURS = 24;
/** Longest weekly update excerpt on Home. */
export const BRIEFING_WEEKLY_UPDATE_EXCERPT_MAX = 400;

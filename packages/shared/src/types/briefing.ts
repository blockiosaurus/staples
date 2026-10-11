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
  createdAt: string;
}

export interface Briefing {
  /** Capped at 20, newest first. */
  needsYou: BriefingItem[];
  /** Capped at 20: live runs first, then in-progress tasks. */
  inProgress: BriefingItem[];
  /**
   * Done within the last 7 days, newest first, capped at 10. Includes one
   * "agent_actions" roll-up per templated agent with outward write actions in
   * the last 24 hours.
   */
  doneRecently: BriefingItem[];
  /** Uncapped totals. */
  counts: { needsYou: number; inProgress: number; doneRecently: number };
  generatedAt: string;
}

export const BRIEFING_NEEDS_YOU_LIMIT = 20;
export const BRIEFING_IN_PROGRESS_LIMIT = 20;
export const BRIEFING_DONE_RECENTLY_LIMIT = 10;
export const BRIEFING_DONE_RECENTLY_WINDOW_DAYS = 7;
/** Window of the per-agent outward action roll-up. */
export const BRIEFING_AGENT_ACTIONS_WINDOW_HOURS = 24;

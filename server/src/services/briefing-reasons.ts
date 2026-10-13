import { BRIEFING_REASON_MAX, type BriefingAction, type BriefingBudgetTarget } from "@paperclipai/shared";
import { BUDGET_REACHED_ERROR_CODE, HOSTED_LIMIT_REACHED_ERROR_CODE } from "./budgets.js";
import { hostedPersonLimitMaxCents } from "./hosted-inference.js";

/**
 * Plain reasons and one-click fixes for Home's "Needs you" rows. Built only
 * from what the attention feed already carries (run error codes and messages,
 * agent error reasons, budget incident metadata), so no model call is needed.
 */

export type FailureCause =
  | "out_of_credit"
  | "hosted_limit"
  | "budget_reached"
  | "not_connected"
  | "agent_paused"
  | "timed_out"
  | "unknown";

const HOSTED_METRIC = "hosted_billed_cents";

const NOT_CONNECTED_CODES = new Set([
  "binding_missing",
  "claude_managed_api_key_missing",
  "claude_auth_required",
  "acpx_auth_required",
  "user_secret_missing",
  "user_secret_definition_missing",
  "configuration_incomplete",
  "signing_secret_unconfigured",
  "hermes_gateway_connect_failed",
]);

const TIMEOUT_CODES = new Set([
  "timeout",
  "hermes_gateway_timeout",
  "openclaw_gateway_wait_timeout",
  "execution_finalization_deadline_exceeded",
]);

const OUT_OF_CREDIT_CODE = "claude_managed_out_of_credit";
/** Exact phrases of the out-of-credit failure (Phase 8 adapter copy, Anthropic API). */
const OUT_OF_CREDIT_PHRASES = ["the anthropic account is out of credit", "credit balance is too low"];
/** Exact phrases of the server's hosted-limit refusal, for runs recorded before it carried a code. */
const HOSTED_LIMIT_PHRASES = [
  "reached its monthly hosted inference limit",
  "reached its monthly spending cap for hosted inference",
];
/** Exact phrases of the server's spending-budget enforcement (budgets.ts, budget-reservations.ts, run control). */
const BUDGET_PHRASES = [
  "budget hard-stop",
  "budget is reserved by unfinished runs",
  "cancelled due to budget pause",
];

/**
 * Classify a failure from structured signals: the error code, the agent's
 * state and pause reason, and the run status. Message text counts only when
 * it is one of the server's own exact enforcement phrases, so unrelated
 * errors that merely mention "budget" or "credit" stay unknown.
 */
export function failureCause(input: {
  errorCode?: string | null;
  error?: string | null;
  runStatus?: string | null;
  agentPaused?: boolean;
  agentPauseReason?: string | null;
}): FailureCause {
  const code = (input.errorCode ?? "").trim();
  const text = (input.error ?? "").toLowerCase();
  const says = (phrases: readonly string[]) => phrases.some((phrase) => text.includes(phrase));
  if (code === OUT_OF_CREDIT_CODE || says(OUT_OF_CREDIT_PHRASES)) return "out_of_credit";
  if (code === HOSTED_LIMIT_REACHED_ERROR_CODE || says(HOSTED_LIMIT_PHRASES)) return "hosted_limit";
  if (code === BUDGET_REACHED_ERROR_CODE || (input.agentPaused && input.agentPauseReason === "budget") || says(BUDGET_PHRASES)) {
    return "budget_reached";
  }
  if (input.agentPaused || code === "agent_not_invokable") return "agent_paused";
  if (NOT_CONNECTED_CODES.has(code)) return "not_connected";
  if (input.runStatus === "timed_out" || TIMEOUT_CODES.has(code)) return "timed_out";
  return "unknown";
}

/** Collapse whitespace and cut to the reason limit with an ellipsis. */
export function clipReason(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > BRIEFING_REASON_MAX ? `${flat.slice(0, BRIEFING_REASON_MAX - 1).trimEnd()}…` : flat;
}

/** "$90", "$12.50". */
export function dollars(cents: number): string {
  const value = Math.max(0, cents) / 100;
  const text = value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return text.replace(/\.00$/, "");
}

function subjectName(name: string | null | undefined, fallback: string): string {
  return name && name.trim() ? name.trim() : fallback;
}

/** The plain sentence for a failed run or an errored agent. */
export function failureReason(cause: FailureCause, agentName: string | null | undefined, kind: "run" | "agent"): string {
  const agent = subjectName(agentName, "This agent");
  switch (cause) {
    case "out_of_credit":
      return clipReason("The AI account is out of credit. Add credit to the Anthropic account, then try again.");
    case "hosted_limit":
      return clipReason(`${agent} reached its monthly hosted limit, so it stopped.`);
    case "budget_reached":
      return clipReason(`${agent} reached its spending limit, so it stopped.`);
    case "not_connected":
      return clipReason(`A service ${agent} uses isn't connected. Reconnect it, then try again.`);
    case "agent_paused":
      return clipReason(`${agent} is paused, so it can't work.`);
    case "timed_out":
      return clipReason(`${agent} took too long and was stopped.`);
    default:
      return kind === "run"
        ? clipReason(`${agent} stopped with an error it couldn't recover from.`)
        : clipReason(`${agent} hit an error and stopped.`);
  }
}

/** Twice the limit, and always more than what has been spent. */
export function suggestedBudgetCents(limitCents: number, observedCents: number): number {
  const doubled = Math.max(0, Math.round(limitCents)) * 2;
  const aboveSpend = Math.floor(Math.max(0, observedCents)) + 100;
  return Math.max(doubled, aboveSpend);
}

export interface BudgetIncidentFacts {
  incidentId: string;
  policyId: string;
  metric: string;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  scopeName: string | null;
  thresholdType: string;
  amountLimit: number;
  amountObserved: number;
  observedPercent: number | null;
}

/**
 * The most a person may raise this limit to: for a hosted limit, the
 * operator's ceiling (`hostedPersonLimitMaxCents`); null when there is none
 * (any other budget, or a 0 ceiling).
 */
export function budgetRaiseMaxCents(facts: BudgetIncidentFacts, env: NodeJS.ProcessEnv = process.env): number | null {
  return facts.metric === HOSTED_METRIC ? hostedPersonLimitMaxCents(Math.round(facts.amountLimit), env) : null;
}

/** True when a hosted limit can't be raised by a person: it is at the ceiling (or spend is already past it). */
export function budgetAtMaximum(facts: BudgetIncidentFacts, env: NodeJS.ProcessEnv = process.env): boolean {
  const max = budgetRaiseMaxCents(facts, env);
  return max !== null && (max <= Math.round(facts.amountLimit) || max <= Math.floor(Math.max(0, facts.amountObserved)));
}

export function budgetTarget(facts: BudgetIncidentFacts, env: NodeJS.ProcessEnv = process.env): BriefingBudgetTarget {
  const maxCents = budgetRaiseMaxCents(facts, env);
  const suggested = suggestedBudgetCents(facts.amountLimit, facts.amountObserved);
  return {
    incidentId: facts.incidentId,
    policyId: facts.policyId,
    metric: facts.metric,
    scopeType: facts.scopeType,
    scopeId: facts.scopeId,
    limitCents: Math.round(facts.amountLimit),
    observedCents: Math.round(facts.amountObserved),
    suggestedCents: maxCents === null ? suggested : Math.min(suggested, maxCents),
    maxCents,
  };
}

/** "Raise limit", or nothing when a hosted limit is already at its maximum (Ask Assistant covers it). */
export function raiseBudgetAction(facts: BudgetIncidentFacts, env: NodeJS.ProcessEnv = process.env): BriefingAction | undefined {
  if (budgetAtMaximum(facts, env)) return undefined;
  return { kind: "raise_budget", label: "Raise limit", budget: budgetTarget(facts, env) };
}

/** Title and reason for a budget incident row. */
export function budgetIncidentCopy(facts: BudgetIncidentFacts, companyName: string): { title: string; reason: string } {
  const hosted = facts.metric === HOSTED_METRIC;
  const name = facts.scopeType === "company"
    ? "Your company"
    : subjectName(facts.scopeName, facts.scopeType === "agent" ? "An agent" : "A project");
  const limit = dollars(facts.amountLimit);
  const what = hosted ? "monthly hosted limit" : "budget";
  const titleName = facts.scopeType === "company" ? subjectName(companyName, "Your company") : name;
  if (facts.thresholdType === "hard") {
    const stops = hosted && budgetAtMaximum(facts)
      ? "That's the most it can be, so hosted runs are on hold until next month."
      : hosted
      ? (facts.scopeType === "agent" ? "Its hosted runs are on hold until you raise it." : "Hosted runs are on hold until you raise it.")
      : "Work is on hold until you raise it.";
    return {
      title: clipReason(`${titleName} reached its ${what}`),
      reason: clipReason(`${name} spent ${dollars(facts.amountObserved)} of its ${limit} ${what}. ${stops}`),
    };
  }
  const percent = facts.observedPercent !== null ? `${Math.round(facts.observedPercent)}%` : "most";
  return {
    title: clipReason(`${titleName} is close to its ${what}`),
    reason: clipReason(`${name} has used ${percent} of its ${limit} ${what}.`),
  };
}

export const COSTS_HREF = "/activity/costs";

/** A blocked task's reason, from server-built facts only (never agent-written text). */
export function blockedReason(blockedTaskCount: number | null): string {
  if (blockedTaskCount !== null && blockedTaskCount > 0) {
    return `Holds up ${blockedTaskCount === 1 ? "1 task" : `${blockedTaskCount} tasks`} until you step in.`;
  }
  return "This task is waiting on you to unblock it.";
}

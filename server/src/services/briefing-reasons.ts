import { BRIEFING_REASON_MAX, type BriefingAction, type BriefingBudgetTarget } from "@paperclipai/shared";

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

/** Classify a failure from its error code, its message and the run status. */
export function failureCause(input: {
  errorCode?: string | null;
  error?: string | null;
  runStatus?: string | null;
  agentPaused?: boolean;
}): FailureCause {
  const code = (input.errorCode ?? "").trim();
  const text = (input.error ?? "").toLowerCase();
  if (code === "claude_managed_out_of_credit" || /out of credit|credit balance is too low/.test(text)) return "out_of_credit";
  if (/hosted inference limit|spending cap for hosted inference/.test(text)) return "hosted_limit";
  if (code === "budget_reached" || /budget|spending cap/.test(text)) return "budget_reached";
  if (input.agentPaused || code === "agent_not_invokable" || /agent is paused/.test(text)) return "agent_paused";
  if (NOT_CONNECTED_CODES.has(code) || /not connected|reconnect|authori[sz]ation (expired|required|revoked)|api key (is )?missing/.test(text)) {
    return "not_connected";
  }
  if (input.runStatus === "timed_out" || TIMEOUT_CODES.has(code) || /timed out|time(d)? ?out/.test(text)) return "timed_out";
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

export function budgetTarget(facts: BudgetIncidentFacts): BriefingBudgetTarget {
  return {
    incidentId: facts.incidentId,
    policyId: facts.policyId,
    metric: facts.metric,
    scopeType: facts.scopeType,
    scopeId: facts.scopeId,
    limitCents: Math.round(facts.amountLimit),
    observedCents: Math.round(facts.amountObserved),
    suggestedCents: suggestedBudgetCents(facts.amountLimit, facts.amountObserved),
  };
}

export function raiseBudgetAction(facts: BudgetIncidentFacts): BriefingAction {
  return { kind: "raise_budget", label: "Raise limit", budget: budgetTarget(facts) };
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
    const stops = hosted
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

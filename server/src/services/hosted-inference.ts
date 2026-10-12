/**
 * Hosted inference: the Staples server holds an Anthropic API key, so a new
 * company's Assistant can run on Claude (hosted, Managed Agents) without any
 * setup. Only a boolean leaves this module; the key itself is never returned,
 * logged, or copied into an agent's config (the claude_managed adapter reads
 * the server env itself, and only for the default API base URL).
 */
export const HOSTED_INFERENCE_ADAPTER_TYPE = "claude_managed" as const;
export const HOSTED_INFERENCE_MODEL = "claude-opus-5-5";

export interface HostedInference {
  available: boolean;
  adapterType: typeof HOSTED_INFERENCE_ADAPTER_TYPE;
  model: string;
}

/** Available iff ANTHROPIC_API_KEY is set (non-blank) and STAPLES_HOSTED_INFERENCE is not "off". */
export function hostedInference(env: NodeJS.ProcessEnv = process.env): HostedInference {
  const optedOut = env.STAPLES_HOSTED_INFERENCE?.trim().toLowerCase() === "off";
  return {
    available: !optedOut && Boolean(env.ANTHROPIC_API_KEY?.trim()),
    adapterType: HOSTED_INFERENCE_ADAPTER_TYPE,
    model: HOSTED_INFERENCE_MODEL,
  };
}

/** Operator opt-in: every claude_managed agent may use the server's key, not only the Assistant. */
export function hostedInferenceForAllAgents(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STAPLES_HOSTED_INFERENCE_ALL_AGENTS?.trim().toLowerCase() === "on";
}

const DEFAULT_HOSTED_ASSISTANT_BUDGET_CENTS = 2000;

/**
 * Monthly hard-stop budget for an Assistant provisioned on hosted inference
 * (the operator's key pays). Default $20; `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS`
 * overrides it with an integer >= 0, where an explicit 0 means no cap.
 */
export function hostedAssistantBudgetCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_HOSTED_ASSISTANT_BUDGET_CENTS;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : DEFAULT_HOSTED_ASSISTANT_BUDGET_CENTS;
}

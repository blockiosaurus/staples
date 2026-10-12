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

const DEFAULT_HOSTED_ASSISTANT_BUDGET_CENTS = 2000;
const DEFAULT_HOSTED_AGENT_BUDGET_CENTS = 2000;
const DEFAULT_HOSTED_COMPANY_BUDGET_CENTS = 5000;

/** An integer >= 0 from the env (explicit 0 = no cap), else the default. */
function centsFromEnv(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * Monthly hard-stop budget for an Assistant provisioned on hosted inference
 * (the operator's key pays). Default $20; `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS`
 * overrides it with an integer >= 0, where an explicit 0 means no cap.
 */
export function hostedAssistantBudgetCents(env: NodeJS.ProcessEnv = process.env): number {
  return centsFromEnv(env.STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS, DEFAULT_HOSTED_ASSISTANT_BUDGET_CENTS);
}

/**
 * Monthly hard-stop budget for any other agent on hosted inference (a hire on
 * Claude (hosted) without its own key). Default $20;
 * `STAPLES_HOSTED_AGENT_BUDGET_CENTS` overrides it (explicit 0 = no cap).
 */
export function hostedAgentBudgetCents(env: NodeJS.ProcessEnv = process.env): number {
  return centsFromEnv(env.STAPLES_HOSTED_AGENT_BUDGET_CENTS, DEFAULT_HOSTED_AGENT_BUDGET_CENTS);
}

/**
 * Monthly hard-stop budget for a company with any agent on hosted inference.
 * Default $50; `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` overrides it (explicit 0 =
 * no cap). An existing active company budget is never lowered.
 */
export function hostedCompanyBudgetCents(env: NodeJS.ProcessEnv = process.env): number {
  return centsFromEnv(env.STAPLES_HOSTED_COMPANY_BUDGET_CENTS, DEFAULT_HOSTED_COMPANY_BUDGET_CENTS);
}

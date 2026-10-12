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

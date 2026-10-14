import { ADAPTER_AUTH_MISSING_CHECK_CODE, type AdapterEnvironmentTestResult } from "@paperclipai/shared";

export const ASSISTANT_ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  kimi_local: "Kimi",
  claude_managed: "Claude (hosted)",
};

/** Shown while the hosted Assistant finishes provisioning (server message, same copy). */
export const HOSTED_FINISHING_MESSAGE = "Finishing Assistant setup…";

export const HOSTED_TILE_COPY = {
  needsKey: "Runs in Anthropic's cloud. Needs an Anthropic key.",
  provided: "Provided by this Staples server.",
} as const;

/** Adapters whose CLI engine still carries the Assistant's tools (server: ASSISTANT_CLI_ENGINE_ADAPTER_TYPES). */
export const ASSISTANT_CLI_ENGINE_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local"];

/**
 * Fixed copy for a failed connection test, from check codes only (check
 * messages can carry provider details). Mirrors the server's
 * `harnessFailureReason`.
 */
/** The Node version each adapter's ACP engine needs (Kimi's is lower). Mirrors the server. */
const ACP_NODE_MINIMUM: Record<string, string> = { kimi_local: "20" };
const acpNodeMinimum = (adapterType: string) => ACP_NODE_MINIMUM[adapterType] ?? "24.11";

export function connectionFailureReason(adapterType: string, codes: readonly string[]): string {
  const label = ASSISTANT_ADAPTER_LABELS[adapterType] ?? "The model";
  if (codes.includes("claude_managed_api_key_missing")) return "Add an Anthropic key to use Claude (hosted).";
  if (codes.some((code) => code === "claude_managed_auth_invalid" || code === "claude_managed_access_denied")) {
    return "That Anthropic key was rejected.";
  }
  if (codes.includes("assistant_provisioning_incomplete")) return "The Assistant's setup didn't finish. Try again.";
  if (codes.some((code) => code === ADAPTER_AUTH_MISSING_CHECK_CODE || /_auth_required$/.test(code))) {
    return `${label} isn't signed in on this computer.`;
  }
  if (codes.some((code) => /_command_unresolvable$/.test(code))) return `${label} isn't installed on this computer.`;
  if (codes.includes("adapter_engine_unavailable")) {
    // The CLI is installed; only its default (ACP) engine can't run here.
    // Node 24.11 is named only when the check says Node is the cause.
    const cliFallback = ASSISTANT_CLI_ENGINE_ADAPTER_TYPES.includes(adapterType);
    if (codes.includes("adapter_engine_node_unsupported")) {
      return cliFallback
        ? `${label} is installed, but it needs Node ${acpNodeMinimum(adapterType)} or newer here. Pick another option to continue.`
        : `${label} is installed, but it needs Node ${acpNodeMinimum(adapterType)} or newer on this computer to run the Assistant.`;
    }
    return cliFallback
      ? `${label} is installed, but it can't run here. Pick another option to continue.`
      : `${label} is installed, but it can't run here.`;
  }
  if (codes.some((code) => /_usage_limited$/.test(code))) return `${label} has reached its usage limit.`;
  if (codes.some((code) => /_timed_out$|_timeout$/.test(code))) return `${label} didn't answer in time.`;
  return `${label} didn't pass its connection test.`;
}

/** A full connection test passed: no failure and a successful hello probe. */
export function connectionTestPassed(result: AdapterEnvironmentTestResult): boolean {
  return result.status !== "fail"
    && !result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE || /_auth_required$/.test(check.code))
    && result.checks.some((check) => /hello_probe_(passed|succeeded)$/.test(check.code));
}

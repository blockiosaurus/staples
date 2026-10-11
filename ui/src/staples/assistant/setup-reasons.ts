import { ADAPTER_AUTH_MISSING_CHECK_CODE, type AdapterEnvironmentTestResult } from "@paperclipai/shared";

export const ASSISTANT_ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  kimi_local: "Kimi",
};

/** Adapters whose CLI engine still carries the Assistant's tools (server: ASSISTANT_CLI_ENGINE_ADAPTER_TYPES). */
export const ASSISTANT_CLI_ENGINE_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local"];

/**
 * Fixed copy for a failed connection test, from check codes only (check
 * messages can carry provider details). Mirrors the server's
 * `harnessFailureReason`.
 */
export function connectionFailureReason(adapterType: string, codes: readonly string[]): string {
  const label = ASSISTANT_ADAPTER_LABELS[adapterType] ?? "The model";
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
        ? `${label} is installed, but its default engine needs Node 24.11 or newer. Pick ${label} below to connect it on its CLI engine instead.`
        : `${label} is installed, but it needs Node 24.11 or newer on this computer to run the Assistant.`;
    }
    return cliFallback
      ? `${label} is installed, but its default engine isn't available here. Pick ${label} below to connect it on its CLI engine instead.`
      : `${label} is installed, but its default engine isn't available here.`;
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

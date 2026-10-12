import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ManagedAgentsApiError, ManagedAgentsClient } from "../client.js";
import { HOSTED_KEY_WITHHELD_MESSAGE, hostedKeyWithheld, resolveApiBaseUrl, resolveApiKey, usesDefaultApiBaseUrl } from "./execute.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TestEnvironmentDeps {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

/** Maps a failed probe to a plain-language check. Never includes the key. */
export function checkForProbeError(error: unknown): AdapterEnvironmentCheck {
  if (error instanceof ManagedAgentsApiError) {
    if (error.status === 401) {
      return {
        code: "claude_managed_auth_invalid",
        level: "error",
        message: "Anthropic rejected the API key.",
        hint: "Check that ANTHROPIC_API_KEY is a current key from the Claude Console.",
      };
    }
    if (error.status === 403) {
      return {
        code: "claude_managed_access_denied",
        level: "error",
        message: "The API key works, but it does not have access to Managed Agents.",
        hint: "Managed Agents is in beta. Make sure your organization has access, or use a key from an organization that does.",
      };
    }
    if (error.status === 429) {
      return {
        code: "claude_managed_rate_limited",
        level: "warn",
        message: "Anthropic is rate limiting this key right now. The key looks valid; try again in a minute.",
      };
    }
    if (error.status === 0 || error.errorType === "connection_error") {
      return {
        code: "claude_managed_unreachable",
        level: "error",
        message: "Could not reach the Anthropic API from the Staples server.",
        hint: "Check the server's internet access and the configured API base URL.",
      };
    }
    if (error.status >= 500) {
      return {
        code: "claude_managed_upstream_error",
        level: "warn",
        message: `The Anthropic API returned a server error (${error.status}). Try again shortly.`,
      };
    }
    return {
      code: "claude_managed_probe_failed",
      level: "error",
      message: `The Anthropic API refused the check request (${error.status}).`,
      detail: error.message,
    };
  }
  return {
    code: "claude_managed_unreachable",
    level: "error",
    message: "Could not reach the Anthropic API from the Staples server.",
    hint: "Check the server's internet access and the configured API base URL.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: TestEnvironmentDeps = {},
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = deps.env ?? process.env;
  const serverKeyAllowed = ctx.hostedInferenceAllowed === true;
  const key = resolveApiKey(config, env, { serverKeyAllowed });

  if (!key) {
    const serverKeyWithheld = hostedKeyWithheld(config, env, { serverKeyAllowed });
    checks.push(serverKeyWithheld
      ? {
          code: "claude_managed_api_key_missing",
          level: "error",
          message: HOSTED_KEY_WITHHELD_MESSAGE,
          hint: "Add ANTHROPIC_API_KEY to this agent's environment variables (a company secret works).",
        }
      : usesDefaultApiBaseUrl(config)
      ? {
          code: "claude_managed_api_key_missing",
          level: "error",
          message: "No Anthropic API key is set.",
          hint: "Add ANTHROPIC_API_KEY to this agent's environment variables (a company secret works), or set it on the Staples server.",
        }
      : {
          code: "claude_managed_api_key_missing",
          level: "error",
          message: "This agent uses a custom API base URL, so it needs its own Anthropic API key.",
          hint: "Add ANTHROPIC_API_KEY to this agent's environment variables (a company secret works). The Staples server's key is only sent to the default Anthropic API.",
        });
  } else {
    checks.push({
      code: "claude_managed_api_key_present",
      level: "info",
      message: key.source === "adapter_config"
        ? "An Anthropic API key is set for this agent."
        : key.source === "hosted_inference"
        ? "Using the Staples server's hosted-inference key, under its spending caps."
        : "Using the Anthropic API key from the Staples server environment.",
    });
    try {
      const client = new ManagedAgentsClient({ apiKey: key.apiKey, baseUrl: resolveApiBaseUrl(config), fetch: deps.fetch, maxRetries: 0 });
      await client.listAgents({ limit: 1 }, { signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000), retry: "none" });
      checks.push({
        code: "claude_managed_auth_ok",
        level: "info",
        message: "Connected to Claude Managed Agents.",
      });
    } catch (error) {
      checks.push(checkForProbeError(error));
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarize(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

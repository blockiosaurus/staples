import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents, type Db } from "@paperclipai/db";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, aiRuntimeConnectionBindingSchema, type AgentLifecycleHarnessTest } from "@paperclipai/shared";
import { ASSISTANT_RUNTIME_ADAPTER_TYPES } from "./assistant-identity.js";

export type AssistantSetupState = "ready" | "starting" | "needs_model" | "error";

export interface AssistantSetupStatus {
  state: AssistantSetupState;
  message?: string;
  /** Fixed copy derived from the last failed harness test's check codes. */
  reason?: string;
  adapterType: string;
}

/**
 * Runtime adapters whose CLI engine still delivers the Assistant's tools
 * (`ctx.runtimeMcp`). Gemini and Kimi only do so on their ACP engine, so a
 * missing ACP prerequisite there is not fixed by switching engines.
 */
export const ASSISTANT_CLI_ENGINE_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local"];

export interface AssistantLifecycleView {
  adapterType: string;
  lifecycleState: string;
  lifecycleVersion: number;
  lifecycleError: string | null;
  lifecycleHolds?: readonly string[] | null;
  lifecycleOperation?: unknown;
}

const SETTING_UP_STATES = new Set(["preparing", "verifying", "resuming"]);

/** A failed check a person fixes by connecting (or installing) a model. */
export function isNeedsModelCheck(code: string): boolean {
  return code === ADAPTER_AUTH_MISSING_CHECK_CODE
    || code === "adapter_engine_unavailable"
    || /_auth_required$/.test(code)
    || /_command_unresolvable$/.test(code);
}

function lastHarnessTest(agent: Pick<AssistantLifecycleView, "lifecycleOperation">): AgentLifecycleHarnessTest | null {
  const operation = agent.lifecycleOperation;
  if (!operation || typeof operation !== "object") return null;
  const test = (operation as { lastHarnessTest?: unknown }).lastHarnessTest;
  if (!test || typeof test !== "object") return null;
  const candidate = test as Partial<AgentLifecycleHarnessTest>;
  if (typeof candidate.version !== "number" || typeof candidate.adapterType !== "string" || !Array.isArray(candidate.checks)) return null;
  return candidate as AgentLifecycleHarnessTest;
}

export const HARNESS_FAILED_MESSAGE = "The model couldn't be reached. Connect a model to continue.";

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  kimi_local: "Kimi",
};
function adapterLabel(adapterType: string) {
  return ADAPTER_LABELS[adapterType] ?? "The model";
}

/**
 * Fixed copy for why the last harness test failed, from its check codes only
 * (check messages can carry provider details and are never shown here).
 */
export function harnessFailureReason(adapterType: string, codes: readonly string[]): string {
  const label = adapterLabel(adapterType);
  if (codes.some((code) => code === ADAPTER_AUTH_MISSING_CHECK_CODE || /_auth_required$/.test(code))) {
    return `${label} isn't signed in on this computer.`;
  }
  if (codes.some((code) => /_command_unresolvable$/.test(code))) return `${label} isn't installed on this computer.`;
  if (codes.includes("adapter_engine_unavailable")) return `${label}'s engine isn't available on this computer.`;
  if (codes.some((code) => /_usage_limited$/.test(code))) return `${label} has reached its usage limit.`;
  if (codes.some((code) => /_timed_out$|_timeout$/.test(code))) return `${label} didn't answer in time.`;
  return `${label} didn't pass its connection test.`;
}

/**
 * Whether the Assistant can answer yet, from its lifecycle. A harness test
 * failure only counts when it was recorded for the current lifecycle version
 * and adapter (an older record describes an older config). Auth, install and
 * engine failures mean "connect a model"; other harness failures are errors
 * with fixed copy; anything else keeps the lifecycle message.
 */
export function assistantSetupStatus(agent: AssistantLifecycleView): AssistantSetupStatus {
  const adapterType = agent.adapterType;
  if (!(ASSISTANT_RUNTIME_ADAPTER_TYPES as readonly string[]).includes(adapterType)) {
    return { state: "needs_model", adapterType };
  }
  if (agent.lifecycleState === "ready") return { state: "ready", adapterType };
  const holds = agent.lifecycleHolds ?? [];
  if (SETTING_UP_STATES.has(agent.lifecycleState) && holds.length === 0) {
    if (!agent.lifecycleError) return { state: "starting", adapterType };
    const test = lastHarnessTest(agent);
    if (test && test.version === agent.lifecycleVersion && test.adapterType === adapterType) {
      const codes = test.checks.map((check) => check.code);
      const reason = harnessFailureReason(adapterType, codes);
      if (codes.some((code) => isNeedsModelCheck(code))) return { state: "needs_model", adapterType, reason };
      return { state: "error", adapterType, message: HARNESS_FAILED_MESSAGE, reason };
    }
    return { state: "error", adapterType, message: agent.lifecycleError };
  }
  return {
    state: "error",
    adapterType,
    message: agent.lifecycleError ?? (holds.length > 0 || agent.lifecycleState === "paused"
      ? "The Assistant is paused."
      : "The Assistant is not available."),
  };
}

/**
 * The engine to configure on setup. An explicit choice wins; otherwise the
 * CLI engine when the Assistant's last harness test on this adapter found the
 * ACP prerequisites missing (host-level, so the record's version is not
 * compared) and the adapter's CLI engine still carries the Assistant's tools.
 */
export function resolveAssistantSetupEngine(
  agent: Pick<AssistantLifecycleView, "lifecycleOperation">,
  adapterType: string,
  requestedEngine: string | undefined,
): string | undefined {
  if (requestedEngine) return requestedEngine;
  if (!ASSISTANT_CLI_ENGINE_ADAPTER_TYPES.includes(adapterType)) return undefined;
  const test = lastHarnessTest(agent);
  if (test?.adapterType === adapterType && test.checks.some((check) => check.code === "adapter_engine_unavailable")) return "cli";
  return undefined;
}

/** The Assistant's lifecycle fields, including the operation the agent records omit. */
export async function readAssistantLifecycle(db: Pick<Db, "select">, agentId: string): Promise<AssistantLifecycleView | null> {
  const [row] = await db.select({
    adapterType: agents.adapterType,
    lifecycleState: agents.lifecycleState,
    lifecycleVersion: agents.lifecycleVersion,
    lifecycleError: agents.lifecycleError,
    lifecycleHolds: agents.lifecycleHolds,
    lifecycleOperation: agents.lifecycleOperation,
  }).from(agents).where(eq(agents.id, agentId));
  return row ?? null;
}

export const assistantSetupRequestSchema = z.object({
  adapterType: z.enum(ASSISTANT_RUNTIME_ADAPTER_TYPES),
  /** Only what connecting a model needs; everything else stays server-owned. */
  adapterConfig: z.object({
    model: z.string().trim().min(1).optional(),
    engine: z.enum(["cli", "acp"]).optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
  aiConnection: aiRuntimeConnectionBindingSchema.optional(),
  applyStoredClaudeLogin: z.boolean().optional(),
}).strict();
export type AssistantSetupRequest = z.infer<typeof assistantSetupRequestSchema>;

const MIN_ACP_NODE_VERSION = [24, 11, 0] as const;
export function nodeMeetsAcpMinimum(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = MIN_ACP_NODE_VERSION[index]!;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

export interface AssistantAdapterAvailability {
  adapterType: string;
  /** The adapter's CLI command resolves on this host. */
  installed: boolean;
  /** The Assistant can run on it here (installed, with an engine that carries its tools). */
  available: boolean;
  /** The engine setup should use ("cli" when the ACP Node prerequisite is missing), or null for the default. */
  engine: "cli" | null;
  /** Whether a sign-in was found: true, false, or null when it can't be told without a model call. */
  signedIn: boolean | null;
  /** Fixed copy for what to do next. */
  hint?: string;
}

const ADAPTER_COMMANDS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  kimi_local: "kimi",
};

/**
 * Cheap host detection for the Assistant's runtime adapters: command lookup,
 * the ACP Node prerequisite, and host-local sign-in signals. No model calls;
 * the chosen adapter gets the full environment test separately.
 */
export async function assistantAdapterAvailability(deps: {
  nodeVersion: string;
  commandResolvable: (command: string) => Promise<boolean>;
  authSignal: (adapterType: string) => Promise<"present" | "absent" | "unknown">;
  geminiCredentialsPresent: () => Promise<boolean>;
}): Promise<AssistantAdapterAvailability[]> {
  const acp = nodeMeetsAcpMinimum(deps.nodeVersion);
  return Promise.all(ASSISTANT_RUNTIME_ADAPTER_TYPES.map(async (adapterType): Promise<AssistantAdapterAvailability> => {
    const command = ADAPTER_COMMANDS[adapterType]!;
    const installed = await deps.commandResolvable(command).catch(() => false);
    const cliCarriesTools = ASSISTANT_CLI_ENGINE_ADAPTER_TYPES.includes(adapterType);
    const available = installed && (acp || cliCarriesTools);
    const engine = installed && !acp && cliCarriesTools ? "cli" : null;
    if (!installed) {
      return { adapterType, installed, available, engine, signedIn: null, hint: `Not installed: install the ${command} CLI, then check again.` };
    }
    if (!available) {
      return { adapterType, installed, available, engine, signedIn: null, hint: "Needs Node 24.11 or newer on this computer." };
    }
    if (adapterType === "claude_local") {
      // The connect step handles Claude sign-in; only a stored login is detectable here.
      const signal = await deps.authSignal(adapterType).catch(() => "unknown" as const);
      return { adapterType, installed, available, engine, signedIn: signal === "present" ? true : null };
    }
    if (adapterType === "codex_local") {
      const signal = await deps.authSignal(adapterType).catch(() => "unknown" as const);
      const signedIn = signal === "present" ? true : signal === "absent" ? false : null;
      return {
        adapterType, installed, available, engine, signedIn,
        ...(signedIn ? {} : { hint: "Sign in needed: run `codex login` in a terminal once, or connect an API key." }),
      };
    }
    const signedIn = adapterType === "gemini_local" && await deps.geminiCredentialsPresent().catch(() => false) ? true : null;
    return {
      adapterType, installed, available, engine, signedIn,
      ...(signedIn ? {} : { hint: `Sign in needed: run \`${command}\` in a terminal once and log in, then check again.` }),
    };
  }));
}

/** Gemini CLI's own sign-in: an API key in the server env or its OAuth credentials file. */
export async function geminiCredentialsPresent(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()) return true;
  const home = env.GEMINI_CLI_HOME?.trim() || os.homedir();
  return fs.access(path.join(home, ".gemini", "oauth_creds.json")).then(() => true, () => false);
}

/** Whether this board actor may connect a model for the Assistant (owners/admins/operators/members, not viewers). */
export function canConfigureAssistant(actor: Request["actor"], companyId: string): boolean {
  if (!actor || actor.type !== "board") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  const membership = actor.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return Boolean(membership) && membership!.membershipRole !== "viewer";
}

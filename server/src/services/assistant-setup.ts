import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents, type Db } from "@paperclipai/db";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, aiRuntimeConnectionBindingSchema, type AgentLifecycleHarnessTest } from "@paperclipai/shared";
import { ASSISTANT_RUNTIME_ADAPTER_TYPES } from "./assistant-identity.js";

export type AssistantSetupState = "ready" | "starting" | "needs_model" | "error";

export interface AssistantSetupStatus {
  state: AssistantSetupState;
  message?: string;
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

/**
 * Whether the Assistant can answer yet, from its lifecycle. A harness test
 * failure only counts as "needs a model" when it was recorded for the current
 * lifecycle version and adapter (an older record describes an older config).
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
    if (test && test.version === agent.lifecycleVersion && test.adapterType === adapterType
      && test.checks.some((check) => isNeedsModelCheck(check.code))) {
      return { state: "needs_model", adapterType };
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

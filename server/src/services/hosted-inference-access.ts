import { and, eq } from "drizzle-orm";
import { agents, budgetPolicies, companySecrets, type Db } from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
import { budgetService } from "./budgets.js";
import {
  HOSTED_INFERENCE_ADAPTER_TYPE,
  HOSTED_INFERENCE_MODEL,
  hostedAgentBudgetCents,
  hostedAssistantBudgetCents,
  hostedCompanyBudgetCents,
  hostedInference,
} from "./hosted-inference.js";
import { PROPOSABLE_HIRE_ADAPTER_TYPES, isProvisionedAssistant, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { hasAnthropicKeyBinding } from "./assistant-setup.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";

type BudgetScope = { scopeType: "agent" | "company"; scopeId: string };

/**
 * Ensure an ACTIVE hard-stop monthly `billed_cents` policy on one scope.
 * Idempotent: an existing active hard-stop policy with a positive amount is
 * kept as is (never lowered, never raised); a disabled, soft or zeroed one is
 * re-activated as a hard stop with its positive amount, else `cents`.
 * `cents` 0 means uncapped (nothing is written).
 */
async function ensureHardStopMonthlyPolicy(db: Db, companyId: string, scope: BudgetScope, cents: number): Promise<void> {
  if (cents === 0) return;
  const attempt = async () => {
    const [existing] = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId),
      eq(budgetPolicies.scopeType, scope.scopeType),
      eq(budgetPolicies.scopeId, scope.scopeId),
      eq(budgetPolicies.metric, "billed_cents"),
      eq(budgetPolicies.windowKind, "calendar_month_utc"),
    ));
    if (existing && existing.isActive && existing.hardStopEnabled && existing.amount > 0) return;
    await budgetService(db).upsertPolicy(companyId, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: existing && existing.amount > 0 ? existing.amount : cents,
      hardStopEnabled: true,
      isActive: true,
    }, null);
  };
  try {
    await attempt();
  } catch {
    // A concurrent first run may have inserted the same policy: check again once.
    await attempt();
  }
}

/**
 * An agent on hosted inference spends the operator's key, so before that key
 * is used it must carry an ACTIVE hard-stop monthly budget, and so must its
 * company. Agent cap: the Assistant's `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS`
 * (default $20) or, for any other agent, `STAPLES_HOSTED_AGENT_BUDGET_CENTS`
 * (default $20). Company cap: `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` (default
 * $50); an existing active company budget is kept, never lowered. An explicit
 * 0 in an env var leaves that scope uncapped. Disabled or deleted policies are
 * re-activated or recreated. Throws when a policy cannot be ensured.
 */
export async function ensureHostedAgentBudgets(
  db: Db,
  agent: { id: string; companyId: string },
  env: NodeJS.ProcessEnv = process.env,
  options: { assistant?: boolean } = {},
): Promise<void> {
  // An unsaved agent (an environment test before create) has no agent scope yet.
  if (agent.id) {
    const assistant = options.assistant ?? await isProvisionedAssistant(db, agent);
    await ensureHardStopMonthlyPolicy(db, agent.companyId, { scopeType: "agent", scopeId: agent.id },
      assistant ? hostedAssistantBudgetCents(env) : hostedAgentBudgetCents(env));
  }
  await ensureHardStopMonthlyPolicy(db, agent.companyId, { scopeType: "company", scopeId: agent.companyId },
    hostedCompanyBudgetCents(env));
}

/** The provisioned Assistant's hosted budgets (agent and company scope). */
export async function ensureHostedAssistantBudget(
  db: Db,
  agent: { id: string; companyId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await ensureHostedAgentBudgets(db, agent, env, { assistant: true });
}

/**
 * Whether this agent may use the server's key (the adapter's server-owned
 * `hostedInferenceAllowed` context field). Decided here only, never from
 * agent config: hosted inference must be available and the agent must be on
 * the hosted adapter without its own key. The key is only granted once the
 * agent's and its company's hard-stop budgets are ensured; if that fails the
 * key is withheld (false) and a warning is logged.
 */
export async function hostedInferenceAllowedFor(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string; adapterConfig?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  deps: { ensureBudget?: typeof ensureHostedAgentBudgets } = {},
): Promise<boolean> {
  if (agent.adapterType !== HOSTED_INFERENCE_ADAPTER_TYPE) return false;
  if (!hostedInference(env).available) return false;
  // Its own key is used first; the server's key is not needed.
  if (agent.adapterConfig !== undefined && hasAnthropicKeyBinding(agent.adapterConfig)) return false;
  try {
    await (deps.ensureBudget ?? ensureHostedAgentBudgets)(db, agent, env);
  } catch (error) {
    logger.warn({ err: error, companyId: agent.companyId, agentId: agent.id },
      "Hosted inference withheld: the hard-stop budgets could not be ensured");
    return false;
  }
  return true;
}

/** The company secret an env binding references, when it is a `secret_ref`. */
function anthropicKeySecretRef(adapterConfig: unknown): { type: "secret_ref"; secretId: string; version?: unknown } | null {
  const env = adapterConfig && typeof adapterConfig === "object" ? (adapterConfig as { env?: unknown }).env : null;
  const binding = env && typeof env === "object" ? (env as Record<string, unknown>).ANTHROPIC_API_KEY : null;
  if (!binding || typeof binding !== "object") return null;
  const record = binding as Record<string, unknown>;
  if (record.type !== "secret_ref" || typeof record.secretId !== "string" || !record.secretId) return null;
  return { type: "secret_ref", secretId: record.secretId, ...(record.version !== undefined ? { version: record.version } : {}) };
}

export interface HostedHireOptions {
  /** Hosted inference is available on this server (the operator's key, capped). */
  hostedInference: boolean;
  /**
   * The company's own Anthropic key for Claude (hosted) hires: the Assistant's
   * bound company secret, when the Assistant runs on claude_managed and the
   * secret is still active in this company. Hires inherit this binding.
   */
  companyKeyBinding: { type: "secret_ref"; secretId: string; version?: unknown } | null;
  /** The model the Assistant runs on, when it is on claude_managed. */
  assistantModel: string | null;
  /** Adapters the Assistant may propose for hires in this company. */
  hireAdapterTypes: string[];
}

/**
 * Which adapters a hire may use in this company. `claude_managed` (Claude
 * hosted) is proposable only when hosted inference is available, or when the
 * company's Assistant runs on it with its own usable company-secret key.
 */
export async function hostedHireOptions(
  db: Db, companyId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<HostedHireOptions> {
  const hosted = hostedInference(env).available;
  let companyKeyBinding: HostedHireOptions["companyKeyBinding"] = null;
  let assistantModel: string | null = null;
  const assistantId = await resolveCompanyAssistantAgentId(db, companyId);
  if (assistantId) {
    const [row] = await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents).where(and(eq(agents.id, assistantId), eq(agents.companyId, companyId)));
    if (row?.adapterType === HOSTED_INFERENCE_ADAPTER_TYPE) {
      const model = (row.adapterConfig as Record<string, unknown> | null)?.model;
      if (typeof model === "string" && model.trim()) assistantModel = model.trim();
      const ref = anthropicKeySecretRef(row.adapterConfig);
      if (ref) {
        const [secret] = await db.select({ companyId: companySecrets.companyId, status: companySecrets.status })
          .from(companySecrets).where(eq(companySecrets.id, ref.secretId));
        if (secret && secret.companyId === companyId && secret.status === "active") companyKeyBinding = ref;
      }
    }
  }
  const hireAdapterTypes: string[] = [...PROPOSABLE_HIRE_ADAPTER_TYPES];
  if (hosted || companyKeyBinding) hireAdapterTypes.push(HOSTED_INFERENCE_ADAPTER_TYPE);
  return { hostedInference: hosted, companyKeyBinding, assistantModel, hireAdapterTypes };
}

/** The adapterConfig a Claude (hosted) hire gets: a model, and the company's key binding when it has one. */
export function hostedHireAdapterConfig(options: Pick<HostedHireOptions, "companyKeyBinding" | "assistantModel">): Record<string, unknown> {
  return {
    model: options.assistantModel ?? HOSTED_INFERENCE_MODEL,
    ...(options.companyKeyBinding ? { env: { ANTHROPIC_API_KEY: { ...options.companyKeyBinding } } } : {}),
  };
}

/**
 * A new hosted Assistant is verified as soon as it is created, which can be
 * before its provisioning record (the managed instructions binding) exists.
 * Verification waits (the lifecycle sweep retries) instead of testing it
 * without the server key and recording a false "needs a key".
 */
export async function hostedAssistantProvisioningPending(
  db: Pick<Db, "select">,
  agent: { companyId: string; adapterType: string; metadata?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (agent.adapterType !== HOSTED_INFERENCE_ADAPTER_TYPE || !hostedInference(env).available) return false;
  if (readBuiltInAgentMarker(agent.metadata as Record<string, unknown> | null | undefined)?.key !== ASSISTANT_BUILT_IN_AGENT_KEY) return false;
  return (await resolveCompanyAssistantAgentId(db, agent.companyId)) === null;
}

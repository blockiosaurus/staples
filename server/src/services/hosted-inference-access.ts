import { and, eq, ne } from "drizzle-orm";
import { agents, budgetPolicies, companySecrets, type Db } from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY, type ApplyPlan, type ApplyPlanResult, type PlanBudgetSummary } from "@paperclipai/shared";
import { HOSTED_BILLED_CENTS_METRIC, budgetService } from "./budgets.js";
import { isUniqueViolation } from "../db-errors.js";
import {
  HOSTED_INFERENCE_ADAPTER_TYPE,
  HOSTED_INFERENCE_MODEL,
  hostedAgentBudgetCents,
  hostedAssistantBudgetCents,
  hostedCompanyBudgetCeilingCents,
  hostedCompanyBudgetCents,
  hostedInference,
  usesHostedInferenceKey,
} from "./hosted-inference.js";
import { PROPOSABLE_HIRE_ADAPTER_TYPES, isProvisionedAssistant, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";

type BudgetScope = { scopeType: "agent" | "company"; scopeId: string };
type HostedPolicyMetric = "billed_cents" | typeof HOSTED_BILLED_CENTS_METRIC;

/** Activity-log actor for the policies the server creates for hosted inference. */
const HOSTED_INFERENCE_ACTOR = { actorType: "system", actorId: "hosted_inference" } as const;

/**
 * Ensure an ACTIVE hard-stop monthly policy on one scope and metric.
 * Idempotent: an existing active hard-stop policy with a positive amount is
 * kept as is (never lowered, never raised); a disabled, soft or zeroed one is
 * re-activated as a hard stop with its positive amount, else `cents`.
 * `cents` 0 means uncapped (nothing is written). The write is recorded in the
 * activity log with a system actor.
 */
async function ensureHardStopMonthlyPolicy(db: Db, companyId: string, scope: BudgetScope, metric: HostedPolicyMetric, cents: number): Promise<void> {
  if (cents === 0) return;
  const attempt = async () => {
    const [existing] = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId),
      eq(budgetPolicies.scopeType, scope.scopeType),
      eq(budgetPolicies.scopeId, scope.scopeId),
      eq(budgetPolicies.metric, metric),
      eq(budgetPolicies.windowKind, "calendar_month_utc"),
    ));
    if (existing && existing.isActive && existing.hardStopEnabled && existing.amount > 0) return;
    await budgetService(db).upsertPolicy(companyId, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      metric,
      windowKind: "calendar_month_utc",
      amount: existing && existing.amount > 0 ? existing.amount : cents,
      hardStopEnabled: true,
      isActive: true,
    }, null, { actor: HOSTED_INFERENCE_ACTOR });
  };
  try {
    await attempt();
  } catch (error) {
    // Only the race with a concurrent first run inserting the same policy is
    // retried (once, which then finds and keeps that policy).
    if (!isUniqueViolation(error)) throw error;
    await attempt();
  }
}

/**
 * An agent on hosted inference spends the operator's key, so before that key
 * is used it must carry an ACTIVE hard-stop monthly budget, and so must its
 * company's hosted spend. Agent cap (`billed_cents`): the agent's own monthly
 * budget when it has one, else the Assistant's
 * `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS` (default $20) or, for any other
 * agent, `STAPLES_HOSTED_AGENT_BUDGET_CENTS` (default $20). Company cap
 * (`hosted_billed_cents`, counting only spend billed to the hosted key):
 * `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` (default $50); an existing active
 * hosted company cap is kept, never lowered. A person-set company budget
 * (`billed_cents`) is never touched. An explicit 0 in an env var leaves that
 * scope uncapped. Disabled or deleted policies are re-activated or recreated.
 * Throws when a policy cannot be ensured.
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
    const fallback = assistant ? hostedAssistantBudgetCents(env) : hostedAgentBudgetCents(env);
    // A new cap takes the agent's own monthly budget (e.g. the one its plan
    // set) when it has one; an explicit 0 default still leaves it uncapped.
    let cents = fallback;
    if (fallback > 0) {
      const [row] = await db.select({ budgetMonthlyCents: agents.budgetMonthlyCents }).from(agents)
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)));
      if (row && row.budgetMonthlyCents > 0) cents = row.budgetMonthlyCents;
    }
    await ensureHardStopMonthlyPolicy(db, agent.companyId, { scopeType: "agent", scopeId: agent.id }, "billed_cents", cents);
  }
  await ensureHardStopMonthlyPolicy(db, agent.companyId, { scopeType: "company", scopeId: agent.companyId }, HOSTED_BILLED_CENTS_METRIC,
    hostedCompanyBudgetCents(env));
}

/**
 * An agent's monthly budget as counted toward the company's hosted cap: its
 * own positive budget, else the hosted default the server gives it (an
 * explicit 0 default, uncapped, counts as 0).
 */
export function hostedAgentMonthlyCents(
  budgetMonthlyCents: number | null | undefined, assistant: boolean, env: NodeJS.ProcessEnv = process.env,
): number {
  if (budgetMonthlyCents && budgetMonthlyCents > 0) return budgetMonthlyCents;
  return assistant ? hostedAssistantBudgetCents(env) : hostedAgentBudgetCents(env);
}

/**
 * The company's hosted cap after a plan's raise: at least what the agents on
 * the hosted key need, at most the operator's ceiling, and never below the
 * cap it has now.
 */
export function hostedCapAfterRaise(input: { currentCents: number; neededCents: number; ceilingCents: number }): number {
  return Math.max(input.currentCents, Math.min(input.neededCents, input.ceilingCents));
}

/** The monthly budgets of every agent in the company that runs on the hosted key. */
export async function hostedAgentsMonthlyCents(db: Db, companyId: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!hostedInference(env).available) return 0;
  const rows = await db.select({
    id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, budgetMonthlyCents: agents.budgetMonthlyCents,
  }).from(agents).where(and(
    eq(agents.companyId, companyId), eq(agents.adapterType, HOSTED_INFERENCE_ADAPTER_TYPE), ne(agents.status, "terminated"),
  ));
  const hostedRows = rows.filter((row) => usesHostedInferenceKey(row, env));
  if (!hostedRows.length) return 0;
  const assistantId = await resolveCompanyAssistantAgentId(db, companyId);
  return hostedRows.reduce((sum, row) => sum + hostedAgentMonthlyCents(row.budgetMonthlyCents, row.id === assistantId, env), 0);
}

async function hostedCompanyCapPolicy(db: Db, companyId: string) {
  const [row] = await db.select().from(budgetPolicies).where(and(
    eq(budgetPolicies.companyId, companyId),
    eq(budgetPolicies.scopeType, "company"),
    eq(budgetPolicies.scopeId, companyId),
    eq(budgetPolicies.metric, HOSTED_BILLED_CENTS_METRIC),
    eq(budgetPolicies.windowKind, "calendar_month_utc"),
  ));
  return row ?? null;
}

/**
 * The company's hosted cap as it is (or will be once ensured): its policy's
 * positive amount, else the server default. Null when the operator left
 * company hosted spend uncapped (`STAPLES_HOSTED_COMPANY_BUDGET_CENTS=0`):
 * such a company's hosted cap is never raised or changed by a plan.
 */
export async function currentHostedCompanyCapCents(db: Db, companyId: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const fallback = hostedCompanyBudgetCents(env);
  if (fallback === 0) return null;
  const policy = await hostedCompanyCapPolicy(db, companyId);
  return policy && policy.amount > 0 ? policy.amount : fallback;
}

/** Whether a plan hire will run on the hosted key (Claude (hosted), no company key, hosted inference on). */
export function planHireUsesHostedKey(
  agent: { adapterType?: string }, options: Pick<HostedHireOptions, "hostedInference" | "companyKeyBinding">,
): boolean {
  return agent.adapterType === HOSTED_INFERENCE_ADAPTER_TYPE && options.hostedInference && !options.companyKeyBinding;
}

/**
 * The plan card's budget line, computed from the database when the plan is
 * proposed (display only; apply decides for itself). Null for a plan with no
 * new agents.
 */
export async function planBudgetSummary(
  db: Db, companyId: string, plan: Pick<ApplyPlan, "agents">, env: NodeJS.ProcessEnv = process.env,
): Promise<PlanBudgetSummary | null> {
  if (!plan.agents.length) return null;
  const options = await hostedHireOptions(db, companyId, env);
  const onHostedKey = (agent: ApplyPlan["agents"][number]) => planHireUsesHostedKey(agent, options);
  const hireCents = (agent: ApplyPlan["agents"][number]) => onHostedKey(agent)
    ? hostedAgentMonthlyCents(agent.budgetMonthlyCents, false, env)
    : agent.budgetMonthlyCents ?? 0;
  const hiresMonthlyCents = plan.agents.reduce((sum, agent) => sum + hireCents(agent), 0);
  const ceilingCents = hostedCompanyBudgetCeilingCents(env);
  const none = { hiresMonthlyCents, hostedCapCents: null, hostedNeededCents: null, hostedCapAfterCents: null, ceilingCents };
  const hostedHires = plan.agents.filter(onHostedKey);
  if (!hostedHires.length) return none;
  const currentCents = await currentHostedCompanyCapCents(db, companyId, env);
  if (currentCents === null) return none;
  const neededCents = await hostedAgentsMonthlyCents(db, companyId, env)
    + hostedHires.reduce((sum, agent) => sum + hireCents(agent), 0);
  return {
    hiresMonthlyCents,
    hostedCapCents: currentCents,
    hostedNeededCents: neededCents,
    hostedCapAfterCents: hostedCapAfterRaise({ currentCents, neededCents, ceilingCents }),
    ceilingCents,
  };
}

/**
 * After a plan hires agents on the hosted key: raise the company's hosted cap
 * (`hosted_billed_cents`) to at least the monthly budgets of every agent on
 * the hosted key, at most the operator's ceiling
 * (`STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS`, default $200). Raise only: a cap
 * is never lowered, and an uncapped company (default 0) is left alone. The
 * write is logged with the hosted-inference system actor. Returns what
 * happened when the cap was raised or could not be raised far enough, else
 * null (the budgets already fit).
 */
export async function raiseHostedCompanyCapForHires(
  db: Db, companyId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<NonNullable<ApplyPlanResult["hostedLimit"]> | null> {
  const ceilingCents = hostedCompanyBudgetCeilingCents(env);
  const attempt = async () => {
    const fromCents = await currentHostedCompanyCapCents(db, companyId, env);
    if (fromCents === null) return null;
    const neededCents = await hostedAgentsMonthlyCents(db, companyId, env);
    const toCents = hostedCapAfterRaise({ currentCents: fromCents, neededCents, ceilingCents });
    if (toCents > fromCents) {
      await budgetService(db).upsertPolicy(companyId, {
        scopeType: "company",
        scopeId: companyId,
        metric: HOSTED_BILLED_CENTS_METRIC,
        windowKind: "calendar_month_utc",
        amount: toCents,
        hardStopEnabled: true,
        isActive: true,
      }, null, { actor: HOSTED_INFERENCE_ACTOR });
    } else if (neededCents <= fromCents) {
      return null;
    }
    return { fromCents, toCents, neededCents, ceilingCents, limited: neededCents > toCents };
  };
  try {
    return await attempt();
  } catch (error) {
    // Only the race with a first run inserting the same policy is retried.
    if (!isUniqueViolation(error)) throw error;
    return attempt();
  }
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
 * key is withheld (false) and a warning is logged. `probeOnly` (the
 * environment-test route's free list call) skips the ensure and writes nothing.
 */
export async function hostedInferenceAllowedFor(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string; adapterConfig?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  deps: { ensureBudget?: typeof ensureHostedAgentBudgets; probeOnly?: boolean } = {},
): Promise<boolean> {
  // Hosted inference must be on, and the agent on the hosted adapter without
  // its own key (its own key is used first; the server's key is not needed).
  if (!usesHostedInferenceKey(agent, env)) return false;
  // A connection test (one free list call) needs no caps and writes none:
  // testing a draft agent must not create budget policies.
  if (deps.probeOnly) return true;
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

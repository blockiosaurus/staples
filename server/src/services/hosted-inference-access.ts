import { and, eq } from "drizzle-orm";
import { budgetPolicies, type Db } from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
import { budgetService } from "./budgets.js";
import { HOSTED_INFERENCE_ADAPTER_TYPE, hostedAssistantBudgetCents, hostedInference, hostedInferenceForAllAgents } from "./hosted-inference.js";
import { isProvisionedAssistant, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { hasAnthropicKeyBinding } from "./assistant-setup.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";

/**
 * The hosted Assistant runs on the operator's key, so it must carry an ACTIVE
 * hard-stop monthly budget before that key is used. Idempotent: keeps an
 * existing active hard-stop policy, re-activates (or recreates) one that was
 * disabled or deleted. An explicit `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS=0`
 * is the only way to run uncapped. Throws when the policy cannot be ensured.
 */
export async function ensureHostedAssistantBudget(
  db: Db,
  agent: { id: string; companyId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cents = hostedAssistantBudgetCents(env);
  if (cents === 0) return;
  const attempt = async () => {
    const [existing] = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, agent.companyId),
      eq(budgetPolicies.scopeType, "agent"),
      eq(budgetPolicies.scopeId, agent.id),
      eq(budgetPolicies.metric, "billed_cents"),
      eq(budgetPolicies.windowKind, "calendar_month_utc"),
    ));
    if (existing && existing.isActive && existing.hardStopEnabled && existing.amount > 0) return;
    await budgetService(db).upsertPolicy(agent.companyId, {
      scopeType: "agent",
      scopeId: agent.id,
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
 * Whether this agent may use the server's key (the adapter's server-owned
 * `hostedInferenceAllowed` context field). Decided here only, never from
 * agent config: hosted inference must be available, the agent must be on the
 * hosted adapter without its own key, and it must be the company's
 * provisioned Assistant unless the operator opted every agent in. The
 * Assistant only gets the key once its hard-stop budget is ensured; if that
 * fails the key is withheld (false) and a warning is logged.
 */
export async function hostedInferenceAllowedFor(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string; adapterConfig?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  deps: { ensureBudget?: typeof ensureHostedAssistantBudget } = {},
): Promise<boolean> {
  if (agent.adapterType !== HOSTED_INFERENCE_ADAPTER_TYPE) return false;
  if (!hostedInference(env).available) return false;
  // Its own key is used first; the server's key is not needed.
  if (agent.adapterConfig !== undefined && hasAnthropicKeyBinding(agent.adapterConfig)) return false;
  if (await isProvisionedAssistant(db, agent)) {
    try {
      await (deps.ensureBudget ?? ensureHostedAssistantBudget)(db, agent, env);
    } catch (error) {
      logger.warn({ err: error, companyId: agent.companyId, agentId: agent.id },
        "Hosted inference withheld: the Assistant's hard-stop budget could not be ensured");
      return false;
    }
    return true;
  }
  return hostedInferenceForAllAgents(env);
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

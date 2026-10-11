import { logger } from "../middleware/logger.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, deliverBudgetEnforcement, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { deleteAgentDependencies } from "./agent-deletion.js";
import { prepareAgentConfiguration, completeAgentConfiguration } from "./agent-configuration.js";
import { prepareAgentHire, initializeAgentHire, prepareAgentHireApproval, completeAgentHireApproval } from "./agent-hiring.js";
import { trackIdleWork } from "./task-admission.js";

export { scheduleAgentLifecycle } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function createAgentLifecycleEffects(hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    reportFailure(context, error) {
      // Only known codes are safe; provider errors can contain credentials or private data.
      const allowedCodes = new Set(["required_plugin_unavailable", "invalid_lifecycle_result", "harness_test_failed",
        "test_environment_unavailable", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "40001", "40P01", "53300", "57P01"]);
      const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
      const code = [candidate?.code, candidate?.cause?.code].find(value => typeof value === "string" && allowedCodes.has(value));
      logger.warn({ ...context, failureCode: code ?? "unclassified" }, "Agent lifecycle operation failed");
    },
    transaction: withAccountingTransaction,
    deleteDependencies: deleteAgentDependencies,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId, isActive) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive, windowKind: "calendar_month_utc",
      }, userId),
    enforceBudget: (db, companyId, agentId) => deliverBudgetEnforcement(db, hooks, companyId, agentId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    prepareConfiguration: prepareAgentConfiguration,
    completeConfiguration: completeAgentConfiguration,
    prepareHire: prepareAgentHire,
    initializeHire: initializeAgentHire,
    prepareHireApproval: prepareAgentHireApproval,
    completeHireApproval: completeAgentHireApproval,
  };
}

/**
 * A newly active staff agent may be the company's first working adapter; an
 * Assistant that has never run then moves onto it. Best effort: a hire never
 * fails because of the Assistant.
 */
async function reinheritAssistantAfterHire(db: Db, agent: { id: string; companyId: string; adapterType: string; adapterConfig: unknown; metadata: unknown; status: string } | null | undefined) {
  if (!agent || readBuiltInAgentMarker(agent.metadata)) return;
  try {
    // Imported lazily: the built-in service itself hires through this module.
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(db).reinheritAssistantAdapter(agent.companyId, agent);
  } catch (error) {
    logger.warn({ err: error, companyId: agent.companyId, agentId: agent.id }, "Assistant adapter re-inheritance after hire failed");
  }
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}) {
  const base = lifecycle.createAgentLifecycle(db, createAgentLifecycleEffects(hooks));
  return {
    ...base,
    async requestHire(...args: Parameters<typeof base.requestHire>) {
      const agent = await base.requestHire(...args);
      await reinheritAssistantAfterHire(db, agent as Parameters<typeof reinheritAssistantAfterHire>[1]);
      return agent;
    },
    async approveHire(...args: Parameters<typeof base.approveHire>) {
      const result = await base.approveHire(...args);
      if (result?.hireApprovedAgentId) {
        const [approved] = await db.select().from(agents).where(eq(agents.id, result.hireApprovedAgentId));
        await reinheritAssistantAfterHire(db, approved);
      }
      return result;
    },
  };
}

function trackedDriver(driver: lifecycle.LifecycleDriver): lifecycle.LifecycleDriver {
  return { ...driver, runHost: agent => trackIdleWork(driver.runHost(agent)),
    runPlugin: (agent, pluginId) => trackIdleWork(driver.runPlugin(agent, pluginId)) };
}

export function configureAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun = () => true) {
  return lifecycle.configureAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

export function startAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun: () => boolean) {
  return lifecycle.startAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

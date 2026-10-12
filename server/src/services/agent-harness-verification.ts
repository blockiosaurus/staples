import { and, eq, isNotNull, sql } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { isForbiddenConfigEnvKey, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { requireServerAdapter } from "../adapters/index.js";
import { agentEnvironmentTestService } from "./agent-environment-test.js";
import { aiConnectionRouterService } from "./ai-connection-router.js";
import { withManagedAiProbe, stripAiAuthBindings } from "./ai-connection-runtime.js";
import { environmentService } from "./environments.js";
import { secretService } from "./secrets.js";
import { ASSISTANT_PROVISIONING_INCOMPLETE_CHECK_CODE } from "./assistant-setup.js";
import { hostedAssistantProvisioningPending, hostedInferenceAllowedFor } from "./hosted-inference-access.js";
import { dotRunnerBroker } from "./dot-runner-broker.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function assertHarnessTestPassed(result: AdapterEnvironmentTestResult) {
  const verified = result.checks.some(check => check.level === "info" &&
    (/hello_probe_(passed|succeeded)$/.test(check.code) || check.code === "ai_connection_api_key_reverified"));
  const authenticationFailed = result.checks.some(check =>
    check.code === ADAPTER_AUTH_MISSING_CHECK_CODE || /_hello_probe_auth_required$/.test(check.code));
  const incomplete = !verified && (result.status === "warn" || result.checks.some(check => check.code.includes("hello_probe")));
  if (result.status === "fail" || authenticationFailed || incomplete) {
    // Codes and levels only: check messages can carry provider details.
    throw Object.assign(new Error("The harness test failed"), {
      code: "harness_test_failed",
      checks: result.checks.map(check => ({ code: check.code, level: check.level })),
    });
  }
}

/**
 * Keeps the latest failed harness test on the lifecycle operation (for the
 * Assistant's setup state), or clears it once the test passes. Scoped to the
 * lifecycle version the test ran for; best effort.
 */
async function recordHarnessTest(db: Db, agent: { id: string; lifecycleVersion: number; adapterType: string }, checks: Array<{ code: string; level: string }> | null) {
  const value = checks
    ? sql`coalesce(${agents.lifecycleOperation}, '{}'::jsonb) || jsonb_build_object('lastHarnessTest', ${JSON.stringify({ version: agent.lifecycleVersion, adapterType: agent.adapterType, checks })}::jsonb)`
    : sql`${agents.lifecycleOperation} - 'lastHarnessTest'`;
  await db.update(agents).set({ lifecycleOperation: value })
    .where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion), isNotNull(agents.lifecycleOperation)))
    .catch(() => {});
}

/** Lifecycle sweeps (about 5s apart) a new hosted Assistant may wait for its provisioning record. */
export const HOSTED_PROVISIONING_MAX_WAITS = 24;

function readProvisioningWaits(operation: unknown): number {
  const value = (operation as { hostedProvisioningWaits?: unknown } | null | undefined)?.hostedProvisioningWaits;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Counts waits on the lifecycle operation (the setup card shows "Finishing Assistant setup…"). Best effort. */
async function recordProvisioningWait(db: Db, agent: { id: string; lifecycleVersion: number }, waits: number) {
  await db.update(agents).set({
    lifecycleOperation: sql`coalesce(${agents.lifecycleOperation}, '{}'::jsonb) || jsonb_build_object('hostedProvisioningWaits', ${waits}::int)`,
  }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion), isNotNull(agents.lifecycleOperation)))
    .catch(() => {});
}

export function agentHarnessVerificationService(db: Db, manager: PluginWorkerManager) {
  const tests = agentEnvironmentTestService(db, manager);
  const secrets = secretService(db);
  const environments = environmentService(db);
  async function verify(snapshot: LifecycleAgent): Promise<"complete" | "pending"> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, snapshot.id), eq(agents.lifecycleVersion, snapshot.lifecycleVersion)));
    if (!agent) return "pending";
    if (agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "openai_dot") {
      const binding = await dotRunnerBroker(db).bindingForAgent(agent.companyId, agent.id);
      return binding?.status === "ready" && binding.subscriptionVerified && binding.id === agent.adapterConfig.dotBindingId ? "complete" : "pending";
    }
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
    const responsibleUserId = agent.lifecycleOperation?.responsibleUserId ?? company.defaultResponsibleUserId;
    const context = { consumerType: "agent" as const, consumerId: agent.id, actorType: "system" as const,
      actorId: "agent-lifecycle", responsibleUserId };
    let binding = agent.runtimeConfig.aiConnection ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
    let config = agent.adapterConfig;
    if (binding?.mode === "router") {
      const selected = await aiConnectionRouterService(db, manager).resolve({ companyId: agent.companyId,
        poolId: binding.connectionId, agentId: agent.id, userId: responsibleUserId,
        adapterType: agent.adapterType, taskKey: `lifecycle:${agent.lifecycleOperation!.id}` });
      binding = selected.binding;
      config = { ...config, ...selected.runtimeConfig };
    }
    if (binding) config = { ...config, env: stripAiAuthBindings(config.env) };
    config = (await secrets.resolveAdapterConfigForRuntime(agent.companyId, config, context, { adapterType: agent.adapterType })).config;
    const environmentId = await tests.resolveAdapterTestEnvironmentId(agent.companyId, agent.defaultEnvironmentId);
    if (environmentId) {
      await tests.assertAdapterTestEnvironmentForCompany(agent.companyId, environmentId);
      const environment = await environments.getById(environmentId);
      const env = Object.fromEntries(Object.entries(binding ? stripAiAuthBindings(environment?.envVars) : parseObject(environment?.envVars))
        .filter(([key]) => !isForbiddenConfigEnvKey(key)));
      const resolved = await secrets.resolveEnvBindings(agent.companyId, env,
        { ...context, consumerType: "environment", consumerId: environmentId });
      config = { ...config, env: { ...resolved.env, ...parseObject(config.env) } };
    }
    const hostedInferenceAllowed = await hostedInferenceAllowedFor(db, agent);
    if (!hostedInferenceAllowed && await hostedAssistantProvisioningPending(db, agent)) {
      // Waiting on the provisioning record: say so, and give up (a setup error
      // the person can retry) instead of verifying silently forever.
      const waits = readProvisioningWaits(agent.lifecycleOperation) + 1;
      if (waits > HOSTED_PROVISIONING_MAX_WAITS) {
        const checks = [{ code: ASSISTANT_PROVISIONING_INCOMPLETE_CHECK_CODE, level: "error" }];
        await recordHarnessTest(db, agent, checks);
        throw Object.assign(new Error("The Assistant's setup did not finish"), { code: "harness_test_failed", checks });
      }
      await recordProvisioningWait(db, agent, waits);
      return "pending";
    }
    const target = await tests.resolveAdapterTestExecutionContext({ agentId: agent.id, companyId: agent.companyId, adapterType: agent.adapterType, environmentId });
    let status: "released" | "failed" = "failed";
    try {
      if (target.fallbackChecks.length) throw Object.assign(new Error("The test environment is unavailable"), { code: "test_environment_unavailable" });
      const input = { companyId: agent.companyId, adapterType: agent.adapterType, config,
        executionTarget: target.executionTarget, environmentName: target.environmentName,
        hostedInferenceAllowed };
      const result = binding ? await withManagedAiProbe(db, { ...input, agentId: agent.id, responsibleUserId, binding },
        managed => tests.testManagedEnvironment(agent.adapterType, { ...input, config: managed.config }, binding!, managed, agent.id))
        : await requireServerAdapter(agent.adapterType).testEnvironment(input);
      try {
        assertHarnessTestPassed(result);
      } catch (error) {
        await recordHarnessTest(db, agent, (error as { checks?: Array<{ code: string; level: string }> }).checks ?? []);
        throw error;
      }
      await recordHarnessTest(db, agent, null);
      status = "released";
      return "complete";
    } finally { await target.release(status); }
  }
  return { verify };
}

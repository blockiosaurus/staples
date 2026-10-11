import { and, eq, ne } from "drizzle-orm";
import { agents, builtInManagedResources, type Db } from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";

/**
 * Adapters the Assistant itself may run on: those whose default engine
 * actually delivers `ctx.runtimeMcp` (the Assistant's tools) to the model.
 * Verified in each adapter's execute path: claude_local and codex_local (CLI
 * and ACP engines), gemini_local and kimi_local (default ACP engine, which
 * passes runtime MCP servers to the agent). All issue local agent JWTs.
 */
export const ASSISTANT_RUNTIME_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "kimi_local",
] as const;

/**
 * Local CLI adapters (registry `type` strings that support local agent JWTs)
 * the Assistant may propose when hiring a staff agent. Broader than the
 * runtime set: staff agents do not need the Assistant's tools.
 */
export const PROPOSABLE_HIRE_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
] as const;

/**
 * Authority check for the built-in Assistant. The marker alone is caller-shaped
 * metadata, so authority also requires the company's provisioning record: the
 * built-in service binds the Assistant's managed instructions to its agent id.
 * Use this (never the shared `isAssistantAgent`) for any grant of authority.
 */
export async function resolveCompanyAssistantAgentId(db: Pick<Db, "select">, companyId: string): Promise<string | null> {
  const [binding] = await db.select({ agentId: builtInManagedResources.resourceId }).from(builtInManagedResources).where(and(
    eq(builtInManagedResources.companyId, companyId),
    eq(builtInManagedResources.bundleKey, ASSISTANT_BUILT_IN_AGENT_KEY),
    eq(builtInManagedResources.resourceKind, "instructions"),
    eq(builtInManagedResources.resourceKey, "AGENTS.md"),
  ));
  if (!binding) return null;
  const [agent] = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(and(
    eq(agents.id, binding.agentId), eq(agents.companyId, companyId), ne(agents.status, "terminated"),
  ));
  return agent && readBuiltInAgentMarker(agent.metadata)?.key === ASSISTANT_BUILT_IN_AGENT_KEY ? agent.id : null;
}

export async function isProvisionedAssistant(db: Pick<Db, "select">, agent: { id: string; companyId: string }) {
  return (await resolveCompanyAssistantAgentId(db, agent.companyId)) === agent.id;
}

import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, toolPolicies, type Db } from "@paperclipai/db";
import type { AgentAutopilotCategory, AgentAutopilotMode } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { rawStaplesTemplateMarker } from "../lib/staples-template-metadata.js";
import { usableAppConnections, type UsableAppConnection } from "./plan-templates.js";
import { AGENT_AUTOPILOT_POLICY_SOURCE, toolAccessPolicyService } from "./tool-access-policy.js";

/**
 * Autopilot: per templated agent and outward category (from the template
 * record `agents.metadata.staplesTemplate.outwardActions`), a marker that lets
 * the agent take that category's routine (write) actions on the connection
 * satisfying the capability without being asked first.
 *
 * The marker is a server-owned `tool_policies` row (`config.source =
 * agent_autopilot`) scoped to the agent, that connection, write risk and the
 * category's tool-name patterns, minus its destructive patterns. It is not an
 * ordered allow: the access decision only uses it to skip the template's
 * outward ask-first rule and the connection's seeded Ask first defaults for
 * matching calls (see tool-access-policy.ts). Destructive calls, and the
 * category's destructive tool names, always ask. Read-only templates have no
 * categories.
 */

/** Stored on the marker for display order only; markers are not ordered rules. */
export const AGENT_AUTOPILOT_PRIORITY = 45;
const AUTOPILOT_RISK_LEVELS = ["write"] as const;

interface OutwardCategory {
  capability: string;
  label: string;
  destructiveLabel: string | null;
  toolPatterns: string[];
  destructiveToolPatterns: string[];
  anyOf: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** The outward categories of a stored template record (empty for read-only or untemplated agents). */
export function autopilotCategoriesFromMetadata(metadata: unknown): OutwardCategory[] {
  const record = rawStaplesTemplateMarker(metadata);
  if (!isRecord(record) || record.readOnly === true) return [];
  const requiredApps = Array.isArray(record.requiredApps) ? record.requiredApps.filter(isRecord) : [];
  const actions = Array.isArray(record.outwardActions) ? record.outwardActions.filter(isRecord) : [];
  const categories: OutwardCategory[] = [];
  for (const action of actions) {
    const capability = typeof action.capability === "string" ? action.capability : "";
    const toolPatterns = strings(action.toolPatterns);
    if (!capability || toolPatterns.length === 0 || categories.some((category) => category.capability === capability)) continue;
    const app = requiredApps.find((candidate) => candidate.capability === capability);
    categories.push({
      capability,
      label: typeof action.label === "string" ? action.label : capability,
      destructiveLabel: typeof action.destructiveLabel === "string" ? action.destructiveLabel : null,
      toolPatterns,
      destructiveToolPatterns: strings(action.destructiveToolPatterns),
      anyOf: app ? strings(app.anyOf) : [],
    });
  }
  return categories;
}

type PolicyRow = typeof toolPolicies.$inferSelect;

function markerCapability(row: PolicyRow): string | null {
  return isRecord(row.config) && typeof row.config.capability === "string" ? row.config.capability : null;
}

function expectedSelectors(agentId: string, connectionId: string, category: OutwardCategory) {
  return { agentId, connectionId, riskLevels: [...AUTOPILOT_RISK_LEVELS], toolNamePatterns: [...category.toolPatterns] };
}

function expectedConfig(category: OutwardCategory) {
  return {
    source: AGENT_AUTOPILOT_POLICY_SOURCE,
    capability: category.capability,
    ...(category.destructiveToolPatterns.length ? { excludedToolPatterns: [...category.destructiveToolPatterns] } : {}),
  };
}

/** Whether a marker is the current, enabled one for this agent, connection and category. */
function markerIsCurrent(row: PolicyRow, agentId: string, connection: UsableAppConnection | null, category: OutwardCategory): boolean {
  if (!connection) return false;
  return row.enabled && row.policyType === "allow" && row.conditions === null
    && isDeepStrictEqual(row.selectors, expectedSelectors(agentId, connection.id, category))
    && isDeepStrictEqual(row.config, expectedConfig(category));
}

export function agentAutopilotService(db: Db) {
  const policies = toolAccessPolicyService(db);

  async function loadAgent(companyId: string, agentId: string) {
    const [agent] = await db.select({ id: agents.id, name: agents.name, companyId: agents.companyId, metadata: agents.metadata })
      .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /** Every Autopilot marker of the agent, enabled or not. */
  async function markers(companyId: string, agentId: string): Promise<PolicyRow[]> {
    return db.select().from(toolPolicies).where(and(
      eq(toolPolicies.companyId, companyId),
      sql`${toolPolicies.config} ->> 'source' = ${AGENT_AUTOPILOT_POLICY_SOURCE}`,
      sql`${toolPolicies.selectors} ->> 'agentId' = ${agentId}`,
    ));
  }

  function connectionFor(category: OutwardCategory, connections: UsableAppConnection[]): UsableAppConnection | null {
    return connections.find((connection) => category.anyOf.includes(connection.appSlug)) ?? null;
  }

  function view(agentId: string, category: OutwardCategory, connection: UsableAppConnection | null, rows: PolicyRow[]): AgentAutopilotCategory {
    const current = rows.some((row) => markerIsCurrent(row, agentId, connection, category));
    return {
      capability: category.capability,
      label: category.label,
      destructiveLabel: category.destructiveLabel,
      connection: connection ? { id: connection.id, appSlug: connection.appSlug, displayName: connection.displayName } : null,
      mode: current ? "auto" : "ask",
      // A marker exists but no longer applies as shown (switched off, or for
      // another connection or older patterns): turning auto on again fixes it.
      stale: !current && rows.length > 0,
      canToggle: Boolean(connection),
    };
  }

  /** Convert a duplicate-name failure (drizzle wraps the driver error) to a 409. */
  function rethrowWriteError(error: unknown): never {
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && /duplicate key value/.test(cause.message)) policies.ensureNoDuplicatePolicyNameError(cause);
    policies.ensureNoDuplicatePolicyNameError(error);
    throw error;
  }

  async function list(companyId: string, agentId: string): Promise<AgentAutopilotCategory[]> {
    const agent = await loadAgent(companyId, agentId);
    const categories = autopilotCategoriesFromMetadata(agent.metadata);
    if (categories.length === 0) return [];
    const [connections, rows] = await Promise.all([usableAppConnections(db, companyId), markers(companyId, agentId)]);
    return categories.map((category) => view(agentId, category, connectionFor(category, connections),
      rows.filter((row) => markerCapability(row) === category.capability)));
  }

  /**
   * Set one category's mode. Idempotent: "auto" keeps exactly one current
   * marker for the category (repairing a stale one), "ask" removes every
   * marker for the capability, even one whose category the template no
   * longer has. Returns the category and whether anything changed.
   */
  async function setMode(companyId: string, agentId: string, capability: string, mode: AgentAutopilotMode, userId: string | null) {
    const agent = await loadAgent(companyId, agentId);
    const category = autopilotCategoriesFromMetadata(agent.metadata).find((candidate) => candidate.capability === capability);
    const existing = (await markers(companyId, agentId)).filter((row) => markerCapability(row) === capability);

    if (mode === "ask") {
      if (existing.length) await db.delete(toolPolicies).where(inArray(toolPolicies.id, existing.map((row) => row.id)));
      const removedId = existing[0]?.id ?? null;
      if (!category) {
        if (!existing.length) throw notFound("This agent has no Autopilot category with that name");
        return {
          category: { capability, label: capability, destructiveLabel: null, connection: null, mode: "ask" as const, stale: false, canToggle: false },
          changed: true, policyId: removedId,
        };
      }
      const connection = connectionFor(category, await usableAppConnections(db, companyId));
      return { category: view(agentId, category, connection, []), changed: existing.length > 0, policyId: removedId };
    }

    if (!category) throw notFound("This agent has no Autopilot category with that name");
    const connection = connectionFor(category, await usableAppConnections(db, companyId));
    if (!connection) {
      throw conflict(`Connect ${category.anyOf.join(" or ") || "the service"} before turning on Autopilot for ${category.label.toLowerCase()}`, {
        code: "autopilot_connection_required",
      });
    }
    const current = existing.find((row) => markerIsCurrent(row, agentId, connection, category));
    const [keep, ...extra] = current ? [current, ...existing.filter((row) => row !== current)] : existing;
    let changed = false;
    if (extra.length) {
      await db.delete(toolPolicies).where(inArray(toolPolicies.id, extra.map((row) => row.id)));
      changed = true;
    }
    let marker = current;
    if (!marker) {
      const now = new Date();
      const values = {
        name: `${agent.name}: Autopilot for ${category.label.toLowerCase()}`.slice(0, 140) + ` · ${agentId.slice(0, 8)}`,
        description: `${agent.name} may take routine (write) actions for ${category.label.toLowerCase()} on ${connection.displayName} without asking first. Deleting, closing or destroying anything still asks.`.slice(0, 4000),
        policyType: "allow" as const,
        priority: AGENT_AUTOPILOT_PRIORITY,
        enabled: true,
        selectors: expectedSelectors(agentId, connection.id, category),
        conditions: null,
        config: expectedConfig(category),
        updatedAt: now,
      };
      try {
        [marker] = keep
          ? await db.update(toolPolicies).set(values).where(eq(toolPolicies.id, keep.id)).returning()
          : await db.insert(toolPolicies).values({ companyId, ...values, createdByUserId: userId, createdAt: now }).returning();
      } catch (error) {
        rethrowWriteError(error);
      }
      changed = true;
    }
    return { category: view(agentId, category, connection, [marker!]), changed, policyId: marker!.id };
  }

  return { list, setMode };
}

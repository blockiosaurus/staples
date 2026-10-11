import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, toolPolicies, type Db } from "@paperclipai/db";
import type { AgentAutopilotCategory, AgentAutopilotMode } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { rawStaplesTemplateMarker } from "../lib/staples-template-metadata.js";
import { usableAppConnections, type UsableAppConnection } from "./plan-templates.js";
import { AGENT_AUTOPILOT_POLICY_SOURCE } from "./tool-access-policy.js";

/**
 * Autopilot: per templated agent and outward category (from the template
 * record `agents.metadata.staplesTemplate.outwardActions`), an `allow` rule
 * that lets the agent take that category's outward actions on the connection
 * satisfying the capability without asking. It is scoped to the agent, that
 * connection, write risk and the category's tool-name patterns. Destructive
 * risk is never included (and the template's destructive guard asks first
 * regardless). Read-only templates have no categories.
 */

/** Ahead of the template's outward ask-first rule (50), so allow wins for these writes. */
export const AGENT_AUTOPILOT_PRIORITY = 45;
const AUTOPILOT_RISK_LEVELS = ["write"] as const;

interface OutwardCategory {
  capability: string;
  label: string;
  destructiveLabel: string | null;
  toolPatterns: string[];
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
      anyOf: app ? strings(app.anyOf) : [],
    });
  }
  return categories;
}

type PolicyRow = typeof toolPolicies.$inferSelect;

function ruleCapability(row: PolicyRow): string | null {
  return isRecord(row.config) && typeof row.config.capability === "string" ? row.config.capability : null;
}

export function agentAutopilotService(db: Db) {
  async function loadAgent(companyId: string, agentId: string) {
    const [agent] = await db.select({ id: agents.id, name: agents.name, companyId: agents.companyId, metadata: agents.metadata })
      .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function autopilotRules(companyId: string, agentId: string): Promise<PolicyRow[]> {
    return db.select().from(toolPolicies).where(and(
      eq(toolPolicies.companyId, companyId),
      sql`${toolPolicies.config} ->> 'source' = ${AGENT_AUTOPILOT_POLICY_SOURCE}`,
      sql`${toolPolicies.selectors} ->> 'agentId' = ${agentId}`,
    ));
  }

  function connectionFor(category: OutwardCategory, connections: UsableAppConnection[]): UsableAppConnection | null {
    return connections.find((connection) => category.anyOf.includes(connection.appSlug)) ?? null;
  }

  function view(category: OutwardCategory, connection: UsableAppConnection | null, rule: PolicyRow | undefined): AgentAutopilotCategory {
    return {
      capability: category.capability,
      label: category.label,
      destructiveLabel: category.destructiveLabel,
      connection: connection ? { id: connection.id, appSlug: connection.appSlug, displayName: connection.displayName } : null,
      mode: rule ? "auto" : "ask",
      canToggle: Boolean(connection),
    };
  }

  async function list(companyId: string, agentId: string): Promise<AgentAutopilotCategory[]> {
    const agent = await loadAgent(companyId, agentId);
    const categories = autopilotCategoriesFromMetadata(agent.metadata);
    if (categories.length === 0) return [];
    const [connections, rules] = await Promise.all([usableAppConnections(db, companyId), autopilotRules(companyId, agentId)]);
    return categories.map((category) =>
      view(category, connectionFor(category, connections), rules.find((rule) => ruleCapability(rule) === category.capability)));
  }

  /**
   * Set one category's mode. Idempotent: "auto" keeps a single rule for the
   * category (rewritten when its connection or patterns changed), "ask"
   * removes it. Returns the category and whether anything changed.
   */
  async function setMode(companyId: string, agentId: string, capability: string, mode: AgentAutopilotMode, userId: string | null) {
    const agent = await loadAgent(companyId, agentId);
    const category = autopilotCategoriesFromMetadata(agent.metadata).find((candidate) => candidate.capability === capability);
    if (!category) throw notFound("This agent has no Autopilot category with that name");
    const connection = connectionFor(category, await usableAppConnections(db, companyId));
    const existing = (await autopilotRules(companyId, agentId)).filter((rule) => ruleCapability(rule) === capability);
    let changed = false;
    let rule: PolicyRow | undefined;
    if (mode === "ask") {
      if (existing.length) {
        await db.delete(toolPolicies).where(inArray(toolPolicies.id, existing.map((row) => row.id)));
        changed = true;
      }
    } else {
      if (!connection) {
        throw conflict(`Connect ${category.anyOf.join(" or ") || "the service"} before turning on Autopilot for ${category.label.toLowerCase()}`, {
          code: "autopilot_connection_required",
        });
      }
      const selectors = {
        agentId, connectionId: connection.id, riskLevels: [...AUTOPILOT_RISK_LEVELS], toolNamePatterns: [...category.toolPatterns],
      };
      const [keep, ...extra] = existing;
      if (extra.length) {
        await db.delete(toolPolicies).where(inArray(toolPolicies.id, extra.map((row) => row.id)));
        changed = true;
      }
      const sameSelectors = keep && isDeepStrictEqual(keep.selectors, selectors) && keep.conditions === null
        && keep.policyType === "allow" && keep.enabled && keep.priority === AGENT_AUTOPILOT_PRIORITY;
      if (sameSelectors) {
        rule = keep;
      } else {
        const now = new Date();
        const values = {
          name: `${agent.name}: Autopilot for ${category.label.toLowerCase()}`.slice(0, 140) + ` · ${agentId.slice(0, 8)}`,
          description: `${agent.name} may ${category.label.toLowerCase()} on ${connection.displayName} without asking first. Deleting or destroying anything still asks.`.slice(0, 4000),
          policyType: "allow" as const,
          priority: AGENT_AUTOPILOT_PRIORITY,
          enabled: true,
          selectors,
          conditions: null,
          config: { source: AGENT_AUTOPILOT_POLICY_SOURCE, capability },
          updatedAt: now,
        };
        if (keep) {
          [rule] = await db.update(toolPolicies).set(values).where(eq(toolPolicies.id, keep.id)).returning();
        } else {
          [rule] = await db.insert(toolPolicies).values({ companyId, ...values, createdByUserId: userId, createdAt: now }).returning();
        }
        changed = true;
      }
    }
    return { category: view(category, connection, rule), changed, policyId: rule?.id ?? existing[0]?.id ?? null };
  }

  return { list, setMode };
}

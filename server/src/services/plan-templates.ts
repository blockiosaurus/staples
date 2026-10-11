import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, toolApplications, toolConnections, toolPolicies, type Db } from "@paperclipai/db";
import {
  APP_DEFINITIONS,
  applyPlanSchema,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
  type ApplyPlan,
  type PlanTemplateSummary,
  type RenderedAgentTemplate,
  type ToolConnectionHealthStatus,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { STAPLES_TEMPLATE_METADATA_KEY } from "../lib/staples-template-metadata.js";
import { agentTemplatesService } from "./agent-templates.js";
import { PROPOSABLE_HIRE_ADAPTER_TYPES, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { companySkillService } from "./company-skills.js";
import { resolveCatalogSkillReference } from "./skills-catalog.js";
import { AGENT_TEMPLATE_POLICY_SOURCE } from "./tool-access-policy.js";

/**
 * Agent templates inside plans: rendering a plan's templated agents, filling
 * the hire fields a template supplies, the plan card's per-template line, and
 * the install steps apply runs for each templated agent (skills, access
 * rules, the template record, connect tasks).
 */

export type AgentTemplatesService = ReturnType<typeof agentTemplatesService>;
/** Rendered templates by the plan agent's clientKey. */
export type PlanTemplates = Map<string, RenderedAgentTemplate>;

let sharedTemplates: AgentTemplatesService | null = null;
/** The shipped template catalog (cached per process; tests pass their own). */
export function defaultAgentTemplates(): AgentTemplatesService {
  return (sharedTemplates ??= agentTemplatesService());
}

export interface PlanTemplateRenderContext {
  companyName: string;
  personName: string;
  personTimezone: string;
}

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A browser-reported IANA zone, or null when absent or unknown. */
export function normalizePersonTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(trimmed)) return null;
  return isValidTimezone(trimmed) ? trimmed : null;
}

/** The person's and company's names, used in setup text and instructions. */
export async function planTemplateContext(
  db: Db, companyId: string, userId: string | null, personTimezone?: string | null,
): Promise<PlanTemplateRenderContext> {
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  const [user] = userId
    ? await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId))
    : [];
  return {
    companyName: company?.name ?? "",
    personName: user?.name?.trim() || "the owner",
    personTimezone: normalizePersonTimezone(personTimezone) ?? "UTC",
  };
}

/**
 * Render every templated agent in the plan with its answers, at its pinned
 * version (or the current one when none is pinned). Throws the template
 * service's HttpError: 404 unknown or preview template, 409 version changed,
 * 422 invalid answers (`details.errors`).
 */
export async function renderPlanTemplates(
  plan: ApplyPlan, ctx: PlanTemplateRenderContext, templates: AgentTemplatesService = defaultAgentTemplates(),
): Promise<PlanTemplates> {
  const rendered: PlanTemplates = new Map();
  for (const agent of plan.agents) {
    if (!agent.templateRef) continue;
    rendered.set(agent.clientKey, await templates.render(agent.templateRef, agent.templateVersion ?? null, agent.templateAnswers ?? {}, ctx));
  }
  return rendered;
}

/** One sentence for a template render failure, for proposal refusals. */
export function planTemplateErrorMessage(clientKey: string, ref: string, error: unknown): string | null {
  if (!(error instanceof HttpError)) return null;
  if (error.status === 404) return `Agent ${clientKey}: agent template ${ref} does not exist or is not available yet.`;
  if (error.status === 409) return `Agent ${clientKey}: ${error.message}`;
  if (error.status === 422) {
    const details = error.details as { errors?: unknown } | undefined;
    const errors = Array.isArray(details?.errors) ? details!.errors.filter((entry): entry is string => typeof entry === "string") : [];
    return `Agent ${clientKey}: the setup answers for ${ref} are not valid${errors.length ? `: ${errors.slice(0, 5).join(" ")}` : "."}`;
  }
  return null;
}

/**
 * The plan with each templated agent's hire fields filled from its template
 * where the plan left them out: name, role, title, monthly budget and the
 * adapter (the template's recommendation when proposable, else
 * `fallbackAdapterType` when proposable). `pinVersion` also records the
 * rendered version, which apply installs.
 */
export function withTemplateDefaults(
  plan: ApplyPlan, templates: PlanTemplates, options: { fallbackAdapterType?: string | null; pinVersion?: boolean } = {},
): ApplyPlan {
  const proposable = (value: string | null | undefined) =>
    value && (PROPOSABLE_HIRE_ADAPTER_TYPES as readonly string[]).includes(value) ? value : undefined;
  return {
    ...plan,
    agents: plan.agents.map((agent) => {
      const rendered = templates.get(agent.clientKey);
      if (!rendered) return agent;
      const filled = { ...agent };
      filled.name ??= rendered.agent.name.slice(0, 80);
      filled.role ??= rendered.agent.role;
      if (filled.title === undefined && rendered.agent.title) filled.title = rendered.agent.title.slice(0, 80);
      if (filled.budgetMonthlyCents === undefined && rendered.defaultBudgetMonthlyCents !== null) {
        filled.budgetMonthlyCents = rendered.defaultBudgetMonthlyCents;
      }
      filled.adapterType ??= proposable(rendered.recommendedAdapterType) ?? proposable(options.fallbackAdapterType);
      if (options.pinVersion) filled.templateVersion = rendered.version;
      return filled;
    }),
  };
}

/** The Assistant's adapter: the default for templated hires that name none. */
export async function assistantAdapterType(db: Db, companyId: string): Promise<string | null> {
  const assistantId = await resolveCompanyAssistantAgentId(db, companyId);
  if (!assistantId) return null;
  const [row] = await db.select({ adapterType: agents.adapterType }).from(agents)
    .where(and(eq(agents.id, assistantId), eq(agents.companyId, companyId)));
  return row?.adapterType ?? null;
}

const AGGREGATOR_DISPLAY_NAMES: Record<string, string> = {
  linkedin: "LinkedIn", x: "X", reddit: "Reddit", youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok",
};

/** "AgentMail" for agentmail; aggregator-backed services by their brand name. */
export function appDisplayName(slug: string): string {
  return getAppStoreDefinition(slug)?.name
    ?? APP_DEFINITIONS.find((app) => app.slug === slug)?.name
    ?? AGGREGATOR_DISPLAY_NAMES[slug]
    ?? slug;
}

/** "AgentMail or Gmail". */
export function appChoiceLabel(anyOf: readonly string[]): string {
  return anyOf.map(appDisplayName).join(" or ");
}

/**
 * The plan card's one line per templated hire. Server-computed display data
 * for the proposal (not hashed, never read by apply), like planHireConnections.
 */
export async function planTemplateSummariesFor(
  body: unknown, templates: AgentTemplatesService = defaultAgentTemplates(),
): Promise<PlanTemplateSummary[]> {
  const plan = applyPlanSchema.safeParse(body);
  if (!plan.success) return [];
  const summaries: PlanTemplateSummary[] = [];
  for (const agent of plan.data.agents) {
    if (!agent.templateRef) continue;
    let detail: Awaited<ReturnType<AgentTemplatesService["get"]>>;
    try {
      detail = await templates.get(agent.templateRef, { companyName: "", personName: "" });
    } catch {
      continue;
    }
    summaries.push({
      clientKey: agent.clientKey,
      ref: detail.ref,
      name: detail.name,
      needs: detail.needs.filter((need) => !need.optional).map((need) => appChoiceLabel(need.anyOf)),
      asksBefore: [...detail.asksBefore],
      routineCount: detail.routines.length,
      budgetMonthlyCents: agent.budgetMonthlyCents ?? detail.defaultBudgetMonthlyCents,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Apply: skills
// ---------------------------------------------------------------------------

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Put the template's skills in the company library and return the company
 * skill keys to hire with, in the order the agent lists them. Vendored skills
 * are imported (an existing import is reused; a different skill holding the
 * same slug is left alone and the template's copy is imported under a new
 * slug); skills-catalog skills are installed unless already present.
 * Idempotent: a retry reuses what an earlier attempt installed.
 */
export async function ensureTemplateSkills(db: Db, companyId: string, rendered: RenderedAgentTemplate): Promise<string[]> {
  const skills = companySkillService(db);
  const keyBySlug = new Map<string, string>();
  for (const vendored of rendered.vendoredSkills) {
    const files = Object.fromEntries(Object.entries(vendored.files).map(([path, content]) => [`skills/${vendored.slug}/${path}`, content]));
    const [first] = await skills.importPackageFiles(companyId, files, { onConflict: "skip" });
    if (!first) throw unprocessable(`The template skill ${vendored.slug} could not be imported.`);
    if (first.action !== "skipped" || first.skill.key === first.originalKey) {
      keyBySlug.set(vendored.slug, first.skill.key);
      continue;
    }
    // Another skill already uses this slug: reuse an earlier renamed import of this one, or import it renamed.
    const earlier = (await skills.listFull(companyId))
      .find((skill) => metadataRecord(skill.metadata).importedFromSkillKey === first.originalKey);
    if (earlier) {
      keyBySlug.set(vendored.slug, earlier.key);
      continue;
    }
    const [renamed] = await skills.importPackageFiles(companyId, files, { onConflict: "rename" });
    if (!renamed) throw unprocessable(`The template skill ${vendored.slug} could not be imported.`);
    keyBySlug.set(vendored.slug, renamed.skill.key);
  }
  const keys: string[] = [];
  for (const slug of rendered.agent.skills) {
    const vendoredKey = keyBySlug.get(slug);
    if (vendoredKey) {
      keys.push(vendoredKey);
      continue;
    }
    const { skill: catalogSkill } = resolveCatalogSkillReference(slug);
    if (!catalogSkill) throw unprocessable(`The template's skill ${slug} is not in the skills catalog.`);
    const existing = await skills.getByKey(companyId, catalogSkill.key);
    if (existing) {
      keys.push(existing.key);
      continue;
    }
    try {
      const installed = await skills.installFromCatalog(companyId, { catalogSkillId: catalogSkill.id });
      keys.push(installed.skill.key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw unprocessable(`The template's skill ${slug} could not be installed: ${reason}`);
    }
  }
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Apply: access rules and the template record
// ---------------------------------------------------------------------------

/** Risk levels that change something (everything but read/low). */
const NON_READ_RISK_LEVELS = ["write", "medium", "destructive", "high", "critical"] as const;
const DESTRUCTIVE_RISK_LEVELS = ["destructive", "high", "critical"] as const;
const WRITE_RISK_LEVELS = ["write", "medium"] as const;

export type TemplateRuleKind = "read_only" | "destructive" | "outward";

export interface TemplateAccessRule {
  kind: TemplateRuleKind;
  name: string;
  description: string;
  policyType: "block" | "require_approval";
  selectors: Record<string, unknown>;
}

/**
 * The access rules a templated agent starts with, all at priority 50 and
 * scoped to the agent. Read-only templates block every non-read call.
 * Others always ask first for destructive calls, and ask first for writes
 * whose tool name matches the template's outward-action patterns (sending,
 * publishing, deploying...). Drafts and other writes are left to the
 * company's own rules.
 */
export function templateAccessRules(agent: { id: string; name: string }, rendered: RenderedAgentTemplate): TemplateAccessRule[] {
  const label = (text: string) => `${agent.name}: ${text}`.slice(0, 140) + ` · ${agent.id.slice(0, 8)}`;
  if (rendered.readOnly) {
    return [{
      kind: "read_only", policyType: "block",
      name: label("read-only"),
      description: `${agent.name} is read-only: it may not change anything in connected services.`,
      selectors: { agentId: agent.id, riskLevels: [...NON_READ_RISK_LEVELS] },
    }];
  }
  const rules: TemplateAccessRule[] = [{
    kind: "destructive", policyType: "require_approval",
    name: label("ask before deleting"),
    description: `Ask first before ${agent.name} deletes or destroys anything.`,
    selectors: { agentId: agent.id, riskLevels: [...DESTRUCTIVE_RISK_LEVELS] },
  }];
  const patterns = [...new Set(rendered.outwardActions.flatMap((action) => action.toolPatterns))];
  if (patterns.length) {
    const labels = rendered.outwardActions.map((action) => action.label.toLowerCase()).join(", ");
    rules.push({
      kind: "outward", policyType: "require_approval",
      name: label("ask before outward actions"),
      description: `Ask first before ${agent.name} does any of: ${labels}.`.slice(0, 4000),
      selectors: { agentId: agent.id, riskLevels: [...WRITE_RISK_LEVELS], toolNamePatterns: patterns },
    });
  }
  return rules;
}

/** What `agents.metadata.staplesTemplate` holds. */
export function staplesTemplateRecord(rendered: RenderedAgentTemplate) {
  return {
    ref: rendered.ref,
    version: rendered.version,
    readOnly: rendered.readOnly,
    outwardActions: rendered.outwardActions.map((action) => ({ ...action, toolPatterns: [...action.toolPatterns] })),
    requiredApps: rendered.requiredApps.map((app) => ({ ...app, anyOf: [...app.anyOf] })),
  };
}

/**
 * Record the template on the agent and seed its access rules. Idempotent:
 * rules already seeded for this agent (by kind) are kept, and the record is
 * rewritten only when it differs. Returns the rules created now.
 */
export async function ensureTemplateAgentSetup(
  db: Db, companyId: string, agentId: string, rendered: RenderedAgentTemplate, userId: string | null,
): Promise<Array<{ id: string; name: string; policyType: string; priority: number }>> {
  const [agent] = await db.select({ id: agents.id, name: agents.name, metadata: agents.metadata }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (!agent) throw unprocessable("The hired agent was not found");
  const created: Array<{ id: string; name: string; policyType: string; priority: number }> = [];
  const existing = await db.select({ config: toolPolicies.config }).from(toolPolicies).where(and(
    eq(toolPolicies.companyId, companyId),
    sql`${toolPolicies.config} ->> 'source' = ${AGENT_TEMPLATE_POLICY_SOURCE}`,
    sql`${toolPolicies.selectors} ->> 'agentId' = ${agentId}`,
  ));
  const seeded = new Set(existing.map((row) => String(metadataRecord(row.config).templateRule ?? "")));
  for (const rule of templateAccessRules(agent, rendered)) {
    if (seeded.has(rule.kind)) continue;
    // Inserted directly (like the gallery's Ask first rules): the generic policy
    // API keeps config for rate limits only, and these rules are server-owned.
    const now = new Date();
    const [policy] = await db.insert(toolPolicies).values({
      companyId, name: rule.name, description: rule.description, policyType: rule.policyType, priority: 50, enabled: true,
      selectors: rule.selectors,
      config: { source: AGENT_TEMPLATE_POLICY_SOURCE, templateRule: rule.kind, templateRef: rendered.ref },
      createdByUserId: userId, createdAt: now, updatedAt: now,
    }).returning();
    created.push({ id: policy!.id, name: policy!.name, policyType: policy!.policyType, priority: policy!.priority });
  }
  const record = staplesTemplateRecord(rendered);
  const metadata = metadataRecord(agent.metadata);
  if (!isDeepStrictEqual(metadata[STAPLES_TEMPLATE_METADATA_KEY], record)) {
    // Server-written; callers can never set this key (see staples-template-metadata.ts).
    await db.update(agents).set({ metadata: { ...metadata, [STAPLES_TEMPLATE_METADATA_KEY]: record }, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  }
  return created;
}

// ---------------------------------------------------------------------------
// Apply: connections and template tasks
// ---------------------------------------------------------------------------

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** App slugs of the company's usable (active, enabled, healthy, non-AI) connections. */
export async function connectedAppSlugs(db: Db, companyId: string): Promise<Set<string>> {
  const rows = await db.select({
    config: toolConnections.config, transportConfig: toolConnections.transportConfig, status: toolConnections.status,
    enabled: toolConnections.enabled, purpose: toolConnections.connectionPurpose, health: toolConnections.healthStatus,
    applicationMetadata: toolApplications.metadata,
  }).from(toolConnections)
    .innerJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
    .where(eq(toolConnections.companyId, companyId));
  const slugs = new Set<string>();
  for (const row of rows) {
    if (row.status !== "active" || !row.enabled || row.purpose === "ai") continue;
    if (isToolConnectionAttentionHealth(row.health as ToolConnectionHealthStatus)) continue;
    const slug = text(metadataRecord(row.config).sourceTemplateKey)
      ?? text(metadataRecord(row.transportConfig).sourceTemplateKey)
      ?? text(metadataRecord(row.applicationMetadata).sourceTemplateKey)
      ?? text(metadataRecord(row.applicationMetadata).galleryKey);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

export interface TemplateTaskSpec {
  clientKey: string;
  title: string;
  description: string;
  /** Client keys of template tasks this one waits for. */
  blockedByClientKeys: string[];
}

/**
 * A templated agent's tasks: one "Connect <service>" task per required
 * service the company has not connected, then the template's starter tasks,
 * each blocked by the connect tasks.
 */
export function templateTaskSpecs(agentClientKey: string, agentName: string, rendered: RenderedAgentTemplate, connected: ReadonlySet<string>): TemplateTaskSpec[] {
  const connect: TemplateTaskSpec[] = rendered.requiredApps
    .filter((app) => !app.optional && !app.anyOf.some((slug) => connected.has(slug)))
    .map((app) => {
      const choice = appChoiceLabel(app.anyOf);
      return {
        clientKey: `${agentClientKey}~connect-${app.capability}`,
        title: `Connect ${choice}`.slice(0, 200),
        description: [
          `${agentName} needs ${choice} connected before it can start: ${app.why}`,
          "",
          `Call \`connection_request\` for one of these services: ${app.anyOf.map((slug) => `\`${slug}\` (${appDisplayName(slug)})`).join(", ")}. A card appears for the person to choose and connect it; you are woken when it is done. Never ask for passwords, API keys or other credentials in comments.`,
          "",
          "When the service is connected, mark this task done so your other starter tasks can begin.",
        ].join("\n"),
        blockedByClientKeys: [],
      };
    });
  const blockers = connect.map((task) => task.clientKey);
  const starters = rendered.starterTasks.map((task, index) => ({
    clientKey: `${agentClientKey}~starter-${index + 1}`,
    title: task.title.slice(0, 200),
    description: task.description,
    blockedByClientKeys: blockers,
  }));
  return [...connect, ...starters];
}

/**
 * Routine text from a template, with any `{{` left by a person's answer or a
 * name broken up so it never becomes a routine variable.
 */
export function routineSafeText(value: string): string {
  return value.replace(/\{\{/g, "{ {");
}

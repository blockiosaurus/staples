import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { agents, authUsers, companies, companySkills, routines, toolApplications, toolConnections, toolPolicies, type Db } from "@paperclipai/db";
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
import { logger } from "../middleware/logger.js";
import { STAPLES_TEMPLATE_METADATA_KEY } from "../lib/staples-template-metadata.js";
import { agentTemplatesService } from "./agent-templates.js";
import { PROPOSABLE_HIRE_ADAPTER_TYPES, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { companySkillPolicyService } from "./company-skill-policy.js";
import { companySkillService, packageSkillImportKeys } from "./company-skills.js";
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
  // Rendered at the pinned version with the plan's answers: exactly what apply installs.
  const ctx = { companyName: "", personName: "", personTimezone: "UTC" };
  for (const agent of plan.data.agents) {
    if (!agent.templateRef) continue;
    let rendered: RenderedAgentTemplate;
    let name: string;
    try {
      rendered = await templates.render(agent.templateRef, agent.templateVersion ?? null, agent.templateAnswers ?? {}, ctx);
      const detail = await templates.get(agent.templateRef, { companyName: "", personName: "" });
      name = detail.version === rendered.version ? detail.name : rendered.agent.name;
    } catch {
      continue;
    }
    summaries.push({
      clientKey: agent.clientKey,
      ref: rendered.ref,
      name,
      needs: rendered.requiredApps.filter((app) => !app.optional).map((app) => appChoiceLabel(app.anyOf)),
      asksBefore: rendered.outwardActions.map((action) => action.label),
      routineCount: rendered.routines.length,
      budgetMonthlyCents: agent.budgetMonthlyCents ?? rendered.defaultBudgetMonthlyCents,
      readOnly: rendered.readOnly,
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

/** A company skill a template install created (for activity). */
export interface TemplateSkillInstall {
  id: string;
  key: string;
  slug: string;
  kind: "catalog" | "vendored";
  catalogId?: string;
  catalogKey?: string;
}

/** Where a template's vendored skill comes from, for the company skill policy. */
function vendoredSkillLocator(ref: string, slug: string) {
  return `${ref}/skills/${slug}`;
}

/** A vendored skill's files as a company skill package import expects them. */
function vendoredSkillFiles(vendored: RenderedAgentTemplate["vendoredSkills"][number]): Record<string, string> {
  return Object.fromEntries(Object.entries(vendored.files).map(([path, content]) => [`skills/${vendored.slug}/${path}`, content]));
}

/**
 * Whether install would reuse a vendored skill already in the company (same
 * key, or an earlier renamed import of it) instead of importing it.
 */
function vendoredSkillPresent(
  companyId: string,
  vendored: RenderedAgentTemplate["vendoredSkills"][number],
  existing: { keys: Set<string>; importedFrom: Set<string> },
): boolean {
  let keys: string[];
  try {
    keys = packageSkillImportKeys(companyId, vendoredSkillFiles(vendored));
  } catch {
    return false;
  }
  return keys.length > 0 && keys.every((key) => existing.keys.has(key) || existing.importedFrom.has(key));
}

/**
 * The company skill policy decision for installing a templated agent's
 * skills as the acting person, as the company-skills install and import
 * routes decide it: the platform's skill_config:update check (when the
 * request actor is known; its legacy missing-grant denials are not
 * invariants for skills) and the company skill policy for `skills.install`
 * (catalog skills not yet in the company) and `skills.import` (vendored
 * skills not yet in the company). Returns a sentence when something is denied, else null.
 */
export async function templateSkillPolicyDenial(
  db: Db, companyId: string, clientKey: string, rendered: RenderedAgentTemplate,
  person: { userId: string | null; actor?: AuthorizationActor | null },
): Promise<string | null> {
  const needed = (rendered.vendoredSkills.length > 0 || rendered.agent.skills.length > 0);
  if (!needed) return null;
  const refusal = (what: string) =>
    `Agent ${clientKey}: the company skill policy does not allow ${what}, which ${rendered.ref} needs. Change the skill policy in Skills settings or leave this agent out.`;
  if (person.actor) {
    const platform = await accessService(db).decide({
      actor: person.actor, action: "skill_config:update", resource: { type: "company", companyId },
    });
    if (!platform.allowed && !["deny_no_grant", "deny_missing_consent", "deny_missing_grant"].includes(platform.reason)) {
      return `Agent ${clientKey}: you cannot change this company's skills, which ${rendered.ref} needs.`;
    }
  }
  const policies = companySkillPolicyService(db);
  const skills = companySkillService(db);
  const principal = { type: "board" as const, id: person.userId ?? "board", role: "board" };
  const vendoredSlugs = new Set(rendered.vendoredSkills.map((skill) => skill.slug));
  // Read the rows directly: listing through the skill service syncs the bundled inventory as a side effect.
  const existingSkills = rendered.vendoredSkills.length > 0
    ? await db.select({ key: companySkills.key, metadata: companySkills.metadata }).from(companySkills).where(eq(companySkills.companyId, companyId))
    : [];
  const existing = {
    keys: new Set(existingSkills.map((skill) => skill.key)),
    importedFrom: new Set(existingSkills
      .map((skill) => metadataRecord(skill.metadata).importedFromSkillKey)
      .filter((key): key is string => typeof key === "string")),
  };
  for (const vendored of rendered.vendoredSkills) {
    // Install reuses a vendored skill already in the company, as it does for catalog skills.
    if (vendoredSkillPresent(companyId, vendored, existing)) continue;
    const decision = await policies.evaluate({
      companyId, principal, action: "skills.import",
      resource: { sourceType: "catalog", sourceLocator: vendoredSkillLocator(rendered.ref, vendored.slug) },
    });
    if (!decision.allowed) return refusal(`importing the skill ${vendored.slug}`);
  }
  for (const slug of rendered.agent.skills) {
    if (vendoredSlugs.has(slug)) continue;
    const { skill: catalogSkill } = resolveCatalogSkillReference(slug);
    if (!catalogSkill) return `Agent ${clientKey}: the template's skill ${slug} is not in the skills catalog.`;
    if (await skills.getByKey(companyId, catalogSkill.key)) continue;
    const decision = await policies.evaluate({
      companyId, principal, action: "skills.install",
      resource: { sourceType: "catalog", sourceLocator: catalogSkill.id, skillKey: catalogSkill.key },
    });
    if (!decision.allowed) return refusal(`installing the skill ${slug}`);
  }
  return null;
}

/**
 * Put the template's skills in the company library and return the company
 * skill keys to hire with, in the order the agent lists them. Vendored skills
 * are imported (an existing import is reused; a different skill holding the
 * same slug is left alone and the template's copy is imported under a new
 * slug); skills-catalog skills are installed unless already present.
 * Idempotent: a retry reuses what an earlier attempt installed.
 */
export async function ensureTemplateSkills(
  db: Db, companyId: string, rendered: RenderedAgentTemplate,
): Promise<{ keys: string[]; installed: TemplateSkillInstall[] }> {
  const skills = companySkillService(db);
  const keyBySlug = new Map<string, string>();
  const installed: TemplateSkillInstall[] = [];
  for (const vendored of rendered.vendoredSkills) {
    const files = vendoredSkillFiles(vendored);
    const [first] = await skills.importPackageFiles(companyId, files, { onConflict: "skip" });
    if (!first) throw unprocessable(`The template skill ${vendored.slug} could not be imported.`);
    if (first.action !== "skipped" || first.skill.key === first.originalKey) {
      keyBySlug.set(vendored.slug, first.skill.key);
      if (first.action !== "skipped") installed.push({ id: first.skill.id, key: first.skill.key, slug: first.skill.slug, kind: "vendored" });
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
    installed.push({ id: renamed.skill.id, key: renamed.skill.key, slug: renamed.skill.slug, kind: "vendored" });
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
      const result = await skills.installFromCatalog(companyId, { catalogSkillId: catalogSkill.id });
      keys.push(result.skill.key);
      installed.push({
        id: result.skill.id, key: result.skill.key, slug: result.skill.slug, kind: "catalog",
        catalogId: result.catalogSkill.id, catalogKey: result.catalogSkill.key,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw unprocessable(`The template's skill ${slug} could not be installed: ${reason}`);
    }
  }
  return { keys: [...new Set(keys)], installed };
}

// ---------------------------------------------------------------------------
// Apply: access rules and the template record
// ---------------------------------------------------------------------------

/** Risk levels that change something (everything but read/low). */
const NON_READ_RISK_LEVELS = ["write", "medium", "destructive", "high", "critical"] as const;
const DESTRUCTIVE_RISK_LEVELS = ["destructive", "high", "critical"] as const;
const WRITE_RISK_LEVELS = ["write", "medium"] as const;

export type TemplateRuleKind = "read_only" | "destructive" | "outward";

/**
 * Priorities of the seeded rows. The read-only and destructive guards do not
 * depend on theirs: the access decision applies them by type for the agent
 * before any ordered policy (see `agentTemplateGuardKind` in
 * tool-access-policy.ts), and a reorder never renumbers them. The outward
 * ask-first rule (50) is an ordinary ordered policy, so an explicit, narrower
 * allow for the agent (e.g. Autopilot at 45) can take its place.
 */
export const TEMPLATE_GUARD_PRIORITY = 5;
export const TEMPLATE_OUTWARD_PRIORITY = 50;

export interface TemplateAccessRule {
  kind: TemplateRuleKind;
  name: string;
  description: string;
  policyType: "block" | "require_approval";
  priority: number;
  selectors: Record<string, unknown>;
}

/**
 * The access rules a templated agent starts with, scoped to the agent. A
 * read-only template gets one read-only guard: the agent may call only
 * read-rated tools whose names lead with a read verb (list, get, search...).
 * Others get a destructive guard (always ask first for destructive calls)
 * and, at priority 50, an ask-first rule for writes whose tool name matches
 * the template's outward-action patterns (sending, publishing, deploying...).
 * Drafts and other writes are left to the company's own rules.
 */
export function templateAccessRules(agent: { id: string; name: string }, rendered: RenderedAgentTemplate): TemplateAccessRule[] {
  const label = (text: string) => `${agent.name}: ${text}`.slice(0, 140) + ` · ${agent.id.slice(0, 8)}`;
  if (rendered.readOnly) {
    return [{
      kind: "read_only", policyType: "block", priority: TEMPLATE_GUARD_PRIORITY,
      name: label("read-only"),
      description: `${agent.name} is read-only: it may only call tools that list, get, search or otherwise read, and may not change or move anything in connected services.`,
      selectors: { agentId: agent.id, riskLevels: [...NON_READ_RISK_LEVELS] },
    }];
  }
  const rules: TemplateAccessRule[] = [{
    kind: "destructive", policyType: "require_approval", priority: TEMPLATE_GUARD_PRIORITY,
    name: label("ask before deleting"),
    description: `Ask first before ${agent.name} deletes or destroys anything.`,
    selectors: { agentId: agent.id, riskLevels: [...DESTRUCTIVE_RISK_LEVELS] },
  }];
  const patterns = [...new Set(rendered.outwardActions.flatMap((action) => action.toolPatterns))];
  if (patterns.length) {
    const labels = rendered.outwardActions.map((action) => action.label.toLowerCase()).join(", ");
    rules.push({
      kind: "outward", policyType: "require_approval", priority: TEMPLATE_OUTWARD_PRIORITY,
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
      companyId, name: rule.name, description: rule.description, policyType: rule.policyType, priority: rule.priority, enabled: true,
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

export interface UsableAppConnection {
  id: string;
  appSlug: string;
  displayName: string;
}

/**
 * The company's usable connections (active, enabled, healthy, non-AI) that
 * come from a known app, oldest first.
 */
export async function usableAppConnections(db: Db, companyId: string): Promise<UsableAppConnection[]> {
  const rows = await db.select({
    id: toolConnections.id, name: toolConnections.name,
    config: toolConnections.config, transportConfig: toolConnections.transportConfig, status: toolConnections.status,
    enabled: toolConnections.enabled, purpose: toolConnections.connectionPurpose, health: toolConnections.healthStatus,
    applicationMetadata: toolApplications.metadata,
  }).from(toolConnections)
    .innerJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
    .where(eq(toolConnections.companyId, companyId))
    .orderBy(asc(toolConnections.createdAt), asc(toolConnections.id));
  const usable: UsableAppConnection[] = [];
  for (const row of rows) {
    if (row.status !== "active" || !row.enabled || row.purpose === "ai") continue;
    if (isToolConnectionAttentionHealth(row.health as ToolConnectionHealthStatus)) continue;
    const slug = text(metadataRecord(row.config).sourceTemplateKey)
      ?? text(metadataRecord(row.transportConfig).sourceTemplateKey)
      ?? text(metadataRecord(row.applicationMetadata).sourceTemplateKey)
      ?? text(metadataRecord(row.applicationMetadata).galleryKey);
    if (slug) usable.push({ id: row.id, appSlug: slug, displayName: text(row.name) ?? appDisplayName(slug) });
  }
  return usable;
}

/** App slugs of the company's usable (active, enabled, healthy, non-AI) connections. */
export async function connectedAppSlugs(db: Db, companyId: string): Promise<Set<string>> {
  return new Set((await usableAppConnections(db, companyId)).map((connection) => connection.appSlug));
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

/** `routines.originKind` for routines installed from an agent template; `originId` is the agent id. */
export const AGENT_TEMPLATE_ROUTINE_ORIGIN = "agent_template";

/**
 * Record that a template routine could not be started after the hire was
 * approved (activity `routine.activation_failed` on the agent), so the person
 * sees it and can resume the routine. Never throws.
 */
export async function logTemplateRoutineActivationFailure(
  db: Db,
  input: { companyId: string; agentId: string; userId: string | null; routine?: { id: string; title: string } | null; error: unknown },
): Promise<void> {
  try {
    const { logActivity } = await import("./activity-log.js");
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await logActivity(db, {
      companyId: input.companyId, actorType: input.userId ? "user" : "system", actorId: input.userId ?? "system",
      action: "routine.activation_failed", entityType: "agent", entityId: input.agentId,
      details: {
        ...(input.routine ? { routineId: input.routine.id, title: input.routine.title } : {}),
        source: "agent_template_hire_approved",
        error: message.slice(0, 500),
      },
    });
  } catch (error) {
    logger.warn({ err: error, agentId: input.agentId }, "could not record a template routine activation failure");
  }
}

/**
 * After a templated agent's hire is approved: assign the template routines
 * that plans/apply created paused (and unassigned) to it, and resume them.
 * Routines the person already changed (assigned elsewhere, archived) are
 * left alone. Best effort: a failure is logged, never fails the approval.
 */
export async function activateTemplateRoutinesAfterHire(db: Db, agentId: string, userId: string | null): Promise<string[]> {
  const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status, metadata: agents.metadata })
    .from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.status === "pending_approval" || agent.status === "terminated") return [];
  if (metadataRecord(agent.metadata)[STAPLES_TEMPLATE_METADATA_KEY] === undefined) return [];
  const pending = await db.select({
    id: routines.id, title: routines.title, responsibleUserId: routines.responsibleUserId, createdByUserId: routines.createdByUserId,
  }).from(routines).where(and(
    eq(routines.companyId, agent.companyId),
    eq(routines.originKind, AGENT_TEMPLATE_ROUTINE_ORIGIN),
    eq(routines.originId, agent.id),
    eq(routines.status, "paused"),
    isNull(routines.assigneeAgentId),
  ));
  if (!pending.length) return [];
  const { routineService } = await import("./routines.js");
  const { logActivity } = await import("./activity-log.js");
  const svc = routineService(db);
  const resumed: string[] = [];
  for (const routine of pending) {
    try {
      // The approver, else the person who applied the plan (a routine needs a responsible person).
      const actingUserId = userId ?? routine.responsibleUserId ?? routine.createdByUserId ?? null;
      const updated = await svc.update(routine.id, { assigneeAgentId: agent.id, status: "active" }, { agentId: null, userId: actingUserId, runId: null });
      if (!updated) continue;
      resumed.push(routine.id);
      await logActivity(db, {
        companyId: agent.companyId, actorType: "user", actorId: actingUserId ?? "board", action: "routine.updated",
        entityType: "routine", entityId: routine.id,
        details: { title: routine.title, assigneeAgentId: agent.id, status: "active", source: "agent_template_hire_approved" },
      });
    } catch (error) {
      logger.warn({ err: error, routineId: routine.id, agentId }, "could not resume a template routine after hire approval");
      await logTemplateRoutineActivationFailure(db, { companyId: agent.companyId, agentId: agent.id, userId, routine, error });
    }
  }
  return resumed;
}

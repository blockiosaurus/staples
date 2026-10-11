import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, approvals, companySecrets, issues, toolConnections, type Db } from "@paperclipai/db";
import { PROPOSABLE_HIRE_ADAPTER_TYPES, resolveCompanyAssistantAgentId } from "./assistant-identity.js";
import { companyBriefService } from "./company-brief.js";
import {
  AGENT_ROLES,
  COMPANY_BRIEF_MAX_CHARS,
  applyPlanSchema,
  isAssistantAgent,
  planStructureErrors,
  proposedActionBodyMaxBytes,
  type ApplyPlan,
  type ProposedActionCategory,
  type ProposedActionMethod,
} from "@paperclipai/shared";

/**
 * Governed actions the Assistant may *propose*. The Assistant never executes
 * these: it creates a request_confirmation card carrying the exact call, and
 * the person's browser performs it with their own session after Confirm. The
 * server routes still enforce the person's authorization on execution; this
 * allowlist bounds what can be put in front of the person at all.
 *
 * Every pattern is company-bound: the company comes from the path directly
 * (`/api/companies/:companyId/...`) or from the referenced entity's row, and
 * must equal the Assistant run's company.
 */

export type ProposedActionEntity = "approval" | "agent" | "issue" | "secret" | "tool_connection";

/** Where a path's company comes from: a path segment, or the row of the entity in a path segment. */
type CompanyBinding = { kind: "company"; group: number } | { kind: "entity"; entity: ProposedActionEntity; group: number };

export type GovernedRoutePattern = {
  method: ProposedActionMethod;
  pattern: RegExp;
  category: ProposedActionCategory;
  binding: CompanyBinding;
  /** Human label for docs and errors. */
  route: string;
  /** Secrets: a proposal never carries a secret value; the person enters values in Secrets settings. Checked at every depth. */
  forbidBodyKeys?: readonly string[];
  /** Route-specific body rules; throws ProposedActionError. */
  validateBody?: (body: unknown) => void;
  /** Body rules that read this company's rows (run after the company binding check); throws ProposedActionError. */
  validateBodyWithDb?: (db: Db, body: unknown, companyId: string) => Promise<void>;
};

const BRIEF_BODY_KEYS = new Set(["body", "baseRevisionId"]);
const UUID_VALUE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The whole new brief, optionally pinned to the revision it replaces. */
function assertSafeBriefUpdate(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProposedActionError("A brief proposal needs a JSON object body: { body, baseRevisionId? }.");
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !BRIEF_BODY_KEYS.has(key));
  if (extra.length) throw new ProposedActionError(`A brief proposal may only carry body and baseRevisionId (not ${extra.join(", ")}).`);
  if (typeof record.body !== "string") throw new ProposedActionError("body must be text: the whole new brief in markdown.");
  if (record.body.length > COMPANY_BRIEF_MAX_CHARS) {
    throw new ProposedActionError(`The brief is limited to ${COMPANY_BRIEF_MAX_CHARS} characters.`);
  }
  if (record.baseRevisionId !== undefined && record.baseRevisionId !== null
    && (typeof record.baseRevisionId !== "string" || !UUID_VALUE.test(record.baseRevisionId))) {
    throw new ProposedActionError("baseRevisionId must be the revisionId from staples_get_company_brief.");
  }
}

/** Upper bound for any budget amount the Assistant may propose, in cents. */
export const PROPOSED_BUDGET_MAX_CENTS = 10_000_000;

/** Every key path in a JSON value (objects and arrays, at any depth). */
function findKeysDeep(value: unknown, keys: ReadonlySet<string>, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) findKeysDeep(item, keys, found);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key)) found.add(key);
      findKeysDeep(child, keys, found);
    }
  }
  return found;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function assertBudgetAmounts(body: unknown, keys: readonly string[]) {
  const record = bodyRecord(body);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > PROPOSED_BUDGET_MAX_CENTS) {
      throw new ProposedActionError(`${key} must be a whole number of cents between 0 and ${PROPOSED_BUDGET_MAX_CENTS}.`);
    }
  }
}

function assertNoBody(body: unknown) {
  if (body !== null && body !== undefined) throw new ProposedActionError("This action takes no request body; propose it with body null.");
}

/**
 * Agent create/hire bodies are an allowlist: identity, reporting line, budget
 * and a local CLI adapter type. Adapter config, runtime/workspace settings,
 * permissions, instructions, environments and metadata can run host commands
 * or widen authority, so the person sets them in the agent's settings.
 */
const AGENT_CREATE_ALLOWED_KEYS = new Set([
  "name", "role", "title", "icon", "capabilities", "reportsTo", "budgetMonthlyCents", "adapterType",
]);
const AGENT_CREATE_STRING_KEYS = ["name", "role", "title", "icon", "capabilities"] as const;
const AGENT_SETTINGS_HINT = "Configure adapters, permissions and instructions in the agent's settings after hiring.";

/**
 * Roles that authorization code treats specially. `ceo` alone today:
 * canCreateAgents (services/authorization.ts), task assignment
 * (routes/agents.ts buildAgentAccessState), checkout management
 * (authorization.ts), workspace runtime control
 * (routes/workspace-runtime-service-authz.ts), and company/access/issue
 * routes that gate on `role === "ceo"`. The Assistant may only propose the
 * remaining roles from AGENT_ROLES.
 */
export const PRIVILEGED_AGENT_ROLES: readonly string[] = ["ceo"];
export const PROPOSABLE_AGENT_ROLES: readonly string[] = AGENT_ROLES.filter((role) => !PRIVILEGED_AGENT_ROLES.includes(role));

function assertSafeAgentCreate(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProposedActionError("An agent proposal needs a JSON object body.");
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !AGENT_CREATE_ALLOWED_KEYS.has(key));
  if (extra.length) {
    throw new ProposedActionError(`The Assistant cannot propose ${extra.join(", ")} for an agent. ${AGENT_SETTINGS_HINT}`);
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new ProposedActionError("An agent proposal needs a name.");
  }
  for (const key of AGENT_CREATE_STRING_KEYS) {
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") {
      throw new ProposedActionError(`${key} must be text.`);
    }
  }
  if (record.reportsTo !== undefined && record.reportsTo !== null && typeof record.reportsTo !== "string") {
    throw new ProposedActionError("reportsTo must be an agent id.");
  }
  if (typeof record.role === "string" && PRIVILEGED_AGENT_ROLES.includes(record.role.trim().toLowerCase())) {
    throw new ProposedActionError("Hiring a CEO-level agent must be done in the Agents page.");
  }
  if (record.role !== undefined && record.role !== null && !PROPOSABLE_AGENT_ROLES.includes(record.role as string)) {
    throw new ProposedActionError(`role must be one of ${PROPOSABLE_AGENT_ROLES.join(", ")}, or omitted.`);
  }
  // Omitting adapterType makes the route default to "process", which runs a host command.
  if (record.adapterType === undefined || record.adapterType === null) {
    throw new ProposedActionError(`adapterType is required: one of ${PROPOSABLE_HIRE_ADAPTER_TYPES.join(", ")}.`);
  }
  if (!(PROPOSABLE_HIRE_ADAPTER_TYPES as readonly unknown[]).includes(record.adapterType)) {
    throw new ProposedActionError(`adapterType must be one of ${PROPOSABLE_HIRE_ADAPTER_TYPES.join(", ")}. ${AGENT_SETTINGS_HINT}`);
  }
  assertBudgetAmounts(body, ["budgetMonthlyCents"]);
}

/**
 * Hire rules for a plan's new agents, the same as a single agent proposal:
 * a non-privileged role and a proposable local CLI adapter. Returns the first
 * violation as a sentence, or null. Shared by the governed allowlist (at
 * proposal and claim) and by POST /plans/apply itself.
 */
export function planRuleViolation(plan: ApplyPlan): string | null {
  for (const agent of plan.agents) {
    const role = agent.role.trim().toLowerCase();
    if (PRIVILEGED_AGENT_ROLES.includes(role)) {
      return `Agent ${agent.clientKey}: hiring a CEO-level agent must be done in the Agents page.`;
    }
    if (!PROPOSABLE_AGENT_ROLES.includes(agent.role)) {
      return `Agent ${agent.clientKey}: role must be one of ${PROPOSABLE_AGENT_ROLES.join(", ")}.`;
    }
    if (!(PROPOSABLE_HIRE_ADAPTER_TYPES as readonly string[]).includes(agent.adapterType)) {
      return `Agent ${agent.clientKey}: adapterType must be one of ${PROPOSABLE_HIRE_ADAPTER_TYPES.join(", ")}. ${AGENT_SETTINGS_HINT}`;
    }
  }
  return null;
}

/** Parse a plan body: the schema, its references and ordering, and the hire rules. Throws ProposedActionError. */
export function parseProposablePlan(body: unknown): ApplyPlan {
  const parsed = applyPlanSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ProposedActionError(`The plan is not valid: ${issues.join("; ")}.`);
  }
  const structure = planStructureErrors(parsed.data);
  if (structure.length) throw new ProposedActionError(`The plan is not consistent: ${structure.slice(0, 5).join(" ")}`);
  const violation = planRuleViolation(parsed.data);
  if (violation) throw new ProposedActionError(violation);
  return parsed.data;
}

function assertSafePlan(body: unknown) {
  parseProposablePlan(body);
}

/** Existing agents a plan assigns tasks to: in this company, and never the Assistant. */
export async function planExistingAssigneeViolation(db: Db, plan: ApplyPlan, companyId: string): Promise<string | null> {
  const ids = [...new Set(plan.tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return null;
  const rows = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
  const found = new Map(rows.map((row) => [row.id, row] as const));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return `assigneeAgentId ${missing.join(", ")} is not an agent in this company.`;
  const assistantId = await resolveCompanyAssistantAgentId(db, companyId);
  if (rows.some((row) => row.id === assistantId || isAssistantAgent(row))) {
    return "Tasks cannot be assigned to the Assistant. Choose a staff agent from paperclip_list_agents.";
  }
  return null;
}

async function assertPlanAssignees(db: Db, body: unknown, companyId: string) {
  const violation = await planExistingAssigneeViolation(db, applyPlanSchema.parse(body), companyId);
  if (violation) throw new ProposedActionError(violation);
}

/**
 * Secret updates may rename, describe or enable/disable a secret. Anything
 * that changes what the secret resolves to (its key, value, external
 * reference or provider) is refused at any depth.
 */
const SECRET_UPDATE_ALLOWED_KEYS = new Set(["name", "description", "status"]);
const SECRET_POINTER_KEYS = new Set(["externalRef", "providerConfigId", "providerMetadata", "providerVersionRef", "key", "value"]);
const SECRET_POINTER_MESSAGE = "Change where a secret points in Secrets settings.";

function assertSafeSecretUpdate(body: unknown) {
  if (findKeysDeep(body, SECRET_POINTER_KEYS).size) throw new ProposedActionError(SECRET_POINTER_MESSAGE);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
    throw new ProposedActionError("A secret update may only change its name, description or status.");
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !SECRET_UPDATE_ALLOWED_KEYS.has(key));
  if (extra.length) {
    throw new ProposedActionError(`A secret update may only change its name, description or status (not ${extra.join(", ")}). ${SECRET_POINTER_MESSAGE}`);
  }
  if (record.name !== undefined && (typeof record.name !== "string" || !record.name.trim())) throw new ProposedActionError("name must be text.");
  if (record.description !== undefined && record.description !== null && typeof record.description !== "string") throw new ProposedActionError("description must be text or null.");
  if (record.status !== undefined && typeof record.status !== "string") throw new ProposedActionError("status must be text.");
}

const UUID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const SEGMENT = "[A-Za-z0-9._~-]+";
const re = (source: string) => new RegExp(`^${source}$`);
const company = (group = 1): CompanyBinding => ({ kind: "company", group });
const entity = (name: ProposedActionEntity, group = 1): CompanyBinding => ({ kind: "entity", entity: name, group });

/** Derived from server/src/routes/{approvals,agents,costs,secrets,tool-access}.ts. Order matters: first match wins. */
export const GOVERNED_ROUTE_PATTERNS: readonly GovernedRoutePattern[] = [
  // approvals.ts
  { method: "POST", pattern: re(`/api/approvals/${UUID}/approve`), category: "approval", binding: entity("approval"), route: "POST /api/approvals/:id/approve" },
  { method: "POST", pattern: re(`/api/approvals/${UUID}/reject`), category: "approval", binding: entity("approval"), route: "POST /api/approvals/:id/reject" },
  { method: "POST", pattern: re(`/api/approvals/${UUID}/request-revision`), category: "approval", binding: entity("approval"), route: "POST /api/approvals/:id/request-revision" },
  // agents.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/agent-hires`), category: "agent_lifecycle", binding: company(), route: "POST /api/companies/:companyId/agent-hires", validateBody: assertSafeAgentCreate },
  { method: "POST", pattern: re(`/api/companies/${UUID}/agents`), category: "agent_lifecycle", binding: company(), route: "POST /api/companies/:companyId/agents", validateBody: assertSafeAgentCreate },
  { method: "POST", pattern: re(`/api/agents/${UUID}/pause`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/pause" },
  { method: "POST", pattern: re(`/api/agents/${UUID}/resume`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/resume" },
  { method: "POST", pattern: re(`/api/agents/${UUID}/terminate`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/terminate" },
  // costs.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/budgets/policies`), category: "budget", binding: company(), route: "POST /api/companies/:companyId/budgets/policies", validateBody: (body) => assertBudgetAmounts(body, ["amount", "reservationCents"]) },
  { method: "PATCH", pattern: re(`/api/companies/${UUID}/budgets`), category: "budget", binding: company(), route: "PATCH /api/companies/:companyId/budgets", validateBody: (body) => assertBudgetAmounts(body, ["budgetMonthlyCents"]) },
  { method: "PATCH", pattern: re(`/api/agents/${UUID}/budgets`), category: "budget", binding: entity("agent"), route: "PATCH /api/agents/:agentId/budgets", validateBody: (body) => assertBudgetAmounts(body, ["budgetMonthlyCents"]) },
  // company-brief.ts
  { method: "PUT", pattern: re(`/api/companies/${UUID}/brief`), category: "brief", binding: company(), route: "PUT /api/companies/:companyId/brief", validateBody: assertSafeBriefUpdate },
  // plans.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/plans/apply`), category: "plan", binding: company(), route: "POST /api/companies/:companyId/plans/apply", validateBody: assertSafePlan, validateBodyWithDb: assertPlanAssignees },
  // secrets.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/secrets`), category: "secret", binding: company(), route: "POST /api/companies/:companyId/secrets", forbidBodyKeys: ["value"] },
  { method: "PATCH", pattern: re(`/api/secrets/${UUID}`), category: "secret", binding: entity("secret"), route: "PATCH /api/secrets/:id", validateBody: assertSafeSecretUpdate },
  { method: "DELETE", pattern: re(`/api/secrets/${UUID}`), category: "secret", binding: entity("secret"), route: "DELETE /api/secrets/:id" },
  // tool-access.ts: revocations only, and only without a body. Creating or
  // changing connections and grants happens in the Connectors UI.
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId", validateBody: assertNoBody },
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}/grants/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId/grants/:grantId", validateBody: assertNoBody },
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}/grants/${UUID}/delegations/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId/grants/:grantId/delegations/:delegationId", validateBody: assertNoBody },
  // Generic deletes scoped to this company or one of its issues, without a
  // body. Routes that need a delete body (decision queue items, inbox
  // archive, queued comments, AI connection pools) are therefore not
  // proposable; neither are the excluded deletes below.
  { method: "DELETE", pattern: re(`/api/companies/${UUID}(?:/${SEGMENT})+`), category: "delete", binding: company(), route: "DELETE /api/companies/:companyId/...", validateBody: assertNoBody },
  { method: "DELETE", pattern: re(`/api/issues/${UUID}(?:/${SEGMENT})*`), category: "delete", binding: entity("issue"), route: "DELETE /api/issues/:id[/...]", validateBody: assertNoBody },
];

/**
 * Deletes the generic patterns would otherwise admit but that loosen a
 * guardrail or edit skill content. Case-insensitive because Express routes
 * case-insensitively. Checked before the allowlist.
 */
const EXCLUDED_DELETES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: new RegExp(`^/api/companies/${UUID}/tools/policies(?:/${SEGMENT})*$`, "i"), message: "This removes a safety control; do it from the app." },
  { pattern: new RegExp(`^/api/companies/${UUID}/skill-policy(?:/${SEGMENT})*$`, "i"), message: "This removes a safety control; do it from the app." },
  { pattern: new RegExp(`^/api/issues/${UUID}/approvals(?:/${SEGMENT})*$`, "i"), message: "This removes a safety control; do it from the app." },
  { pattern: new RegExp(`^/api/issues/${UUID}/watchdog(?:/${SEGMENT})*$`, "i"), message: "This removes a safety control; do it from the app." },
  { pattern: new RegExp(`^/api/companies/${UUID}/skills/${SEGMENT}/files(?:/${SEGMENT})*$`, "i"), message: "The Assistant cannot propose deleting skill files; edit the skill from the app." },
];

/** GET paths a stale check may read: an entity by id, or anything under this company. */
const STALE_CHECK_PATTERNS: ReadonlyArray<{ pattern: RegExp; binding: CompanyBinding }> = [
  { pattern: re(`/api/approvals/${UUID}`), binding: entity("approval") },
  { pattern: re(`/api/agents/${UUID}`), binding: entity("agent") },
  { pattern: re(`/api/issues/${UUID}`), binding: entity("issue") },
  { pattern: re(`/api/secrets/${UUID}`), binding: entity("secret") },
  { pattern: re(`/api/tool-connections/${UUID}`), binding: entity("tool_connection") },
  { pattern: re(`/api/companies/${UUID}(?:/${SEGMENT})*`), binding: company() },
];

export class ProposedActionError extends Error {}

/** POST /api/approvals/:id/{approve,reject,request-revision}; group 1 is the approval id. */
export const APPROVAL_DECISION_PATH = /^\/api\/approvals\/([0-9a-fA-F-]{36})\/(?:approve|reject|request-revision)$/;
export const APPROVAL_CHANGED_MESSAGE = "The approval changed since the Assistant proposed this.";

/** PUT /api/companies/:companyId/brief; group 1 is the company id. */
export const BRIEF_UPDATE_PATH = /^\/api\/companies\/([0-9a-fA-F-]{36})\/brief$/;
export const BRIEF_CHANGED_MESSAGE = "The brief changed since the Assistant proposed this.";

/** The brief's current revision, or null when the company has no brief. */
export async function currentBriefRevisionId(db: Db, companyId: string): Promise<string | null> {
  const brief = await companyBriefService(db).get(companyId);
  return brief ? brief.revisionId : null;
}

/**
 * Pin a brief proposal to the brief the Assistant is replacing: the server
 * sets baseRevisionId to the current revision (absent when there is no brief).
 * A different base from the Assistant means it read an older brief.
 */
/** A brief already exists, so a proposal must say which revision it replaces (never silently pinned). */
export const BRIEF_BASE_REQUIRED_MESSAGE = "A company brief already exists. Read it with staples_get_company_brief and pass its revisionId as baseRevisionId, keeping what the person did not ask to change.";

export async function pinBriefProposalBody(db: Db, companyId: string, body: unknown): Promise<Record<string, unknown>> {
  const record = { ...(body as Record<string, unknown>) };
  const current = await currentBriefRevisionId(db, companyId);
  const proposed = typeof record.baseRevisionId === "string" ? record.baseRevisionId : null;
  if (!proposed && current) throw new ProposedActionError(BRIEF_BASE_REQUIRED_MESSAGE);
  if (proposed && proposed !== current) {
    throw new ProposedActionError("The brief changed since you read it. Read it again with staples_get_company_brief and redo the edit.");
  }
  delete record.baseRevisionId;
  return current ? { ...record, baseRevisionId: current } : record;
}

/** POST /api/companies/:companyId/plans/apply; group 1 is the company id. */
export const PLAN_APPLY_PATH = /^\/api\/companies\/([0-9a-fA-F-]{36})\/plans\/apply$/;
export const PLAN_BRIEF_CHANGED_MESSAGE = "The brief changed since the Assistant proposed this plan.";

/**
 * Pin a plan's brief to the brief it replaces, like pinBriefProposalBody: the
 * server sets brief.baseRevisionId to the current revision (null when there
 * is none). A different non-null base from the Assistant means it read an
 * older brief; a missing or null base while a brief exists means it never
 * read it, and is refused too. Plans without a brief are returned unchanged.
 */
export async function pinPlanProposalBody(db: Db, companyId: string, body: unknown): Promise<unknown> {
  const record = body as Record<string, unknown>;
  const brief = record?.brief as Record<string, unknown> | undefined;
  if (!brief) return body;
  const current = await currentBriefRevisionId(db, companyId);
  const proposed = typeof brief.baseRevisionId === "string" ? brief.baseRevisionId : null;
  if (!proposed && current) throw new ProposedActionError(BRIEF_BASE_REQUIRED_MESSAGE);
  if (proposed && proposed !== current) {
    throw new ProposedActionError("The brief changed since you read it. Read it again with staples_get_company_brief and redo the plan's brief.");
  }
  return { ...record, brief: { ...brief, baseRevisionId: current } };
}

/** True when a stored plan proposal's brief (if any) still replaces the current brief. */
export async function planProposalIsCurrent(db: Db, companyId: string, body: unknown): Promise<boolean> {
  const brief = (body as Record<string, unknown> | null)?.brief as Record<string, unknown> | undefined;
  if (!brief) return true;
  const stored = typeof brief.baseRevisionId === "string" ? brief.baseRevisionId : null;
  return stored === await currentBriefRevisionId(db, companyId);
}

/** True when the stored brief proposal still replaces the current brief. */
export async function briefProposalIsCurrent(db: Db, companyId: string, body: unknown): Promise<boolean> {
  const stored = body && typeof body === "object" ? (body as Record<string, unknown>).baseRevisionId : undefined;
  const current = await currentBriefRevisionId(db, companyId);
  return (typeof stored === "string" ? stored : null) === current;
}

/**
 * Structural path rules applied before pattern matching: a plain `/api/...`
 * path of unreserved characters only. No query string, fragment, percent
 * encoding, empty segment, or dot segment can smuggle a different route past
 * the anchored patterns.
 */
function assertPlainApiPath(path: string, label: string) {
  if (!/^\/api(?:\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new ProposedActionError(`${label} must be a plain /api/... path without a query string, encoding or empty segments.`);
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ProposedActionError(`${label} cannot contain . or .. segments.`);
  }
}

export function matchGovernedRoute(method: string, path: string): GovernedRoutePattern & { match: RegExpExecArray } {
  assertPlainApiPath(path, "path");
  if (method === "DELETE") {
    const excluded = EXCLUDED_DELETES.find((entry) => entry.pattern.test(path));
    if (excluded) throw new ProposedActionError(excluded.message);
  }
  for (const route of GOVERNED_ROUTE_PATTERNS) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) return { ...route, match };
  }
  throw new ProposedActionError(
    `${method} ${path} is not a governed action the Assistant can propose. Allowed: ${GOVERNED_ROUTE_PATTERNS.map((r) => r.route).join("; ")}.`,
  );
}

async function entityCompanyId(db: Db, kind: ProposedActionEntity, id: string): Promise<string | null> {
  const lookup = async (table: typeof approvals | typeof agents | typeof issues | typeof companySecrets | typeof toolConnections) => {
    const [row] = await db.select({ companyId: table.companyId }).from(table).where(eq(table.id, id));
    return row?.companyId ?? null;
  };
  switch (kind) {
    case "approval": return lookup(approvals);
    case "agent": return lookup(agents);
    case "issue": return lookup(issues);
    case "secret": return lookup(companySecrets);
    case "tool_connection": return lookup(toolConnections);
  }
}

async function assertBindingCompany(db: Db, binding: CompanyBinding, match: RegExpExecArray, companyId: string, label: string) {
  const value = match[binding.group]!.toLowerCase();
  const resolved = binding.kind === "company" ? value : await entityCompanyId(db, binding.entity, value);
  if (!resolved || resolved !== companyId) {
    throw new ProposedActionError(`${label} must refer to this company${binding.kind === "entity" ? ` (the referenced ${binding.entity.replace("_", " ")} was not found in it)` : ""}.`);
  }
}

/** Throws ProposedActionError unless the call is allowlisted and bound to `companyId`. */
export async function validateGovernedAction(
  db: Db,
  input: { method: string; path: string; body: unknown; staleCheckPath?: string | null },
  companyId: string,
): Promise<{ category: ProposedActionCategory; route: string }> {
  const route = matchGovernedRoute(input.method, input.path);
  const serialized = JSON.stringify(input.body ?? null);
  const maxBytes = proposedActionBodyMaxBytes(route.category);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ProposedActionError(`body is larger than ${maxBytes} bytes.`);
  }
  if (route.forbidBodyKeys) {
    const present = [...findKeysDeep(input.body, new Set(route.forbidBodyKeys))];
    if (present.length) {
      throw new ProposedActionError(`The Assistant never handles secret values (${present.join(", ")}). Propose the change without it; the person enters values in Secrets settings.`);
    }
  }
  route.validateBody?.(input.body);
  await assertBindingCompany(db, route.binding, route.match, companyId, "path");
  await route.validateBodyWithDb?.(db, input.body, companyId);
  if (input.staleCheckPath) {
    assertPlainApiPath(input.staleCheckPath, "staleCheck.path");
    const check = STALE_CHECK_PATTERNS.map((c) => ({ ...c, match: c.pattern.exec(input.staleCheckPath!) })).find((c) => c.match);
    if (!check) throw new ProposedActionError("staleCheck.path must read an approval, agent, issue, secret or connection by id, or a path under this company.");
    await assertBindingCompany(db, check.binding, check.match!, companyId, "staleCheck.path");
  }
  return { category: route.category, route: route.route };
}

/**
 * Canonical JSON used for proposal hashes: object keys sorted by UTF-16 code
 * unit order (JavaScript's default sort) at every depth, array order kept,
 * `undefined` object members dropped, no whitespace, and primitives encoded
 * by JSON.stringify. Non-finite numbers are rejected rather than coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProposedActionError("JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ProposedActionError("Proposed action bodies must be JSON.");
}

/** sha256 hex of canonicalJson({ method, path, body }). */
export function proposedActionHash(input: { method: string; path: string; body: unknown }) {
  return createHash("sha256").update(canonicalJson({ method: input.method, path: input.path, body: input.body ?? null })).digest("hex");
}

/** Card details: method, path and the pretty-printed body, bounded to the payload's markdown limit. */
export function proposedActionDetailsMarkdown(input: { method: string; path: string; body: unknown }) {
  const pretty = input.body === null || input.body === undefined ? null : JSON.stringify(input.body, null, 2);
  const limit = 16_000;
  const shown = pretty && pretty.length > limit ? `${pretty.slice(0, limit)}\n… (truncated)` : pretty;
  return [`**${input.method}** \`${input.path}\``, shown ? `\n\`\`\`json\n${shown.replaceAll("```", "`​``")}\n\`\`\`` : "\n_No request body._"].join("\n");
}

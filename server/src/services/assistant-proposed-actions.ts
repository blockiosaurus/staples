import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, approvals, companySecrets, issues, toolConnections, type Db } from "@paperclipai/db";
import {
  PROPOSED_ACTION_BODY_MAX_BYTES,
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
  /** Secrets: a proposal never carries a secret value; the person enters values in Secrets settings. */
  forbidBodyKeys?: readonly string[];
};

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
  { method: "POST", pattern: re(`/api/companies/${UUID}/agent-hires`), category: "agent_lifecycle", binding: company(), route: "POST /api/companies/:companyId/agent-hires" },
  { method: "POST", pattern: re(`/api/companies/${UUID}/agents`), category: "agent_lifecycle", binding: company(), route: "POST /api/companies/:companyId/agents" },
  { method: "POST", pattern: re(`/api/agents/${UUID}/pause`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/pause" },
  { method: "POST", pattern: re(`/api/agents/${UUID}/resume`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/resume" },
  { method: "POST", pattern: re(`/api/agents/${UUID}/terminate`), category: "agent_lifecycle", binding: entity("agent"), route: "POST /api/agents/:id/terminate" },
  // costs.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/budgets/policies`), category: "budget", binding: company(), route: "POST /api/companies/:companyId/budgets/policies" },
  { method: "PATCH", pattern: re(`/api/companies/${UUID}/budgets`), category: "budget", binding: company(), route: "PATCH /api/companies/:companyId/budgets" },
  { method: "PATCH", pattern: re(`/api/agents/${UUID}/budgets`), category: "budget", binding: entity("agent"), route: "PATCH /api/agents/:agentId/budgets" },
  // secrets.ts
  { method: "POST", pattern: re(`/api/companies/${UUID}/secrets`), category: "secret", binding: company(), route: "POST /api/companies/:companyId/secrets", forbidBodyKeys: ["value"] },
  { method: "PATCH", pattern: re(`/api/secrets/${UUID}`), category: "secret", binding: entity("secret"), route: "PATCH /api/secrets/:id", forbidBodyKeys: ["value"] },
  { method: "DELETE", pattern: re(`/api/secrets/${UUID}`), category: "secret", binding: entity("secret"), route: "DELETE /api/secrets/:id" },
  // tool-access.ts (connections and their grants)
  { method: "POST", pattern: re(`/api/companies/${UUID}/tools/connections`), category: "connection", binding: company(), route: "POST /api/companies/:companyId/tools/connections" },
  { method: "PATCH", pattern: re(`/api/tool-connections/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "PATCH /api/tool-connections/:connectionId" },
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId" },
  { method: "POST", pattern: re(`/api/tool-connections/${UUID}/grants/installations`), category: "connection", binding: entity("tool_connection"), route: "POST /api/tool-connections/:connectionId/grants/installations" },
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}/grants/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId/grants/:grantId" },
  { method: "POST", pattern: re(`/api/tool-connections/${UUID}/grants/${UUID}/delegations`), category: "connection", binding: entity("tool_connection"), route: "POST /api/tool-connections/:connectionId/grants/:grantId/delegations" },
  { method: "DELETE", pattern: re(`/api/tool-connections/${UUID}/grants/${UUID}/delegations/${UUID}`), category: "connection", binding: entity("tool_connection"), route: "DELETE /api/tool-connections/:connectionId/grants/:grantId/delegations/:delegationId" },
  // Generic deletes scoped to this company or one of its issues.
  { method: "DELETE", pattern: re(`/api/companies/${UUID}(?:/${SEGMENT})+`), category: "delete", binding: company(), route: "DELETE /api/companies/:companyId/..." },
  { method: "DELETE", pattern: re(`/api/issues/${UUID}(?:/${SEGMENT})*`), category: "delete", binding: entity("issue"), route: "DELETE /api/issues/:id[/...]" },
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
  if (Buffer.byteLength(serialized, "utf8") > PROPOSED_ACTION_BODY_MAX_BYTES) {
    throw new ProposedActionError(`body is larger than ${PROPOSED_ACTION_BODY_MAX_BYTES} bytes.`);
  }
  if (route.forbidBodyKeys && input.body && typeof input.body === "object" && !Array.isArray(input.body)) {
    const present = route.forbidBodyKeys.filter((key) => Object.prototype.hasOwnProperty.call(input.body, key));
    if (present.length) {
      throw new ProposedActionError(`The Assistant never handles secret values (${present.join(", ")}). Propose the change without it; the person enters values in Secrets settings.`);
    }
  }
  await assertBindingCompany(db, route.binding, route.match, companyId, "path");
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

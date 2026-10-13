import type { Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { DEFAULT_SELF_SERVE_ADAPTER_TYPES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

/**
 * Self-serve floor (PAPERCLIP_SELF_SERVE_COMPANIES).
 *
 * When any signed-in user can create a company, its owner is not a trusted
 * operator. A company created that way is marked `companies.self_serve`, and
 * while the flag is on every such company is held to this floor, whatever the
 * actor (owner, instance admin or agent):
 *
 * - agents may only use the remote adapters in PAPERCLIP_SELF_SERVE_ADAPTERS
 *   (never `process` or a `*_local` CLI, which execute on the server host);
 * - their config may not override a base URL or endpoint (server-side fetch,
 *   i.e. SSRF), nor carry host-executed workspace commands;
 * - other host-execution surfaces (workspace commands, server folders, stdio
 *   tools, imports) are refused.
 *
 * Enforcement sits where every path converges: agent record create and
 * configuration update, hire activation, approval creation, built-in
 * provisioning, and a runtime backstop at heartbeat dispatch. Admin-created
 * companies keep normal behaviour, and nothing changes when the flag is off.
 */
export type SelfServePolicy = {
  enabled: boolean;
  adapterTypes: readonly string[];
};

const DISABLED: SelfServePolicy = { enabled: false, adapterTypes: [] };
// Process-wide, so every module instance (tests load isolated graphs) agrees.
const POLICY_KEY = Symbol.for("paperclip.selfServePolicy");
type PolicyHolder = { [POLICY_KEY]?: SelfServePolicy };
function readPolicy(): SelfServePolicy {
  return (globalThis as PolicyHolder)[POLICY_KEY] ?? DISABLED;
}
function writePolicy(policy: SelfServePolicy) {
  (globalThis as PolicyHolder)[POLICY_KEY] = policy;
}

export const SELF_SERVE_HOST_EXECUTION_ERROR_CODE = "self_serve_host_execution_forbidden";
/** Run error code when the heartbeat backstop refuses an agent in a self-serve company. */
export const SELF_SERVE_RUN_REFUSED_ERROR_CODE = "self_serve_adapter_not_allowed";
/** The claude_managed default API base URL; any other value is an override. */
export const SELF_SERVE_MANAGED_AGENTS_BASE_URL = "https://api.anthropic.com/v1";

/** Adapters that always execute on the server host. Never allowed self-serve. */
export function isHostExecutedAdapterType(adapterType: string): boolean {
  const type = adapterType.trim();
  return type === "process" || type.endsWith("_local");
}

export function parseSelfServeAdapterTypes(raw: string | undefined): string[] {
  const listed = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const source = listed.length > 0 ? listed : [...DEFAULT_SELF_SERVE_ADAPTER_TYPES];
  return [...new Set(source.filter((type) => !isHostExecutedAdapterType(type)))];
}

export function configureSelfServePolicy(input: {
  selfServeCompanies: boolean;
  deploymentMode: DeploymentMode;
  adapterTypes?: readonly string[];
}) {
  writePolicy(input.selfServeCompanies && input.deploymentMode === "authenticated"
    ? {
        enabled: true,
        adapterTypes: (input.adapterTypes ?? DEFAULT_SELF_SERVE_ADAPTER_TYPES).filter(
          (type) => !isHostExecutedAdapterType(type),
        ),
      }
    : DISABLED);
}

export function getSelfServePolicy(): SelfServePolicy {
  return readPolicy();
}

/** Test helper. */
export function resetSelfServePolicy() {
  writePolicy(DISABLED);
}

/**
 * Instance-level operator actions with no company (e.g. restarting the dev
 * server): refused to anyone who is not an instance admin while self-serve is on.
 */
export function isSelfServeRestricted(req: Pick<Request, "actor">): boolean {
  if (!readPolicy().enabled) return false;
  const actor = req.actor;
  if (!actor || actor.type === "none") return false;
  if (actor.type === "board") {
    return !(actor.source === "local_implicit" || actor.isInstanceAdmin === true);
  }
  return true;
}

/** True when the floor applies to this company: self-serve on and the company was created self-serve. */
export async function isSelfServeCompany(db: Pick<Db, "select">, companyId: string | null | undefined): Promise<boolean> {
  if (!readPolicy().enabled || !companyId) return false;
  const row = await db
    .select({ selfServe: companies.selfServe })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return row?.selfServe === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENDPOINT_OVERRIDE_KEYS = ["apiBaseUrl", "baseUrl", "baseURL", "apiUrl", "endpoint", "url", "gatewayUrl", "host"] as const;
const ENDPOINT_OVERRIDE_ENV = /(BASE_URL|_ENDPOINT|API_URL|_HOST|_PROXY)$/i;
const HOST_COMMAND_KEYS = ["command", "hermesCommand", "args", "extraArgs", "cwd", "filesystemSandboxCommand"] as const;
const WORKSPACE_COMMAND_KEYS = ["provisionCommand", "runtimeProvisionCommand", "teardownCommand", "cleanupCommand"] as const;

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Why an agent with this adapter and config may not exist or run in a
 * self-serve company, or null when it may.
 */
export function selfServeAgentViolation(
  adapterType: string | null | undefined,
  adapterConfig: unknown,
): string | null {
  const policy = readPolicy();
  const type = (adapterType ?? "").trim();
  if (isHostExecutedAdapterType(type) || !policy.adapterTypes.includes(type)) {
    return `Agents in this company can only use ${policy.adapterTypes.length > 0 ? policy.adapterTypes.join(", ") : "no adapters"}; "${type || "unknown"}" is not allowed on this instance.`;
  }
  const config = isRecord(adapterConfig) ? adapterConfig : {};
  for (const key of ENDPOINT_OVERRIDE_KEYS) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "apiBaseUrl" && typeof value === "string"
      && normalizeUrl(value) === normalizeUrl(SELF_SERVE_MANAGED_AGENTS_BASE_URL)) continue;
    return `Agents in this company cannot override the API endpoint (${key}).`;
  }
  for (const key of HOST_COMMAND_KEYS) {
    if (config[key] !== undefined && config[key] !== null) {
      return `Agents in this company cannot set host command settings (${key}).`;
    }
  }
  if (isRecord(config.env)) {
    const endpointKey = Object.keys(config.env).find((key) => ENDPOINT_OVERRIDE_ENV.test(key));
    if (endpointKey) return `Agents in this company cannot override the API endpoint (env.${endpointKey}).`;
  }
  const strategy = config.workspaceStrategy;
  if (isRecord(strategy)) {
    const commandKey = WORKSPACE_COMMAND_KEYS.find((key) => strategy[key] !== undefined && strategy[key] !== null);
    if (commandKey) return `Agents in this company cannot set host-executed workspace commands (workspaceStrategy.${commandKey}).`;
  }
  return null;
}

function refuse(message: string): never {
  throw forbidden(message, { code: SELF_SERVE_HOST_EXECUTION_ERROR_CODE });
}

/** Refuse an agent adapter/config that the floor does not allow in this company. */
export async function assertSelfServeCompanyAgent(
  db: Pick<Db, "select">,
  companyId: string,
  adapterType: string | null | undefined,
  adapterConfig: unknown,
) {
  if (!(await isSelfServeCompany(db, companyId))) return;
  const violation = selfServeAgentViolation(adapterType, adapterConfig);
  if (violation) refuse(violation);
}

/** Refuse a host-execution surface (workspace commands, server folders, stdio tools, imports) in a self-serve company. */
export async function assertSelfServeCompanyHostAccess(
  db: Pick<Db, "select">,
  companyId: string,
  surface: string,
) {
  if (!(await isSelfServeCompany(db, companyId))) return;
  refuse(`${surface} can't be used in this company on this instance.`);
}

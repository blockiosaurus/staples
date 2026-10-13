import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { DEFAULT_SELF_SERVE_ADAPTER_TYPES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  isAlwaysDeniedLinkLocalIp,
  isPrivateOrReservedIp,
  resolveApprovedRemoteHttpAddresses,
  type RemoteHttpEndpointLookup,
} from "./remote-http-endpoint-guard.js";

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

export const SELF_SERVE_CONFIG_KEY_ERROR_CODE = "self_serve_config_key_not_allowed";

export type SelfServeViolation = { code: string; message: string };

/**
 * The adapterConfig keys an agent in a self-serve company may carry, per
 * allowed adapter. Anything else (endpoint overrides, host commands, file
 * paths, workspace commands, keys added later) is refused: an allowlist, so
 * a new config key is closed until it is reviewed here.
 *
 * claude_managed: the user-facing fields of its config form, plus the fields
 * the server writes itself (model and skill sync from hosted defaults, plan
 * hires and templates; the managed instructions bundle).
 */
const SELF_SERVE_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  claude_managed: new Set([
    "model",
    "env",
    "environmentId",
    "promptTemplate",
    "bootstrapPromptTemplate",
    "inactivityTimeoutSec",
    "networkingMode",
    "networkAllowedHosts",
    "networkAllowPackageManagers",
    "apiBaseUrl",
    "paperclipSkillSync",
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
  ]),
};
/** For an allowed adapter with no reviewed list: model and server-managed fields only. */
const DEFAULT_SELF_SERVE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "model",
  "paperclipSkillSync",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
]);
/** env keys a self-serve agent may bind, and only to a stored secret. */
const SELF_SERVE_ENV_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"]);
const MANAGED_INSTRUCTION_PATH_KEYS = ["instructionsRootPath", "instructionsFilePath"] as const;

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Real path of `target`, resolving symlinks in its deepest existing ancestor
 * and appending the not-yet-existing remainder, so a path that doesn't exist
 * yet can still be checked without following a link out of the root.
 */
async function realPathAllowingMissing(target: string): Promise<string> {
  let probe = path.resolve(target);
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return remainder.length > 0 ? path.join(real, ...remainder.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(target);
      remainder.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** The managed instructions root for a company's agents: `<instance>/companies/<companyId>/agents`. */
export function selfServeManagedInstructionsRoot(companyId: string) {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", companyId, "agents");
}

/** True when `candidate` (absolute) resolves, symlinks included, inside `root`. */
export async function pathResolvesInside(root: string, candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  const lexical = path.resolve(candidate);
  if (!isWithin(path.resolve(root), lexical)) return false;
  const [realRoot, realCandidate] = await Promise.all([
    realPathAllowingMissing(root),
    realPathAllowingMissing(lexical),
  ]);
  return isWithin(realRoot, realCandidate);
}

/**
 * Server-managed folders a self-serve company's workspaces may live in, under
 * the instance root: its managed project checkouts (`projects/<companyId>`),
 * its isolated task folders (`isolated-workspaces/<companyId>`) and the home
 * folder of each of its agents (`workspaces/<agentId>`).
 */
export async function selfServeManagedWorkspaceRoots(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<string[]> {
  const instanceRoot = resolvePaperclipInstanceRoot();
  const agentRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return [
    path.resolve(instanceRoot, "projects", companyId),
    path.resolve(instanceRoot, "isolated-workspaces", companyId),
    ...agentRows.map((row) => path.resolve(instanceRoot, "workspaces", row.id)),
  ];
}

/** True when `root` resolves, symlinks included, inside one of the company's managed workspace folders. */
export async function isSelfServeManagedWorkspaceRoot(
  db: Pick<Db, "select">,
  companyId: string,
  root: string | null | undefined,
): Promise<boolean> {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  for (const managedRoot of await selfServeManagedWorkspaceRoots(db, companyId)) {
    if (await pathResolvesInside(managedRoot, root)) return true;
  }
  return false;
}

/**
 * Service-level floor for stored workspace roots: in a self-serve company a
 * project or execution workspace folder may only be one of the company's
 * server-managed folders. Clearing the folder (null) is always allowed.
 */
export async function assertSelfServeWorkspaceRoot(
  db: Pick<Db, "select">,
  companyId: string,
  root: string | null | undefined,
) {
  if (root === null || root === undefined || root === "") return;
  if (!(await isSelfServeCompany(db, companyId))) return;
  if (await isSelfServeManagedWorkspaceRoot(db, companyId, root)) return;
  refuse("Choosing a folder on the server can't be used in this company on this instance.");
}

export function isSelfServeAdapterAllowed(adapterType: string | null | undefined) {
  const type = (adapterType ?? "").trim();
  return !isHostExecutedAdapterType(type) && readPolicy().adapterTypes.includes(type);
}

/**
 * Why an agent with this adapter and config may not exist or run in the
 * self-serve company `companyId`, or null when it may.
 */
export async function selfServeAgentViolation(
  companyId: string,
  adapterType: string | null | undefined,
  adapterConfig: unknown,
): Promise<SelfServeViolation | null> {
  const policy = readPolicy();
  const type = (adapterType ?? "").trim();
  if (!isSelfServeAdapterAllowed(type)) {
    return {
      code: SELF_SERVE_HOST_EXECUTION_ERROR_CODE,
      message: `Agents in this company can only use ${policy.adapterTypes.length > 0 ? policy.adapterTypes.join(", ") : "no adapters"}; "${type || "unknown"}" is not allowed on this instance.`,
    };
  }
  const config = isRecord(adapterConfig) ? adapterConfig : {};
  const allowedKeys = SELF_SERVE_CONFIG_KEYS[type] ?? DEFAULT_SELF_SERVE_CONFIG_KEYS;
  const keyRefused = (key: string): SelfServeViolation => ({
    code: SELF_SERVE_CONFIG_KEY_ERROR_CODE,
    message: `Agents in this company can't set "${key}" on this instance.`,
  });
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (!allowedKeys.has(key)) return keyRefused(key);
  }
  if (config.apiBaseUrl !== undefined && config.apiBaseUrl !== null && config.apiBaseUrl !== ""
    && !(typeof config.apiBaseUrl === "string"
      && normalizeUrl(config.apiBaseUrl) === normalizeUrl(SELF_SERVE_MANAGED_AGENTS_BASE_URL))) {
    return keyRefused("apiBaseUrl");
  }
  if (config.env !== undefined && config.env !== null) {
    if (!isRecord(config.env)) return keyRefused("env");
    for (const [key, binding] of Object.entries(config.env)) {
      if (!SELF_SERVE_ENV_KEYS.has(key)) return keyRefused(`env.${key}`);
      const kind = isRecord(binding) ? binding.type : null;
      if (kind !== "secret_ref" && kind !== "user_secret_ref") return keyRefused(`env.${key} (use a stored secret)`);
    }
  }
  if (config.instructionsBundleMode !== undefined && config.instructionsBundleMode !== null
    && config.instructionsBundleMode !== "managed") {
    return keyRefused("instructionsBundleMode");
  }
  if (config.instructionsEntryFile !== undefined && config.instructionsEntryFile !== null) {
    const entry = config.instructionsEntryFile;
    if (typeof entry !== "string" || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      return keyRefused("instructionsEntryFile");
    }
  }
  const root = selfServeManagedInstructionsRoot(companyId);
  for (const key of MANAGED_INSTRUCTION_PATH_KEYS) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !(await pathResolvesInside(root, value))) return keyRefused(key);
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
  const violation = await selfServeAgentViolation(companyId, adapterType, adapterConfig);
  if (violation) throw forbidden(violation.message, { code: violation.code });
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

// ---------------------------------------------------------------------------
// Repository URLs (managed clones)
// ---------------------------------------------------------------------------

/** Error code when a self-serve company names a repository the server may not clone. */
export const SELF_SERVE_REPO_URL_ERROR_CODE = "self_serve_repo_url_not_allowed";

const COMPANY_LOOKUP_KEY = Symbol.for("paperclip.selfServeCompanyLookup");
type LookupHolder = { [COMPANY_LOOKUP_KEY]?: Pick<Db, "select"> | null };

/**
 * Register the database the clone-time floor uses to tell whether a company is
 * self-serve. Managed clones run deep inside workspace realization, where no
 * database handle is threaded through; createApp registers it next to the policy.
 */
export function registerSelfServeCompanyLookup(db: Pick<Db, "select"> | null) {
  (globalThis as LookupHolder)[COMPANY_LOOKUP_KEY] = db;
}

/**
 * True when the clone-time floor applies to this company. With the policy on and
 * no registered database the answer is yes (fail closed).
 */
export async function isSelfServeCompanyForClone(companyId: string | null | undefined): Promise<boolean> {
  if (!readPolicy().enabled) return false;
  const db = (globalThis as LookupHolder)[COMPANY_LOOKUP_KEY] ?? null;
  if (!db || !companyId) return true;
  return isSelfServeCompany(db, companyId);
}

/**
 * Why a repository URL is not allowed in a self-serve company, or null. Only
 * `https://` is allowed (never `file://`, a bare path, `ssh`, `git` or `ext::`),
 * and never a literal loopback, private, reserved or link-local host. Hostnames
 * are resolved at clone time ({@link assertSelfServeCloneSourceAllowed}).
 */
export function selfServeRepoUrlViolation(repoUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl.trim());
  } catch {
    return "Repository URLs in this company must be https:// URLs.";
  }
  if (parsed.protocol !== "https:") return "Repository URLs in this company must be https:// URLs.";
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) return "Repository URLs in this company must name a host.";
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "Repository URLs in this company can't point at the server or a private network.";
  }
  if (isIP(hostname) !== 0 && (isAlwaysDeniedLinkLocalIp(hostname) || isPrivateOrReservedIp(hostname))) {
    return "Repository URLs in this company can't point at the server or a private network.";
  }
  return null;
}

/** A git ref the server passes to git: never one that git would read as an option. */
export function selfServeGitRefViolation(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (trimmed.startsWith("-")) return "Git refs can't start with '-'.";
  if (/[\0\r\n]/.test(trimmed)) return "Git refs can't contain control characters.";
  return null;
}

/** Write-time floor: a self-serve company may only store https:// repository URLs. */
export async function assertSelfServeRepoUrl(
  db: Pick<Db, "select">,
  companyId: string,
  fields: { repoUrl?: string | null; refs?: Array<string | null | undefined> },
) {
  const repoUrl = typeof fields.repoUrl === "string" ? fields.repoUrl.trim() : "";
  const refs = fields.refs ?? [];
  if (!repoUrl && refs.every((ref) => typeof ref !== "string")) return;
  if (!(await isSelfServeCompany(db, companyId))) return;
  const violation = (repoUrl ? selfServeRepoUrlViolation(repoUrl) : null)
    ?? refs.map(selfServeGitRefViolation).find((value) => value !== null)
    ?? null;
  if (violation) throw forbidden(violation, { code: SELF_SERVE_REPO_URL_ERROR_CODE });
}

/**
 * Clone-time floor for a self-serve company: the URL must pass
 * {@link selfServeRepoUrlViolation} and its host must resolve only to public
 * addresses (the DNS-resolving remote endpoint guard, private networks refused).
 */
export async function assertSelfServeCloneSourceAllowed(
  companyId: string | null | undefined,
  repoUrl: string,
  options: { lookup?: RemoteHttpEndpointLookup } = {},
) {
  if (!(await isSelfServeCompanyForClone(companyId))) return;
  const violation = selfServeRepoUrlViolation(repoUrl);
  if (violation) throw forbidden(violation, { code: SELF_SERVE_REPO_URL_ERROR_CODE });
  await resolveApprovedRemoteHttpAddresses(
    new URL(repoUrl.trim()),
    { allowPrivateNetwork: false, lookup: options.lookup },
    (_message, reason) => forbidden(
      reason === "remote_http_dns_failed"
        ? "The repository host could not be resolved."
        : "Repository URLs in this company can't point at the server or a private network.",
      { code: SELF_SERVE_REPO_URL_ERROR_CODE, reason },
    ),
  );
}

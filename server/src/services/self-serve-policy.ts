import type { Request } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import { DEFAULT_SELF_SERVE_ADAPTER_TYPES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

/**
 * Self-serve floor (PAPERCLIP_SELF_SERVE_COMPANIES).
 *
 * When any signed-in user can create a company, a company owner is no longer a
 * trusted operator: the owner role grants agents:create / agents:configure /
 * environments:manage, and those reach host execution in the shared server
 * process (a `process` adapter, a `*_local` CLI with a custom command, local
 * environments, workspace commands). On a self-serve instance every actor that
 * is not an instance admin (non-admin board users and agents alike) is
 * restricted to the remote adapters in PAPERCLIP_SELF_SERVE_ADAPTERS and may
 * not touch host-execution surfaces. Instance admins and the local board are
 * never restricted, and nothing changes when self-serve is off.
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

type ActorLike = Pick<Request, "actor">;

/** True when the self-serve floor applies to this request's actor. */
export function isSelfServeRestricted(req: ActorLike): boolean {
  if (!readPolicy().enabled) return false;
  const actor = req.actor;
  if (!actor || actor.type === "none") return false;
  if (actor.type === "board") {
    return !(actor.source === "local_implicit" || actor.isInstanceAdmin === true);
  }
  // Agents are never instance admins.
  return true;
}

export const SELF_SERVE_HOST_EXECUTION_ERROR_CODE = "self_serve_host_execution_forbidden";

function refuse(message: string): never {
  throw forbidden(message, { code: SELF_SERVE_HOST_EXECUTION_ERROR_CODE });
}

/**
 * Refuse an adapter type the self-serve floor does not allow. Pass the
 * adapter type a create/update/rollback/hire/approval would leave the agent on.
 */
export function assertSelfServeAdapterAllowed(req: ActorLike, adapterType: string | null | undefined) {
  if (!isSelfServeRestricted(req)) return;
  const current = readPolicy();
  const type = (adapterType ?? "").trim();
  if (isHostExecutedAdapterType(type) || !current.adapterTypes.includes(type)) {
    refuse(
      `This instance only allows ${current.adapterTypes.length > 0 ? current.adapterTypes.join(", ") : "no"} agents for non-admins. ` +
        `"${type || "unknown"}" runs on the server and needs an instance admin.`,
    );
  }
}

/** Refuse a host-execution surface (local environments, workspace commands, imports). */
export function assertSelfServeHostAccess(req: ActorLike, surface: string) {
  if (!isSelfServeRestricted(req)) return;
  refuse(`${surface} needs an instance admin on this instance.`);
}

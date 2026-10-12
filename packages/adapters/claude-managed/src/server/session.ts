import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * Persisted per-task session state for `claude_managed`.
 *
 * - managedAgentId / managedAgentVersion: the Managed Agents agent and the version
 *   the session was created with.
 * - fingerprint: hash of the agent definition (model, system, tools). A changed
 *   fingerprint means a new agent version and a new session.
 * - environmentId (+ environmentFingerprint): the cloud environment and the config
 *   it was created with.
 * - sessionId: the Managed Agents session resumed across heartbeats.
 */
export interface ClaudeManagedSessionParams {
  managedAgentId: string;
  managedAgentVersion: number;
  fingerprint: string;
  environmentId: string;
  environmentFingerprint?: string;
  sessionId: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readSessionParams(raw: unknown): ClaudeManagedSessionParams | null {
  const record = asRecord(raw);
  if (!record) return null;
  const managedAgentId = readString(record.managedAgentId);
  const sessionId = readString(record.sessionId);
  const environmentId = readString(record.environmentId);
  const fingerprint = readString(record.fingerprint);
  const version = typeof record.managedAgentVersion === "number" ? record.managedAgentVersion : Number(record.managedAgentVersion);
  if (!managedAgentId || !sessionId || !environmentId || !fingerprint || !Number.isSafeInteger(version) || version < 1) return null;
  const environmentFingerprint = readString(record.environmentFingerprint);
  return {
    managedAgentId,
    managedAgentVersion: version,
    fingerprint,
    environmentId,
    ...(environmentFingerprint ? { environmentFingerprint } : {}),
    sessionId,
  };
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const params = readSessionParams(raw);
  return params ? { ...params } : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    return readSessionParams(params)?.sessionId ?? null;
  },
};

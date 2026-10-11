import { isDeepStrictEqual } from "node:util";
import { conflict } from "../errors.js";

/**
 * `agents.metadata.staplesTemplate`: which Staples agent template an agent was
 * installed from, and its outward actions and required apps. Written only by
 * plans/apply (server-side, after the hire); never accepted from a caller.
 */
export const STAPLES_TEMPLATE_METADATA_KEY = "staplesTemplate";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The raw marker value, any shape; `undefined` only when the key is absent. */
export function rawStaplesTemplateMarker(metadata: unknown): unknown {
  if (!isPlainRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, STAPLES_TEMPLATE_METADATA_KEY)) return undefined;
  return metadata[STAPLES_TEMPLATE_METADATA_KEY];
}

/**
 * Callers may resubmit a stored marker exactly as stored, but never add,
 * change or remove it (a metadata write replaces the whole object, so
 * leaving it out would remove it).
 */
export function assertStaplesTemplateMetadataUnchanged(beforeMetadata: unknown, afterMetadata: unknown) {
  const before = rawStaplesTemplateMarker(beforeMetadata);
  const after = rawStaplesTemplateMarker(afterMetadata);
  if (before === undefined && after === undefined) return;
  if (before !== undefined && after !== undefined && isDeepStrictEqual(before, after)) return;
  throw conflict("The agent template record is managed by Staples and cannot be edited directly", {
    code: "staples_template_metadata_readonly",
  });
}

/** `metadata` with the stored marker carried over when the incoming value left it out. */
export function withStoredStaplesTemplateMarker(stored: unknown, incoming: Record<string, unknown> | null): Record<string, unknown> | null {
  const marker = rawStaplesTemplateMarker(stored);
  if (marker === undefined) return incoming;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, STAPLES_TEMPLATE_METADATA_KEY)) return incoming;
  return { ...(incoming ?? {}), [STAPLES_TEMPLATE_METADATA_KEY]: marker };
}

/** `metadata` without the marker (imports never carry template provenance). */
export function withoutStaplesTemplateMarker<T extends Record<string, unknown> | null | undefined>(metadata: T): T {
  if (!isPlainRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, STAPLES_TEMPLATE_METADATA_KEY)) return metadata;
  const { [STAPLES_TEMPLATE_METADATA_KEY]: _removed, ...rest } = metadata;
  return rest as T;
}

/**
 * `incoming` with the marker set to exactly the stored one (or removed when
 * none is stored), for server-side rewrites such as config rollback: an older
 * snapshot can neither drop nor change the record.
 */
export function withStaplesTemplateMarkerFrom(stored: unknown, incoming: Record<string, unknown> | null): Record<string, unknown> | null {
  const marker = rawStaplesTemplateMarker(stored);
  if (marker === undefined) return withoutStaplesTemplateMarker(incoming);
  return { ...(incoming ?? {}), [STAPLES_TEMPLATE_METADATA_KEY]: marker };
}

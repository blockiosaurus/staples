/**
 * Strings that contain a banned word on purpose because they render only
 * behind an Advanced disclosure, an admin-only view, or a tool name a person
 * must recognise. Each entry names the file, the exact literal, and why.
 */
export const COPY_ALLOWLIST: ReadonlyArray<{ file: string; literal: string; reason: string }> = [];

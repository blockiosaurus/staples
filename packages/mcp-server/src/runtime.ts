/**
 * The Paperclip tool set for a server-hosted MCP endpoint (Staples serves it as the
 * run-scoped `paperclip` runtime MCP server for hosted agents). Same definitions as
 * the stdio server; this module only picks the subset that works away from the
 * agent's machine and renders each input schema as plain JSON Schema.
 */
import { z } from "zod";
import { PaperclipApiClient, PaperclipApiError } from "./client.js";
import { normalizeApiUrl, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

export { PaperclipApiClient, PaperclipApiError, normalizeApiUrl, createToolDefinitions };
export type { PaperclipMcpConfig, ToolDefinition };

/**
 * Tools left out of the hosted set: the connection tools read run-scoped endpoints
 * from the local process env (hosted runs get them from the connections server), and
 * the execution-workspace tools need a local workspace a hosted sandbox does not have.
 */
export const RUNTIME_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "connections_search",
  "connection_request",
  "paperclipGetIssueWorkspaceRuntime",
  "paperclipControlIssueWorkspaceServices",
  "paperclipWaitForIssueWorkspaceService",
]);

export function createRuntimeToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return createToolDefinitions(client).filter((tool) => !RUNTIME_EXCLUDED_TOOL_NAMES.has(tool.name));
}

/** Drops keys that only add size: `$schema`, and the regex beside `format: "uuid"`. */
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (key === "$schema") continue;
    if (key === "pattern" && record.format === "uuid") continue;
    out[key] = compactSchema(entry);
  }
  return out;
}

/** The tool's input schema as JSON Schema (what MCP `tools/list` returns as `inputSchema`). */
export function toolInputJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" });
  return compactSchema(schema) as Record<string, unknown>;
}

/** MCP `tools/list` entries for a tool set. */
export function listRuntimeTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toolInputJsonSchema(tool) }));
}

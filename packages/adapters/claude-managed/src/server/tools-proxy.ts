/**
 * Proxies Staples runtime MCP servers to a Managed Agents session as custom tools.
 *
 * Staples hands each run a list of MCP servers (`ctx.runtimeMcp.getServers()`), each
 * with a run-scoped bearer token. The Managed Agents sandbox cannot be given those
 * tokens (they must never reach Anthropic), so this module talks to the servers from
 * the Staples host instead: it lists their tools with JSON-RPC `tools/list`, exposes
 * each one to the agent as a `custom` tool, and runs `tools/call` when the agent
 * calls it. Only tool names, descriptions, input schemas and results cross over.
 *
 * Transport: MCP Streamable HTTP. Every POST sends
 * `Accept: application/json, text/event-stream`, and the response may be a single
 * JSON body or an SSE stream (mirrors server/src/services/mcp-http.ts). `initialize`
 * is attempted first; servers that answer it with an error or a non-2xx status are
 * treated as stateless (Staples' own endpoints accept tools/list without it).
 */
import { createHash } from "node:crypto";
import { SseParser } from "../sse.js";
import type { ContentBlock, CustomToolDefinition } from "../types.js";

export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Managed Agents custom tool name limit used here (Messages API tool-name rule). */
export const MAX_TOOL_NAME_LENGTH = 64;
/** Results larger than this are truncated before they are sent to the session. */
export const DEFAULT_MAX_RESULT_CHARS = 100_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESERVED_PREFIXES = ["mcp__", "ant__"];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeMcpServerInput {
  name: string;
  url: string;
  token: string;
  connectionId?: string;
}

export interface ProxiedTool {
  /** Name registered with the Managed Agents agent. */
  name: string;
  serverName: string;
  /** Original tool name on the MCP server. */
  toolName: string;
  definition: CustomToolDefinition;
}

export interface ToolCallOutcome {
  content: ContentBlock[];
  isError: boolean;
  truncated: boolean;
  /** Plain-text preview for logs (already capped). */
  preview: string;
}

export interface ToolsProxyOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  maxResultChars?: number;
  /** Per-request timeout for tools/list and initialize. Default 30s. */
  discoveryTimeoutMs?: number;
  /** Per-call timeout for tools/call. Default 5 minutes. */
  callTimeoutMs?: number;
  onWarning?: (message: string) => void | Promise<void>;
}

class McpJsonRpcError extends Error {
  constructor(readonly code: number | null, message: string) {
    super(message);
    this.name = "McpJsonRpcError";
  }
}

class McpHttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "McpHttpStatusError";
  }
}

/** One Streamable HTTP MCP connection. The token lives in a private field. */
class McpHttpConnection {
  readonly #token: string;
  private sessionHeaders: Record<string, string> = {};
  private initialized = false;
  private nextId = 1;

  constructor(
    readonly serverName: string,
    readonly url: string,
    token: string,
    private readonly fetchImpl: FetchLike,
  ) {
    this.#token = token;
  }

  toJSON(): Record<string, unknown> {
    return { serverName: this.serverName, url: this.url, token: "[redacted]" };
  }

  redact(message: string): string {
    return this.#token ? message.split(this.#token).join("[redacted]") : message;
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.sessionHeaders = {};
    let response: Response;
    const id = this.nextId++;
    try {
      response = await this.post(
        {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "staples-claude-managed", version: "1" } },
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return; // stateless fallback
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new McpHttpStatusError(response.status, `MCP server "${this.serverName}" rejected the run token (HTTP ${response.status})`);
      }
      return; // stateless fallback
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await readJsonRpcResponse(response, id, signal);
    } catch {
      return;
    }
    const result = asRecord(payload?.result);
    if (!result) return;
    const protocolVersion = typeof result.protocolVersion === "string" && result.protocolVersion ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    const sessionId = response.headers.get("mcp-session-id");
    this.sessionHeaders = { "MCP-Protocol-Version": protocolVersion, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
    try {
      const notified = await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal);
      await notified.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.initialize(signal);
    let { response, id } = await this.send(method, params, signal);
    // An expired Streamable HTTP session answers 404: re-initialize once.
    if (response.status === 404 && this.sessionHeaders["Mcp-Session-Id"]) {
      await response.body?.cancel().catch(() => undefined);
      this.initialized = false;
      await this.initialize(signal);
      ({ response, id } = await this.send(method, params, signal));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new McpHttpStatusError(response.status, this.redact(`MCP ${method} on "${this.serverName}" returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`));
    }
    const payload = await readJsonRpcResponse(response, id, signal);
    if (!payload) throw new McpJsonRpcError(null, `MCP ${method} on "${this.serverName}" returned no response`);
    const error = asRecord(payload.error);
    if (error) {
      const code = typeof error.code === "number" ? error.code : null;
      const message = typeof error.message === "string" ? error.message : "unknown error";
      throw new McpJsonRpcError(code, this.redact(`MCP ${method} on "${this.serverName}" failed${code !== null ? ` (${code})` : ""}: ${message}`));
    }
    return asRecord(payload.result) ?? {};
  }

  private async send(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<{ response: Response; id: number }> {
    const id = this.nextId++;
    return { response: await this.post({ jsonrpc: "2.0", id, method, params }, signal), id };
  }

  private post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.sessionHeaders,
        authorization: `Bearer ${this.#token}`,
        accept: MCP_HTTP_ACCEPT,
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/**
 * Reads a Streamable HTTP response until the JSON-RPC response for `id` arrives.
 * JSON bodies are parsed directly; SSE bodies are parsed frame by frame and other
 * messages (notifications, progress) are skipped.
 */
async function readJsonRpcResponse(response: Response, id: number, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeded the size limit");
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return (parsed.map(asRecord).find((m) => m && m.id === id) as Record<string, unknown> | undefined) ?? null;
    return asRecord(parsed);
  }
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let bytes = 0;
  let fallback: Record<string, unknown> | null = null;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const frames = done ? parser.end() : parser.push(decoder.decode(value, { stream: true }));
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeded the size limit");
      }
      for (const frame of frames) {
        if (!frame.data.trim()) continue;
        let message: Record<string, unknown> | null;
        try {
          message = asRecord(JSON.parse(frame.data));
        } catch {
          continue;
        }
        if (!message) continue;
        if (message.id === id && ("result" in message || "error" in message)) return message;
        if (!fallback && ("result" in message || "error" in message) && message.id === undefined) fallback = message;
      }
      if (done) return fallback;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

export function slugifyServerName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "server";
}

function sanitizeToolPart(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return cleaned || "tool";
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Builds `<server-slug>__<tool>` names restricted to [a-zA-Z0-9_-] and at most 64
 * characters. A name that is too long, collides with an earlier one, or starts with
 * a reserved prefix (`mcp__`, `ant__`) gets a deterministic 8-character hash suffix.
 */
export function buildToolName(serverName: string, toolName: string, taken: Set<string>): string {
  const base = `${slugifyServerName(serverName)}__${sanitizeToolPart(toolName)}`;
  let candidate = RESERVED_PREFIXES.some((prefix) => base.startsWith(prefix)) ? `s-${base}` : base;
  if (candidate.length <= MAX_TOOL_NAME_LENGTH && !taken.has(candidate)) return candidate;
  let salt = 0;
  for (;;) {
    const suffix = `_${shortHash(`${serverName}\u0000${toolName}\u0000${salt}`)}`;
    candidate = `${candidate.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
    salt += 1;
    candidate = RESERVED_PREFIXES.some((prefix) => base.startsWith(prefix)) ? `s-${base}` : base;
  }
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

function contentToText(block: Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource") {
    const resource = asRecord(block.resource);
    if (resource && typeof resource.text === "string") return resource.text;
  }
  if (block.type === "image" || block.type === "audio") {
    const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown type";
    return `[${block.type} content omitted (${mime})]`;
  }
  return JSON.stringify(block);
}

/** Converts an MCP `tools/call` result into custom-tool-result text, capped in size. */
export function mcpResultToToolContent(
  result: Record<string, unknown>,
  maxChars = DEFAULT_MAX_RESULT_CHARS,
  redact: (text: string) => string = (text) => text,
): ToolCallOutcome {
  const blocks = Array.isArray(result.content) ? result.content.map(asRecord).filter((b): b is Record<string, unknown> => Boolean(b)) : [];
  let text = blocks.map(contentToText).join("\n");
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  if (!text) text = "(no output)";
  // Redact before capping so truncation cannot split (and so leak part of) a secret.
  return capText(redact(text), result.isError === true, maxChars);
}

function capText(text: string, isError: boolean, maxChars: number): ToolCallOutcome {
  let truncated = false;
  let out = text;
  if (out.length > maxChars) {
    truncated = true;
    const note = `\n\n[Staples truncated this tool result: ${text.length} characters, showing the first ${maxChars}.]`;
    out = `${out.slice(0, maxChars)}${note}`;
  }
  return { content: [{ type: "text", text: out }], isError, truncated, preview: out.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export class ToolsProxy {
  private readonly byName = new Map<string, { tool: ProxiedTool; connection: McpHttpConnection }>();
  private readonly ordered: ProxiedTool[] = [];
  private readonly connections: McpHttpConnection[] = [];

  private constructor(private readonly options: ToolsProxyOptions) {}

  /**
   * Connects to each server and lists its tools. A server that fails is skipped with
   * a warning (the run continues without its tools); an aborted signal rethrows.
   */
  static async discover(servers: RuntimeMcpServerInput[], options: ToolsProxyOptions = {}): Promise<ToolsProxy> {
    const proxy = new ToolsProxy(options);
    const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    const taken = new Set<string>();
    for (const server of servers) {
      if (!server.url || !server.token) continue;
      const connection = new McpHttpConnection(server.name, server.url, server.token, fetchImpl);
      let tools: Array<Record<string, unknown>>;
      try {
        tools = await proxy.listTools(connection);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const detail = connection.redact(error instanceof Error ? error.message : String(error));
        await options.onWarning?.(`Skipping tools from "${server.name}": ${detail}`);
        continue;
      }
      proxy.connections.push(connection);
      for (const raw of tools) {
        const toolName = typeof raw.name === "string" ? raw.name : "";
        if (!toolName) continue;
        const name = buildToolName(server.name, toolName, taken);
        taken.add(name);
        const description = typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : `Tool "${toolName}" from ${server.name}.`;
        const schema = asRecord(raw.inputSchema) ?? { type: "object", properties: {} };
        const tool: ProxiedTool = {
          name,
          serverName: server.name,
          toolName,
          definition: {
            type: "custom",
            name,
            description: `${description}\n\n(Provided by ${server.name}.)`,
            input_schema: schema.type ? schema : { type: "object", ...schema },
          },
        };
        proxy.ordered.push(tool);
        proxy.byName.set(name, { tool, connection });
      }
    }
    return proxy;
  }

  private async listTools(connection: McpHttpConnection): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const signal = this.timeoutSignal(this.options.discoveryTimeoutMs ?? 30_000);
      const result = await connection.request("tools/list", cursor ? { cursor } : {}, signal);
      const tools = Array.isArray(result.tools) ? result.tools.map(asRecord).filter((t): t is Record<string, unknown> => Boolean(t)) : [];
      out.push(...tools);
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  private timeoutSignal(ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
  }

  definitions(): CustomToolDefinition[] {
    return this.ordered.map((tool) => tool.definition);
  }

  tools(): ProxiedTool[] {
    return [...this.ordered];
  }

  get(name: string): ProxiedTool | null {
    return this.byName.get(name)?.tool ?? null;
  }

  /** Runs a tool. Never throws for tool-level failures; they come back as `isError`. */
  async call(name: string, input: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<ToolCallOutcome> {
    const maxChars = this.options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    const entry = this.byName.get(name);
    if (!entry) return capText(`Unknown tool "${name}". It is not available in this run.`, true, maxChars);
    const timeout = AbortSignal.timeout(this.options.callTimeoutMs ?? 300_000);
    const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : []), ...(this.options.signal ? [this.options.signal] : [])]);
    try {
      const result = await entry.connection.request("tools/call", { name: entry.tool.toolName, arguments: input ?? {} }, signal);
      // A tool that echoes request headers must not hand the run token to Anthropic.
      return mcpResultToToolContent(result, maxChars, (text) => entry.connection.redact(text));
    } catch (error) {
      const detail = entry.connection.redact(error instanceof Error ? error.message : String(error));
      const reason = timeout.aborted ? `Tool "${entry.tool.toolName}" timed out.` : `Tool "${entry.tool.toolName}" failed: ${detail}`;
      return capText(reason, true, maxChars);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

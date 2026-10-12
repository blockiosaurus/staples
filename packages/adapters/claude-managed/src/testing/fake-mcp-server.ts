/**
 * In-process fake of a Staples runtime MCP server (Streamable HTTP, node:http).
 *
 * - Requires `Authorization: Bearer <token>`; anything else gets 401.
 * - Handles `initialize` (returns an `mcp-session-id` when `sessions` is on),
 *   `notifications/initialized`, `tools/list` and `tools/call`.
 * - Answers with a plain JSON body, or with an SSE stream when `sse` is on
 *   (a progress notification is sent before the response to exercise the reader).
 * - Records every request (headers and parsed body) for assertions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Returns an MCP tools/call result, or throws to produce a JSON-RPC error. */
  handler?: (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface FakeMcpServerOptions {
  token: string;
  tools: FakeMcpTool[];
  sse?: boolean;
  sessions?: boolean;
  /** Reply 404 to `initialize` (a stateless server that does not implement it). */
  noInitialize?: boolean;
}

export interface FakeMcpRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

export class FakeMcpServer {
  readonly requests: FakeMcpRequest[] = [];
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly options: FakeMcpServerOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  calls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return this.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => {
        const params = (r.body?.params ?? {}) as Record<string, unknown>;
        return { name: String(params.name), arguments: (params.arguments ?? {}) as Record<string, unknown> };
      });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    this.requests.push({ headers: { ...req.headers }, body });
    if (req.headers.authorization !== `Bearer ${this.options.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const method = typeof body?.method === "string" ? body.method : "";
    const id = body?.id ?? null;
    if (method === "initialize") {
      if (this.options.noInitialize) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const headers: Record<string, string> = this.options.sessions ? { "mcp-session-id": "fake-mcp-session" } : {};
      return this.reply(res, id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, headers);
    }
    if (method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (this.options.sessions && req.headers["mcp-session-id"] !== "fake-mcp-session") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "missing session" } }));
      return;
    }
    if (method === "tools/list") {
      return this.reply(res, id, {
        tools: this.options.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
      });
    }
    if (method === "tools/call") {
      const params = (body?.params ?? {}) as Record<string, unknown>;
      const tool = this.options.tools.find((t) => t.name === params.name);
      if (!tool) return this.replyError(res, id, -32602, `Unknown tool ${String(params.name)}`);
      try {
        const result = tool.handler ? await tool.handler((params.arguments ?? {}) as Record<string, unknown>) : { content: [{ type: "text", text: "ok" }] };
        return this.reply(res, id, result);
      } catch (error) {
        return this.replyError(res, id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
    return this.replyError(res, id, -32601, "Method not found");
  }

  private reply(res: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}): void {
    this.send(res, { jsonrpc: "2.0", id, result }, headers);
  }

  private replyError(res: ServerResponse, id: unknown, code: number, message: string): void {
    this.send(res, { jsonrpc: "2.0", id, error: { code, message } }, {});
  }

  private send(res: ServerResponse, message: Record<string, unknown>, headers: Record<string, string>): void {
    if (this.options.sse) {
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(message));
  }
}

export async function startFakeMcpServer(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
  return new FakeMcpServer(options).start();
}

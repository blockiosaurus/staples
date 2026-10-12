import { Router, type Request } from "express";
import {
  PaperclipApiClient,
  createRuntimeToolDefinitions,
  listRuntimeTools,
  normalizeApiUrl,
} from "@paperclipai/mcp-server/runtime";
import { forbidden, unauthorized } from "../errors.js";

let cachedToolList: ReturnType<typeof listRuntimeTools> | null = null;
function toolList() {
  // Listing never calls the API, so a placeholder client is enough.
  cachedToolList ??= listRuntimeTools(createRuntimeToolDefinitions(
    new PaperclipApiClient({ apiUrl: "http://127.0.0.1/api", apiKey: "-", companyId: null, agentId: null, runId: null }),
  ));
  return cachedToolList;
}

function runActor(req: Request) {
  const actor = req.actor;
  if (actor.type === "none") throw unauthorized("Paperclip tools require the run's bearer token");
  if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || !actor.companyId) {
    throw forbidden("Paperclip tools require an authenticated agent run");
  }
  return { agentId: actor.agentId, companyId: actor.companyId, runId: actor.runId };
}

/**
 * The Paperclip tool set (packages/mcp-server) as a run-scoped Streamable HTTP MCP
 * endpoint, for agents that cannot reach `PAPERCLIP_API_URL` themselves (hosted
 * claude_managed runs). Mounted after actor middleware; only a run JWT
 * authenticates. Each tool call goes to the REST API over loopback with that same
 * token, so company scoping, permissions, run-header checks and activity logging
 * are exactly those of the agent's own API calls.
 */
export function paperclipToolRoutes() {
  const router = Router();
  router.post("/mcp/paperclip-tools", async (req, res) => {
    const run = runActor(req);
    const { id = null, method, params } = req.body ?? {};
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip", version: "1" } });
    }
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: toolList() });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });

    const apiUrl = process.env.PAPERCLIP_API_URL?.trim();
    if (!apiUrl) return send({ isError: true, content: [{ type: "text", text: "Paperclip API origin is unavailable" }] });
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const client = new PaperclipApiClient({ apiUrl: normalizeApiUrl(apiUrl), apiKey: token, ...run });
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = createRuntimeToolDefinitions(client).find((candidate) => candidate.name === name);
    if (!tool) return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    return send(await tool.execute(args));
  });
  return router;
}

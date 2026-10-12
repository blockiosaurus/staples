import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  PaperclipApiClient,
  createRuntimeToolDefinitions,
  listRuntimeTools,
  runtimeToolAllowed,
  type PaperclipApiTransport,
} from "@paperclipai/mcp-server/runtime";
import { forbidden, unauthorized } from "../errors.js";
import { isProvisionedAssistant } from "../services/assistant-identity.js";
import { injectApiRequest } from "../services/public-mcp/capabilities.js";

/**
 * In-process requests never touch the network; this base only anchors the path
 * guard (`resolveApiRequestUrl`), which keeps every call under `/api`.
 */
const IN_PROCESS_API_URL = "http://paperclip.in-process/api";
const MCP_PREFIX = "/mcp/";

type ToolList = ReturnType<typeof listRuntimeTools>;
const toolLists = new Map<boolean, ToolList>();
function toolList(readOnly: boolean): ToolList {
  let list = toolLists.get(readOnly);
  if (!list) {
    // Listing never calls the API, so a placeholder client is enough.
    list = listRuntimeTools(createRuntimeToolDefinitions(
      new PaperclipApiClient({ apiUrl: IN_PROCESS_API_URL, apiKey: "-", companyId: null, agentId: null, runId: null }),
      { readOnly },
    ));
    toolLists.set(readOnly, list);
  }
  return list;
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
 * endpoint, for agents that cannot reach the Staples API themselves (hosted
 * claude_managed runs). Mounted after actor middleware; only a run JWT
 * authenticates, and since every JSON-RPC call is a POST, a cancelled run's token
 * is refused here by the auth middleware's write block.
 *
 * Each tool call is dispatched in-process through the API router as the actor this
 * request authenticated as (the same pattern as the Assistant tools), so route
 * authorization, company scoping, validation and activity logging are those of the
 * agent's own API calls, and no request leaves the process.
 *
 * The provisioned Assistant gets only the read tools: its changes go through
 * proposals a person confirms. A write tool call from an Assistant run is refused.
 */
export function paperclipToolRoutes(db: Db, api: Router) {
  const router = Router();
  router.post("/mcp/paperclip-tools", async (req, res) => {
    const run = runActor(req);
    const readOnly = await isProvisionedAssistant(db, { id: run.agentId, companyId: run.companyId });
    const { id = null, method, params } = req.body ?? {};
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip", version: "1" } });
    }
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: toolList(readOnly) });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });

    const name = typeof params?.name === "string" ? params.name : "";
    if (!runtimeToolAllowed(name, { readOnly })) {
      const message = readOnly && runtimeToolAllowed(name)
        ? `${name} is not available to the Assistant: propose the change for the person to confirm`
        : `Unknown tool: ${name}`;
      return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message } });
    }
    const actor = req.actor;
    const transport: PaperclipApiTransport = async (request) => {
      // Express matches routes case-insensitively and ignores a trailing slash,
      // so compare a normalized path. No MCP endpoint (this one included) is
      // reachable through the in-process REST proxy.
      const path = request.path.split(/[?#]/)[0]!.toLowerCase();
      if (path === MCP_PREFIX.slice(0, -1) || path.startsWith(MCP_PREFIX)) {
        return { status: 400, body: { error: "MCP endpoints cannot be called through the Paperclip tools" } };
      }
      const response = await injectApiRequest(api, actor, request.method, request.path, request.body);
      return { status: response.statusCode, body: response.json };
    };
    // The token is never used in-process (the actor is); it is not needed here.
    const client = new PaperclipApiClient({ apiUrl: IN_PROCESS_API_URL, apiKey: "in-process", ...run }, transport);
    const tool = createRuntimeToolDefinitions(client, { readOnly }).find((candidate) => candidate.name === name)!;
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    return send(await tool.execute(args));
  });
  return router;
}

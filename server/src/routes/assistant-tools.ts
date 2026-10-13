import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assistantToolContext, type AssistantTools } from "../services/assistant-tools.js";
import { forbidden } from "../errors.js";

/**
 * Person-scoped tools for the built-in Assistant. Mounted after actor
 * middleware; only the Assistant's own live run JWT authenticates here, and
 * every tool call is dispatched as the run's responsible person.
 */
export function assistantToolRoutes(db: Db, tools: AssistantTools) {
  const router = Router();
  router.post("/mcp/assistant-tools", async (req, res) => {
    // Company scope comes from the run JWT itself. assertCompanyAccess is not
    // used: every JSON-RPC method is a POST, which would deny a viewer's reads.
    const context = await assistantToolContext(db, req.actor);
    const { id = null, method, params } = req.body ?? {};
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "staples-assistant-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: tools.definitions(context.canWrite, context.mode) });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const name = typeof params?.name === "string" ? params.name : "";
    // A weekly update run may write only its own update; tools.call enforces that.
    if (tools.isWriteTool(name) && !context.canWrite && context.mode !== "weekly_update") throw forbidden("This person has read-only access");
    return send(await tools.call(context, name, params?.arguments ?? {}));
  });
  return router;
}

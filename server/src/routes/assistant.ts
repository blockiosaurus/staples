import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { issueService } from "../services/issues.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * The company Assistant: a built-in agent every person can chat with. It is
 * kept out of staff surfaces, so this route is how the UI reaches it.
 */
export function assistantRoutes(db: Db) {
  const router = Router();
  const builtIns = builtInAgentService(db);
  const issues = issueService(db);

  router.get("/companies/:companyId/assistant", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw forbidden("Board user access required");
    const agent = await builtIns.ensureAssistant(companyId);
    const conversation = await issues.getConversation(companyId, agent.id, req.actor.userId);
    res.json({
      agent: {
        id: agent.id,
        name: agent.name,
        urlKey: agent.urlKey,
        adapterType: agent.adapterType,
        status: agent.status,
      },
      conversationIssueId: conversation?.id ?? null,
    });
  });

  return router;
}

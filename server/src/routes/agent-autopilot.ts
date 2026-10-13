import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { agentAutopilotCapabilitySchema, isUuidLike, updateAgentAutopilotSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { agentAutopilotService } from "../services/agent-autopilot.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Autopilot for templated agents: per outward category, ask first (the
 * install default) or act without asking. Board users who may update the
 * agent's configuration; agents never.
 */
export function agentAutopilotRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const autopilot = agentAutopilotService(db);

  /** The agent, for a board user with `action` on it (404 outside the person's companies). */
  async function authorizedAgent(req: Request, action: "agent_config:read" | "agent_config:update") {
    const agentId = req.params.agentId as string;
    if (!isUuidLike(agentId)) throw notFound("Agent not found");
    if (req.actor.type !== "board") throw forbidden("Autopilot is changed by a person on the board");
    const [agent] = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action,
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    return agent;
  }

  router.get("/agents/:agentId/autopilot", async (req, res) => {
    const agent = await authorizedAgent(req, "agent_config:read");
    res.json({ categories: await autopilot.list(agent.companyId, agent.id) });
  });

  router.put("/agents/:agentId/autopilot/:capability", validate(updateAgentAutopilotSchema), async (req, res) => {
    const agent = await authorizedAgent(req, "agent_config:update");
    const capability = agentAutopilotCapabilitySchema.safeParse(req.params.capability);
    if (!capability.success) throw notFound("This agent has no Autopilot category with that name");
    const { mode } = updateAgentAutopilotSchema.parse(req.body);
    const actor = getActorInfo(req);
    const result = await autopilot.setMode(agent.companyId, agent.id, capability.data, mode, req.actor.userId ?? null);
    if (result.changed) {
      await logActivity(db, {
        companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
        action: "agent.autopilot_changed", entityType: "agent", entityId: agent.id,
        details: {
          capability: capability.data, mode, connectionId: result.category.connection?.id ?? null, policyId: result.policyId,
        },
      });
    }
    res.json(result.category);
  });

  return router;
}

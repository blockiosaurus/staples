import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { AGENT_TEMPLATE_REF_PREFIX } from "@paperclipai/shared";
import type { AgentTemplateContext } from "../services/agent-templates.js";
import { defaultAgentTemplates, planTemplateContext, type AgentTemplatesService } from "../services/plan-templates.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";

export interface AgentTemplateRoutesOptions {
  /** Template source (defaults to the shipped catalog). */
  templates?: AgentTemplatesService;
  /** Company and person names for `{{company.name}}` / `{{person.name}}` (defaults to the database). */
  context?: (companyId: string, userId: string | null) => Promise<AgentTemplateContext>;
}

/**
 * The "Hire an agent" marketplace: hireable agent templates, read by people
 * on the board. Preview templates are hidden. Hiring itself goes through the
 * Assistant's plans, never through these routes.
 */
export function agentTemplateRoutes(db: Db, opts: AgentTemplateRoutesOptions = {}) {
  const router = Router();
  const templates = () => opts.templates ?? defaultAgentTemplates();
  const context = opts.context ?? ((companyId, userId) => planTemplateContext(db, companyId, userId));

  function authorize(req: Request) {
    const companyId = req.params.companyId as string;
    assertAuthenticated(req);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get("/companies/:companyId/agent-templates", async (req, res) => {
    authorize(req);
    res.json(await templates().list());
  });

  router.get("/companies/:companyId/agent-templates/:slug", async (req, res) => {
    const companyId = authorize(req);
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const ctx = await context(companyId, userId);
    res.json(await templates().get(`${AGENT_TEMPLATE_REF_PREFIX}${req.params.slug}`, {
      companyName: ctx.companyName,
      personName: ctx.personName,
    }));
  });

  return router;
}

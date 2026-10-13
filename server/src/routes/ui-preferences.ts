import { Router } from "express";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { patchUiPreferencesSchema, type PatchUiPreferences } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity, uiPreferencesService } from "../services/index.js";
import { assertBoard, getActorInfo, hasCompanyAccess } from "./authz.js";

/** Ops that reflect a deliberate person choice; reveal/see are automatic and never logged. */
const INTENT_OPS = ["pin", "unpin", "hide", "unhide", "showEverything"] as const;

function intentOps(patch: PatchUiPreferences): Partial<PatchUiPreferences> {
  const out: Record<string, unknown> = {};
  for (const key of INTENT_OPS) if (patch[key] !== undefined) out[key] = patch[key];
  return out as Partial<PatchUiPreferences>;
}

export function uiPreferencesRoutes(db: Db) {
  const router = Router();
  const svc = uiPreferencesService(db);
  router.use("/companies/:companyId/ui-preferences/me", async (req, _res, next) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    if (!hasCompanyAccess(req, companyId)) throw forbidden("User does not have access to this company");
    if (!req.actor.userId) throw forbidden("Board user access required");
    // Personal preferences follow the same self-service rules as primary agent
    // choice: viewers may adjust their own navigation too.
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      && !req.actor.memberships?.some(membership => membership.companyId === companyId && membership.status === "active")) {
      throw forbidden("User does not have active company access");
    }
    if (!await db.query.companies.findFirst({ where: eq(companies.id, companyId) })) {
      throw notFound("Company not found");
    }
    next();
  });

  router.get("/companies/:companyId/ui-preferences/me", async (req, res) => {
    res.json(await svc.get(req.params.companyId as string, req.actor.userId!));
  });

  router.patch("/companies/:companyId/ui-preferences/me", validate(patchUiPreferencesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = req.body as PatchUiPreferences;
    const { preferences, changed } = await svc.patch(companyId, req.actor.userId!, body);
    const details = intentOps(body);
    // Only deliberate, effective changes reach the company activity feed.
    if (!changed || Object.keys(details).length === 0) {
      res.json(preferences);
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "ui_preferences.updated",
      entityType: "company",
      entityId: companyId,
      details,
    });
    res.json(preferences);
  });

  return router;
}

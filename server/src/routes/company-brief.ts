import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike, updateCompanyBriefSchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyBriefService } from "../services/company-brief.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyBriefRoutes(db: Db) {
  const router = Router();
  const svc = companyBriefService(db);

  // Every agent in the company and every member may read the brief.
  router.get("/companies/:companyId/brief", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    res.json(await svc.get(companyId));
  });

  // People (and their Assistant, acting as them) edit it; viewers are read-only.
  router.put("/companies/:companyId/brief", validate(updateCompanyBriefSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const brief = await svc.update(companyId, req.body, {
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.brief_updated",
      entityType: "company",
      entityId: companyId,
      details: { revisionId: brief.revisionId, revisionNumber: brief.revisionNumber, length: brief.body.length },
    });
    res.json(brief);
  });

  return router;
}

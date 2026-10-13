import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { briefingService } from "../services/briefing.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function briefingRoutes(db: Db) {
  const router = Router();
  const svc = briefingService(db);

  router.get("/companies/:companyId/briefing", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    res.json(await svc.get({ companyId, userId: req.actor.userId, actor: req.actor }));
  });

  return router;
}

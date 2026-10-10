import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companySignalsService } from "../services/company-signals.js";
import { assertCompanyAccess } from "./authz.js";

export function companySignalsRoutes(db: Db) {
  const router = Router();
  const svc = companySignalsService(db);

  router.get("/companies/:companyId/signals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.get(companyId));
  });

  return router;
}

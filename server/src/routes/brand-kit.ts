import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { renderBrandKit } from "@paperclipai/brand-kit";
import { brandKitSpecSchema, isUuidLike } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { brandStarterService, rasterize } from "../services/brand-starter.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const publishSchema = z.object({
  issueId: z.string().uuid(),
  spec: brandKitSpecSchema,
  document: z.string().max(20000),
  tagline: z.string().max(80).optional(),
});

export function brandKitRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const starter = brandStarterService(db, storage);

  router.get("/companies/:companyId/brand-starter", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    res.json(await starter.status(companyId));
  });

  router.post("/companies/:companyId/brand-kit/render", validate(brandKitSpecSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    const out = renderBrandKit(req.body);
    const concepts = await Promise.all(
      out.concepts.map(async (c) => ({
        ...c,
        previewPng: c.lint.ok && c.lockupSvg ? (await rasterize(c.lockupSvg, 512)).toString("base64") : "",
      })),
    );
    res.json({ palette: out.palette, pairing: { id: out.pairing.id, label: out.pairing.label }, concepts });
  });

  router.post("/companies/:companyId/brand-kit/publish", validate(publishSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof publishSchema>;
    const result = await starter.publish(companyId, {
      issueId: body.issueId,
      spec: body.spec,
      document: body.document,
      tagline: body.tagline,
      actor,
    });
    res.status(201).json(result);
  });

  return router;
}

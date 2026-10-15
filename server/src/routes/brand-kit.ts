import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { BrandKitError, renderBrandKit } from "@paperclipai/brand-kit";
import { brandKitPublishSchema, brandKitSpecSchema, isUuidLike } from "@paperclipai/shared";
import { badRequest, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { brandStarterService, rasterize } from "../services/brand-starter.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

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
    let out: ReturnType<typeof renderBrandKit>;
    try {
      out = renderBrandKit(req.body);
    } catch (err) {
      if (err instanceof BrandKitError) throw unprocessable(err.message);
      throw err;
    }
    const concepts = await Promise.all(
      out.concepts.map(async (c) => {
        let previewPng = "";
        if (c.lint.ok && c.lockupSvg) {
          try {
            previewPng = (await rasterize(c.lockupSvg, 512)).toString("base64");
          } catch {
            throw unprocessable(`Could not render a preview for concept ${c.index} (${c.name})`);
          }
        }
        return { ...c, previewPng };
      }),
    );
    res.json({ palette: out.palette, pairing: { id: out.pairing.id, label: out.pairing.label }, concepts });
  });

  router.post("/companies/:companyId/brand-kit/publish", validate(brandKitPublishSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company id");
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof brandKitPublishSchema>;
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

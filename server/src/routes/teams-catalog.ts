import { Router, type Request } from "express";
import { assertSelfServeAdapterAllowed, getSelfServePolicy, isSelfServeRestricted } from "../services/self-serve-policy.js";
import type { Db } from "@paperclipai/db";
import {
  AGENT_TEMPLATE_TEAMS_CATALOG_REJECTION,
  catalogTeamInstallSchema,
  catalogTeamListQuerySchema,
  catalogTeamPreviewSchema,
  isAgentTemplateCatalogEntry,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService } from "../services/index.js";
import {
  getCatalogTeamOrThrow,
  listCatalogTeams,
  readCatalogTeamFile,
  teamsCatalogService,
} from "../services/teams-catalog.js";
import { forbidden, unprocessable } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

export function teamsCatalogRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = teamsCatalogService(db);

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  async function assertCanInstallCatalogTeam(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  /** Staples agent templates install only through the Assistant's plans. */
  async function assertNotAgentTemplate(catalogRef: string) {
    if (isAgentTemplateCatalogEntry(await getCatalogTeamOrThrow(catalogRef))) {
      throw unprocessable(AGENT_TEMPLATE_TEAMS_CATALOG_REJECTION);
    }
  }

  router.get("/teams/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogTeamListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    const teams = await listCatalogTeams(query);
    res.json(teams.filter((team) => !isAgentTemplateCatalogEntry(team)));
  });

  // Detail and file reads stay available for agent templates by id or key:
  // they are read-only, and preview/install below reject templates.
  router.get("/teams/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "TEAM.md";
    res.json(await readCatalogTeamFile(catalogRef, relativePath));
  });

  router.get("/teams/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(await getCatalogTeamOrThrow(catalogRef));
  });

  router.get("/companies/:companyId/teams/catalog/installed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listInstalledCatalogTeams(companyId));
  });

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/preview",
    validate(catalogTeamPreviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      assertCompanyAccess(req, companyId);
      await assertNotAgentTemplate(catalogRef);
      const result = await svc.previewCatalogTeamImport(companyId, catalogRef, {
        ...req.body,
        actor: getActorInfo(req),
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/install",
    validate(catalogTeamInstallSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      await assertCanInstallCatalogTeam(req, companyId);
      await assertNotAgentTemplate(catalogRef);
      // Self-serve floor: every installed agent must use an allowed remote
      // adapter, including catalog agents that would default to a local CLI.
      let defaultAdapterType: string | undefined;
      if (isSelfServeRestricted(req)) {
        const overrides = (req.body.adapterOverrides ?? {}) as Record<string, { adapterType?: string }>;
        for (const override of Object.values(overrides)) {
          assertSelfServeAdapterAllowed(req, override.adapterType);
        }
        defaultAdapterType = getSelfServePolicy().adapterTypes[0];
        assertSelfServeAdapterAllowed(req, defaultAdapterType);
      }
      const result = await svc.installCatalogTeam(companyId, catalogRef, {
        ...req.body,
        ...(defaultAdapterType ? { defaultAdapterType } : {}),
        actor: getActorInfo(req),
      });
      res.status(201).json(result);
    },
  );

  return router;
}

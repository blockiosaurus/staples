import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUiPreferencesService = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFindCompany = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    uiPreferencesService: () => mockUiPreferencesService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ uiPreferencesRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/ui-preferences.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", uiPreferencesRoutes({ query: { companies: { findFirst: mockFindCompany } } } as never));
  app.use(errorHandler);
  return app;
}

const PREFS = { pinned: ["agents"], hidden: [], revealed: {}, seen: {}, showEverything: false, updatedAt: null };

function memberActor(role = "operator") {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }],
  };
}

describe("ui preferences routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/ui-preferences.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockFindCompany.mockResolvedValue({ id: "company-1" });
    mockUiPreferencesService.get.mockResolvedValue(PREFS);
    mockUiPreferencesService.patch.mockResolvedValue(PREFS);
  });

  it("returns preferences for a company member", async () => {
    const app = await createApp(memberActor());
    const res = await request(app).get("/api/companies/company-1/ui-preferences/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PREFS);
    expect(mockUiPreferencesService.get).toHaveBeenCalledWith("company-1", "user-1");
  });

  it("lets a viewer patch their own preferences and logs activity", async () => {
    const app = await createApp(memberActor("viewer"));
    const body = { pin: ["agents"], showEverything: true };
    const res = await request(app).patch("/api/companies/company-1/ui-preferences/me").send(body);
    expect(res.status).toBe(200);
    expect(mockUiPreferencesService.patch).toHaveBeenCalledWith("company-1", "user-1", body);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "ui_preferences.updated",
        entityType: "company",
        entityId: "company-1",
        details: body,
      }),
    );
  });

  it("rejects an empty patch", async () => {
    const app = await createApp(memberActor());
    const res = await request(app).patch("/api/companies/company-1/ui-preferences/me").send({});
    expect(res.status).toBe(400);
    expect(mockUiPreferencesService.patch).not.toHaveBeenCalled();
  });

  it("rejects non-members", async () => {
    const app = await createApp({ ...memberActor(), companyIds: ["company-2"], memberships: [] });
    const res = await request(app).get("/api/companies/company-1/ui-preferences/me");
    expect(res.status).toBe(403);
    expect(mockUiPreferencesService.get).not.toHaveBeenCalled();
  });

  it("returns 404 when the company does not exist", async () => {
    mockFindCompany.mockResolvedValue(undefined);
    const app = await createApp(memberActor());
    const res = await request(app).get("/api/companies/company-1/ui-preferences/me");
    expect(res.status).toBe(404);
  });
});

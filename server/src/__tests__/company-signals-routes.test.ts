import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSignalsService = vi.hoisted(() => ({ get: vi.fn() }));

async function createApp(actor: Record<string, unknown>) {
  vi.doMock("../services/company-signals.js", () => ({
    companySignalsService: () => mockSignalsService,
  }));
  const [{ companySignalsRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/company-signals.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", companySignalsRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
};

describe("company signals routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/company-signals.js");
    vi.doUnmock("../routes/company-signals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockSignalsService.get.mockResolvedValue({ companyId: "company-1", agents: 2 });
  });

  it("returns signals for an accessible company", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/signals");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ companyId: "company-1", agents: 2 });
    expect(mockSignalsService.get).toHaveBeenCalledWith("company-1");
  });

  it("rejects access to another company", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-2/signals");
    expect(res.status).toBe(403);
    expect(mockSignalsService.get).not.toHaveBeenCalled();
  });
});

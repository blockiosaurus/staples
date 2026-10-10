import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_1 = "11111111-1111-4111-8111-111111111111";
const COMPANY_2 = "22222222-2222-4222-8222-222222222222";
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
  companyIds: [COMPANY_1],
  memberships: [{ companyId: COMPANY_1, status: "active", membershipRole: "owner" }],
};

describe("company signals routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/company-signals.js");
    vi.doUnmock("../routes/company-signals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockSignalsService.get.mockResolvedValue({ companyId: COMPANY_1, agents: 2 });
  });

  it("returns signals for an accessible company", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${COMPANY_1}/signals`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ companyId: COMPANY_1, agents: 2 });
    expect(mockSignalsService.get).toHaveBeenCalledWith(COMPANY_1);
  });

  it("rejects access to another company", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${COMPANY_2}/signals`);
    expect(res.status).toBe(403);
    expect(mockSignalsService.get).not.toHaveBeenCalled();
  });

  it("rejects agent actors", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: COMPANY_1, source: "agent_key" });
    const res = await request(app).get(`/api/companies/${COMPANY_1}/signals`);
    expect(res.status).toBe(403);
    expect(mockSignalsService.get).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-uuid company id", async () => {
    const app = await createApp({ ...boardActor, companyIds: ["not-a-uuid"] });
    const res = await request(app).get("/api/companies/not-a-uuid/signals");
    expect(res.status).toBe(400);
    expect(mockSignalsService.get).not.toHaveBeenCalled();
  });
});

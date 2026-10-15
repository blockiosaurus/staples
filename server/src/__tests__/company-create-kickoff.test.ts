import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({ create: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));
const mockStart = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", async (orig) => {
  const mod = await orig<typeof import("../middleware/logger.js")>();
  return { ...mod, logger: new Proxy(mod.logger, { get: (t, k) => (k === "warn" ? mockWarn : (t as any)[k]) }) };
});

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({}),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  feedbackService: () => ({}),
  logActivity: vi.fn(),
  publishActivity: vi.fn(),
  workTimelineService: () => ({}),
}));
vi.mock("../services/brand-starter.js", () => ({
  brandStarterService: () => ({ start: mockStart }),
}));

async function createApp() {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies kickoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.create.mockResolvedValue({
      id: "company-new", name: "Acme", description: "Bread bakery", budgetMonthlyCents: 0,
    });
    mockStart.mockResolvedValue({ issueId: "issue-1" });
  });

  it("starts the brand starter with the description when kickoff is true", async () => {
    const app = await createApp();
    const res = await request(app).post("/api/companies").send({ name: "Acme", description: "Bread bakery", kickoff: true });
    expect(res.status).toBe(201);
    expect(mockStart).toHaveBeenCalledWith("company-new", { description: "Bread bakery", userId: "local-board", companyName: "Acme", nameGiven: true });
    expect(mockCompanyService.create.mock.calls[0][0]).not.toHaveProperty("kickoff");
  });

  it("reports the name as not given when it is the derived working name", async () => {
    const { deriveWorkingName } = await import("@paperclipai/shared");
    const description = "A bakery in Leeds that sells sourdough";
    const working = deriveWorkingName(description);
    mockCompanyService.create.mockResolvedValue({ id: "company-new", name: working, description, budgetMonthlyCents: 0 });
    const app = await createApp();
    await request(app).post("/api/companies").send({ name: working, description, kickoff: true });
    expect(mockStart).toHaveBeenCalledWith("company-new", expect.objectContaining({ companyName: working, nameGiven: false }));
  });

  it("does not start it otherwise, and a failed start does not fail creation", async () => {
    const app = await createApp();
    await request(app).post("/api/companies").send({ name: "Acme" });
    expect(mockStart).not.toHaveBeenCalled();
    mockStart.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).post("/api/companies").send({ name: "Acme", kickoff: true });
    expect(res.status).toBe(201);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-new" }), "brand starter did not start");
  });
});

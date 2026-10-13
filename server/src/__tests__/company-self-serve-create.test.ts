import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ownCompanyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
  countActiveOwnedCompanies: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({}),
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  feedbackService: () => ({}),
  logActivity: mockLogActivity,
  workTimelineService: () => ({}),
}));

const createdCompany = {
  id: "company-new",
  name: "Trial Co",
  budgetMonthlyCents: 0,
};

type RouteOptions = {
  deploymentMode?: "local_trusted" | "authenticated";
  selfServeCompanies?: boolean;
  selfServeCompanyLimit?: number;
};

async function createApp(actor: Record<string, unknown>, options: RouteOptions) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, undefined, options));
  app.use(errorHandler);
  return app;
}

const memberSession = {
  type: "board",
  source: "session",
  userId: "user-member",
  sessionId: "session-1",
  isInstanceAdmin: false,
  companyIds: [] as string[],
  memberships: [] as unknown[],
};

const adminSession = {
  ...memberSession,
  userId: "user-admin",
  isInstanceAdmin: true,
};

const selfServeOn: RouteOptions = {
  deploymentMode: "authenticated",
  selfServeCompanies: true,
  selfServeCompanyLimit: 3,
};

describe("POST /api/companies self-serve creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    mockCompanyService.create.mockResolvedValue(createdCompany);
    mockAccessService.countActiveOwnedCompanies.mockResolvedValue(0);
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
  });

  it("keeps creation admin-only when the flag is off", async () => {
    const app = await createApp(memberSession, { deploymentMode: "authenticated", selfServeCompanies: false });

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Instance admin required");
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("still lets an instance admin create when the flag is off", async () => {
    const app = await createApp(adminSession, { deploymentMode: "authenticated", selfServeCompanies: false });

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(mockAccessService.countActiveOwnedCompanies).not.toHaveBeenCalled();
  });

  it("lets a signed-in non-admin create a company and become its owner", async () => {
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdCompany);
    expect(mockCompanyService.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Trial Co",
      defaultResponsibleUserId: "user-member",
    }));
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      "company-new",
      "user",
      "user-member",
      "owner",
      "active",
    );
    expect(mockAccessService.ensureRoleDefaultGrants).toHaveBeenCalledWith(
      "company-new",
      "user-member",
      "owner",
      "user-member",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-new",
      actorType: "user",
      actorId: "user-member",
      action: "company.created",
      details: { name: "Trial Co", selfServe: true },
    }));
  });

  it("does not apply in local_trusted mode", async () => {
    const app = await createApp(memberSession, { ...selfServeOn, deploymentMode: "local_trusted" });

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("requires a browser session, not a board API key", async () => {
    const app = await createApp({ ...memberSession, source: "board_key", sessionId: null }, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("rejects agents", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: ownCompanyId, source: "agent_key" }, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("returns a plain 403 once the user owns the limit", async () => {
    mockAccessService.countActiveOwnedCompanies.mockResolvedValue(3);
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_company_limit" });
    expect(res.body.error).toMatch(/own 3 active companies/);
    expect(mockAccessService.countActiveOwnedCompanies).toHaveBeenCalledWith("user-member");
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("honours a custom limit", async () => {
    mockAccessService.countActiveOwnedCompanies.mockResolvedValue(1);
    const app = await createApp(memberSession, { ...selfServeOn, selfServeCompanyLimit: 1 });

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_company_limit" });
    expect(res.body.error).toMatch(/own 1 active company,/);
  });

  it("does not limit instance admins", async () => {
    mockAccessService.countActiveOwnedCompanies.mockResolvedValue(10);
    const app = await createApp(adminSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(mockAccessService.countActiveOwnedCompanies).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: { name: "Trial Co" },
    }));
  });
});

describe("self-serve users stay inside their own companies", () => {
  const ownerSession = {
    ...memberSession,
    companyIds: [ownCompanyId],
    memberships: [{ companyId: ownCompanyId, membershipRole: "owner", status: "active" }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.list.mockResolvedValue([
      { id: ownCompanyId, name: "Mine" },
      { id: otherCompanyId, name: "Someone else's" },
    ]);
    mockCompanyService.getById.mockImplementation(async (id: string) => ({ id, name: "Company" }));
  });

  it("lists only the companies the user belongs to", async () => {
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app).get("/api/companies");

    expect(res.status).toBe(200);
    expect(res.body.map((company: { id: string }) => company.id)).toEqual([ownCompanyId]);
  });

  it("cannot read another user's company", async () => {
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app).get(`/api/companies/${otherCompanyId}`);

    expect(res.status).toBe(403);
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
  });

  it("cannot change another user's company", async () => {
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app).patch(`/api/companies/${otherCompanyId}`).send({ name: "Taken" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

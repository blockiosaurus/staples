import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSelfServePolicy, resetSelfServePolicy } from "../services/self-serve-policy.js";

const ownCompanyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn(),
  createRecord: vi.fn(),
  completeCreate: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
  countSelfServeCompaniesCreatedBy: vi.fn(),
  withSelfServeCompanyLock: vi.fn(),
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

// Answers isSelfServeCompany lookups: every company reads as self-serve.
let companyIsSelfServe = true;
const dbStub = {
  select: () => ({
    from: () => ({
      where: () => ({
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ selfServe: companyIsSelfServe }]).then(resolve),
      }),
    }),
  }),
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
  app.use("/api/companies", companyRoutes(dbStub as any, undefined, options));
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

let ownedCount = 0;
const lockTx = { tx: true };
mockAccessService.withSelfServeCompanyLock.mockImplementation(
  async (_userId: string, fn: (tx: unknown, count: () => Promise<number>) => Promise<unknown>) => fn(lockTx, async () => ownedCount),
);

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
    mockCompanyService.createRecord.mockResolvedValue({ id: createdCompany.id });
    mockCompanyService.completeCreate.mockResolvedValue(createdCompany);
    ownedCount = 0;
    vi.stubEnv("STAPLES_HOSTED_ANTHROPIC_API_KEY", "sk-ant-test-self-serve");
    vi.stubEnv("STAPLES_HOSTED_INFERENCE", "");
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    vi.unstubAllEnvs();
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
    expect(mockAccessService.withSelfServeCompanyLock).not.toHaveBeenCalled();
  });

  it("lets a signed-in non-admin create a company and become its owner", async () => {
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdCompany);
    expect(mockCompanyService.createRecord).toHaveBeenCalledWith(expect.objectContaining({
      name: "Trial Co",
      defaultResponsibleUserId: "user-member",
      selfServe: true,
      selfServeCreatedByUserId: "user-member",
    }), lockTx);
    expect(mockCompanyService.completeCreate).toHaveBeenCalledWith("company-new");
    expect(mockCompanyService.create).not.toHaveBeenCalled();
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

  it("rejects a Cloud tenant session", async () => {
    const app = await createApp({ ...memberSession, source: "cloud_tenant" }, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("refuses self-serve creation when hosted inference is not set up", async () => {
    vi.stubEnv("STAPLES_HOSTED_ANTHROPIC_API_KEY", "");
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "self_serve_hosted_inference_required" });
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("writes the row and owner membership inside the lock, and provisions after it", async () => {
    const order: string[] = [];
    mockAccessService.withSelfServeCompanyLock.mockImplementationOnce(
      async (_userId: string, fn: (tx: unknown, count: () => Promise<number>) => Promise<unknown>) => {
        order.push("lock");
        const result = await fn(lockTx, async () => 0);
        order.push("unlock");
        return result;
      },
    );
    mockCompanyService.createRecord.mockImplementationOnce(async (_data: unknown, executor: unknown) => {
      order.push(executor === lockTx ? "insert-on-tx" : "insert-elsewhere");
      return { id: createdCompany.id };
    });
    mockAccessService.ensureMembership.mockImplementationOnce(async () => {
      order.push("membership");
    });
    mockCompanyService.completeCreate.mockImplementationOnce(async () => {
      order.push("provision");
      return createdCompany;
    });
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(order).toEqual(["lock", "insert-on-tx", "membership", "unlock", "provision"]);
  });

  it("returns 409 when another create by the same user holds the lock", async () => {
    const { conflict } = await import("../errors.js");
    mockAccessService.withSelfServeCompanyLock.mockRejectedValueOnce(
      conflict("Another company is being created for you. Try again in a moment.", { code: "self_serve_company_create_in_progress" }),
    );
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "self_serve_company_create_in_progress" });
    expect(mockCompanyService.createRecord).not.toHaveBeenCalled();
  });

  it("rejects agents", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: ownCompanyId, source: "agent_key" }, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("returns a plain 403 once the user owns the limit", async () => {
    ownedCount = 3;
    const app = await createApp(memberSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_company_limit" });
    expect(res.body.error).toMatch(/created 3 companies/);
    expect(mockAccessService.withSelfServeCompanyLock).toHaveBeenCalledWith("user-member", expect.any(Function));
    expect(mockCompanyService.createRecord).not.toHaveBeenCalled();
  });

  it("honours a custom limit", async () => {
    ownedCount = 1;
    const app = await createApp(memberSession, { ...selfServeOn, selfServeCompanyLimit: 1 });

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_company_limit" });
    expect(res.body.error).toMatch(/created 1 company,/);
  });

  it("does not limit instance admins", async () => {
    ownedCount = 10;
    const app = await createApp(adminSession, selfServeOn);

    const res = await request(app).post("/api/companies").send({ name: "Trial Co" });

    expect(res.status).toBe(201);
    expect(mockAccessService.withSelfServeCompanyLock).not.toHaveBeenCalled();
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

describe("self-serve unarchive, delete and import floors", () => {
  const ownerSession = {
    ...memberSession,
    companyIds: [ownCompanyId],
    memberships: [{ companyId: ownCompanyId, membershipRole: "owner", status: "active" }],
  };
  const archivedSelfServe = {
    id: ownCompanyId, name: "Mine", status: "archived", feedbackDataSharingEnabled: false,
    selfServe: true, selfServeCreatedByUserId: "user-member",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    companyIsSelfServe = true;
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
    mockCompanyService.getById.mockResolvedValue(archivedSelfServe);
    mockCompanyService.update.mockResolvedValue({ ...archivedSelfServe, status: "active" });
    mockCompanyService.remove.mockResolvedValue({ id: ownCompanyId });
  });

  afterEach(() => {
    resetSelfServePolicy();
  });

  it("refuses to unarchive past the creator's limit, so archiving cannot bypass it", async () => {
    mockAccessService.countSelfServeCompaniesCreatedBy.mockResolvedValue(3);
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app).patch(`/api/companies/${ownCompanyId}`).send({ status: "active" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_company_limit" });
    expect(mockAccessService.countSelfServeCompaniesCreatedBy).toHaveBeenCalledWith("user-member", {
      includeArchived: false,
      excludeCompanyId: ownCompanyId,
    });
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("lets an instance admin unarchive without the limit", async () => {
    const app = await createApp({ ...ownerSession, isInstanceAdmin: true }, selfServeOn);

    const res = await request(app).patch(`/api/companies/${ownCompanyId}`).send({ status: "active" });

    expect(res.status).not.toBe(403);
    expect(mockAccessService.countSelfServeCompaniesCreatedBy).not.toHaveBeenCalled();
  });

  it("refuses deleting a self-serve company for a non-admin", async () => {
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app).delete(`/api/companies/${ownCompanyId}`);

    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("lets an instance admin delete a self-serve company", async () => {
    const app = await createApp({ ...ownerSession, isInstanceAdmin: true }, selfServeOn);

    const res = await request(app).delete(`/api/companies/${ownCompanyId}`);

    expect(res.status).toBe(200);
    expect(mockCompanyService.remove).toHaveBeenCalledWith(ownCompanyId);
  });

  it("refuses company package imports into a self-serve company", async () => {
    const app = await createApp(ownerSession, selfServeOn);

    const res = await request(app)
      .post(`/api/companies/${ownCompanyId}/imports/preview`)
      .send({ source: { type: "inline", files: {} } });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "self_serve_host_execution_forbidden" });
  });
});

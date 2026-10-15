import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_1 = "11111111-1111-4111-8111-111111111111";
const COMPANY_2 = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";
const mockStarter = vi.hoisted(() => ({ status: vi.fn(), publish: vi.fn() }));

async function createApp(actor: Record<string, unknown>) {
  vi.doMock("../services/brand-starter.js", async () => {
    const actual = await vi.importActual<typeof import("../services/brand-starter.js")>("../services/brand-starter.js");
    return { ...actual, brandStarterService: () => mockStarter };
  });
  const [{ brandKitRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/brand-kit.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", brandKitRoutes({} as never, {} as never));
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
const agentActor = { type: "agent", agentId: "agent-1", companyId: COMPANY_1, source: "agent_key" };

const spec = {
  businessName: "Maple Bakery",
  mood: "warm",
  fontPairingId: "",
  concepts: [
    { kind: "geometric", name: "Sun", shapes: [{ type: "circle", cx: 32, cy: 32, r: 20, fill: "primary" }] },
    { kind: "monogram", name: "Letter", letters: "MB", frame: "circle" },
    { kind: "wordmark", name: "Word" },
  ],
};

const emptyStatus = { issue: null, designerName: null, latestNote: null, concepts: [], documentPath: null, palettePath: null, tagline: null };

async function validSpec() {
  const { listFontPairings } = await import("@paperclipai/brand-kit");
  return { ...spec, fontPairingId: listFontPairings()[0]!.id };
}

describe("brand kit routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/brand-starter.js");
    vi.doUnmock("../routes/brand-kit.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockStarter.status.mockResolvedValue(emptyStatus);
    mockStarter.publish.mockResolvedValue(emptyStatus);
  });

  it("returns the brand starter status for a board member", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${COMPANY_1}/brand-starter`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyStatus);
    expect(mockStarter.status).toHaveBeenCalledWith(COMPANY_1);
  });

  it("rejects an agent of another company", async () => {
    const app = await createApp({ ...agentActor, companyId: COMPANY_2 });
    const res = await request(app).get(`/api/companies/${COMPANY_1}/brand-starter`);
    expect(res.status).toBe(403);
    expect(mockStarter.status).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-uuid company id", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/nope/brand-starter");
    expect(res.status).toBe(400);
  });

  it("renders three concepts with previews", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).post(`/api/companies/${COMPANY_1}/brand-kit/render`).send(await validSpec());
    expect(res.status).toBe(200);
    expect(res.body.concepts).toHaveLength(3);
    for (const c of res.body.concepts) {
      expect(c.lint.ok).toBe(true);
      expect(c.previewPng.length).toBeGreaterThan(100);
      expect(Buffer.from(c.previewPng, "base64").subarray(1, 4).toString()).toBe("PNG");
    }
    expect(res.body.palette).toBeTruthy();
    expect(res.body.pairing).toEqual({ id: expect.any(String), label: expect.any(String) });
  });

  it("rejects an invalid spec and another company's render", async () => {
    const app = await createApp(boardActor);
    const s = await validSpec();
    const bad = await request(app)
      .post(`/api/companies/${COMPANY_1}/brand-kit/render`)
      .send({ ...s, concepts: [...s.concepts, ...s.concepts.slice(0, 2)] });
    expect(bad.status).toBe(400);
    const other = await request(app).post(`/api/companies/${COMPANY_2}/brand-kit/render`).send(s);
    expect(other.status).toBe(403);
  });

  it("returns 422, not 500, for an unknown font pairing", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_1}/brand-kit/render`)
      .send({ ...(await validSpec()), fontPairingId: "no-such-pairing" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("unknown font pairing");
  });

  it("publishes as a company agent", async () => {
    const app = await createApp(agentActor);
    const s = await validSpec();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_1}/brand-kit/publish`)
      .send({ issueId: ISSUE, spec: s, document: "# Brand", tagline: "Fresh daily" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(emptyStatus);
    expect(mockStarter.publish).toHaveBeenCalledWith(
      COMPANY_1,
      expect.objectContaining({ issueId: ISSUE, spec: s, document: "# Brand", tagline: "Fresh daily" }),
    );
  });

  it("rejects a non-uuid issue id on publish", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_1}/brand-kit/publish`)
      .send({ issueId: "nope", spec: await validSpec(), document: "# Brand" });
    expect(res.status).toBe(400);
    expect(mockStarter.publish).not.toHaveBeenCalled();
  });
});

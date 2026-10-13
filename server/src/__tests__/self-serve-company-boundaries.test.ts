import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A self-serve user owns their own company and nothing else. Joining someone
 * else's company needs a valid invite from that company: they cannot grant
 * themselves access, create invites for it, or approve join requests in it.
 * These checks throw before data access, so a stub db suffices.
 */

const ownCompanyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

const stubDb = {
  select: () => ({
    from: () => {
      const chain = {
        orderBy: async () => [] as unknown[],
        where: () => Object.assign(Promise.resolve([] as unknown[]), {
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        }),
      };
      return chain;
    },
  }),
} as never;

async function createApp() {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "self-serve-user",
      sessionId: "session-1",
      source: "session",
      companyIds: [ownCompanyId],
      memberships: [{ companyId: ownCompanyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
    next();
  });
  app.use("/api", accessRoutes(stubDb, {
    deploymentMode: "authenticated",
    deploymentExposure: "public",
    bindHost: "0.0.0.0",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

describe("self-serve users cannot join other companies", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await createApp();
  }, 30_000);

  it("cannot grant themselves access to another company", async () => {
    const res = await request(app)
      .put("/api/admin/users/self-serve-user/company-access")
      .send({ companyIds: [ownCompanyId, otherCompanyId] });

    expect(res.status).toBe(403);
  });

  it("cannot create an invite into another company", async () => {
    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/invites`)
      .send({ allowedJoinTypes: "human" });

    expect(res.status).toBe(403);
  });

  it("cannot approve a join request in another company", async () => {
    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/join-requests/33333333-3333-4333-8333-333333333333/approve`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("cannot join with an invite token that does not exist", async () => {
    const res = await request(app)
      .post("/api/invites/not-a-real-token/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(404);
  });
});

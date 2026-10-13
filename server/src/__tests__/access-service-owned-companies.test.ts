import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, describe } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("accessService.countOwnedCompanies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owned-companies-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function companyWith(
    userId: string,
    opts: { status?: string; role?: string; membershipStatus?: string } = {},
  ) {
    const company = await db
      .insert(companies)
      .values({
        name: `Owned ${randomUUID()}`,
        issuePrefix: `OW${randomUUID().slice(0, 6).toUpperCase()}`,
        status: opts.status ?? "active",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: opts.membershipStatus ?? "active",
      membershipRole: opts.role ?? "owner",
    });
    return company;
  }

  it("counts owned companies, with archived ones only for creation", async () => {
    const userId = `user-${randomUUID()}`;
    const active = await companyWith(userId);
    await companyWith(userId, { status: "paused" });
    await companyWith(userId, { status: "archived" });
    await companyWith(userId, { role: "member" });
    await companyWith(userId, { membershipStatus: "archived" });
    await companyWith(`someone-else-${randomUUID()}`);
    const svc = accessService(db);

    await expect(svc.countOwnedCompanies(userId, { includeArchived: true })).resolves.toBe(3);
    await expect(svc.countOwnedCompanies(userId, { includeArchived: false })).resolves.toBe(2);
    await expect(svc.countOwnedCompanies(userId, { includeArchived: false, excludeCompanyId: active.id })).resolves.toBe(1);
  });

  it("serializes a user's creations under the advisory lock", async () => {
    const userId = `user-${randomUUID()}`;
    const svc = accessService(db);
    const results = await Promise.all([0, 1].map(() => svc.withSelfServeCompanyLock(userId, async (count) => {
      const before = await count();
      if (before >= 1) return "refused";
      await companyWith(userId);
      return "created";
    })));

    expect(results.sort()).toEqual(["created", "refused"]);
  });

  it("returns 0 for a user with no companies", async () => {
    await expect(accessService(db).countOwnedCompanies(`user-${randomUUID()}`, { includeArchived: true })).resolves.toBe(0);
  });
});

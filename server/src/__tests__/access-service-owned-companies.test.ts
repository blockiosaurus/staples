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

describeEmbeddedPostgres("accessService.countActiveOwnedCompanies", () => {
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

  it("counts only active, non-archived companies the user owns", async () => {
    const userId = `user-${randomUUID()}`;
    await companyWith(userId);
    await companyWith(userId, { status: "paused" });
    await companyWith(userId, { status: "archived" });
    await companyWith(userId, { role: "member" });
    await companyWith(userId, { membershipStatus: "archived" });
    await companyWith(`someone-else-${randomUUID()}`);

    await expect(accessService(db).countActiveOwnedCompanies(userId)).resolves.toBe(2);
  });

  it("returns 0 for a user with no companies", async () => {
    await expect(accessService(db).countActiveOwnedCompanies(`user-${randomUUID()}`)).resolves.toBe(0);
  });
});

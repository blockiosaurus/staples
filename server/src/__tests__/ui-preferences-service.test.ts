import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyUserUiPreferences, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { uiPreferencesService } from "../services/ui-preferences.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ui preferences tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ui preferences service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ui-preferences-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Co ${prefix}`, issuePrefix: prefix });
    return id;
  }

  it("returns defaults without inserting a row", async () => {
    const companyId = await seedCompany("UIA");
    const prefs = await uiPreferencesService(db).get(companyId, "user-1");
    expect(prefs).toEqual({ pinned: [], hidden: [], revealed: {}, seen: {}, showEverything: false, updatedAt: null });
    expect(await db.select().from(companyUserUiPreferences)).toHaveLength(0);
  });

  it("merges sequential patches", async () => {
    const companyId = await seedCompany("UIB");
    const svc = uiPreferencesService(db);
    await svc.patch(companyId, "user-1", { pin: ["agents"] });
    const result = await svc.patch(companyId, "user-1", { hide: ["costs"], see: ["inbox"], showEverything: true });
    expect(result.pinned).toEqual(["agents"]);
    expect(result.hidden).toEqual(["costs"]);
    expect(Object.keys(result.seen)).toEqual(["inbox"]);
    expect(Object.keys(result.revealed)).toEqual(["inbox"]);
    expect(result.showEverything).toBe(true);
    expect(result.updatedAt).toEqual(expect.any(String));
    expect(await svc.get(companyId, "user-1")).toEqual(result);
    expect(await db.select().from(companyUserUiPreferences)).toHaveLength(1);
  });

  it("keeps users independent", async () => {
    const companyId = await seedCompany("UIC");
    const svc = uiPreferencesService(db);
    await svc.patch(companyId, "user-1", { pin: ["agents"] });
    expect((await svc.get(companyId, "user-2")).pinned).toEqual([]);
  });

  it("cascades when the company is deleted", async () => {
    const companyId = await seedCompany("UID");
    await uiPreferencesService(db).patch(companyId, "user-1", { pin: ["agents"] });
    await db.delete(companies);
    expect(await db.select().from(companyUserUiPreferences)).toHaveLength(0);
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, heartbeatRuns, issueAttachments, issueComments, issueWorkProducts, issues } from "@paperclipai/db";
import { listFontPairings } from "@paperclipai/brand-kit";
import { BRAND_STARTER_ORIGIN_KIND } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { brandStarterService } from "../services/brand-starter.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("brand starter service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root = "";
  let storage: ReturnType<typeof createStorageService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-brand-starter-");
    db = createDb(tempDb.connectionString);
    root = await mkdtemp(join(tmpdir(), "brand-starter-"));
    storage = createStorageService(createLocalDiskStorageProvider(root));
  }, 120_000);
  afterAll(async () => {
    await tempDb?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed(withDesigner = true) {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Brand Co ${nonce}`, issuePrefix: `BR${nonce.slice(0, 4).toUpperCase()}` }).returning();
    const userId = `user-${nonce}`;
    await db.insert(authUsers).values({ id: userId, name: "Pat", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    let designerId: string | null = null;
    if (withDesigner) {
      const [designer] = await db.insert(agents).values({
        companyId: company!.id, name: "Brand Designer", role: "designer", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, status: "idle",
        metadata: { paperclipBuiltInAgent: { key: "brand-designer", featureKeys: ["brand-designer"] } },
      }).returning();
      designerId = designer!.id;
    }
    return { companyId: company!.id, userId, designerId };
  }

  function spec() {
    return {
      businessName: "Maple Bakery",
      mood: "warm" as const,
      fontPairingId: listFontPairings()[0]!.id,
      concepts: [
        { kind: "geometric" as const, name: "Sun", shapes: [{ type: "circle" as const, cx: 32, cy: 32, r: 20, fill: "primary" as const }] },
        { kind: "monogram" as const, name: "Letter", letters: "MB", frame: "circle" as const },
        { kind: "wordmark" as const, name: "Word" },
      ],
    };
  }

  const wakeup = vi.fn(async () => undefined);
  const service = () => brandStarterService(db, storage, { heartbeat: { wakeup } });
  const agentActor = (agentId: string) => ({ actorType: "agent" as const, actorId: agentId, agentId, runId: null, agentApiKeyId: null });

  it("returns null without a brand designer and an empty status without an issue", async () => {
    const s = await seed(false);
    expect(await service().start(s.companyId, { description: "A bakery", userId: s.userId })).toBeNull();
    expect((await service().status(s.companyId)).issue).toBeNull();
  });

  it("never returns another company's brand starter", async () => {
    const a = await seed();
    const b = await seed();
    const svc = service();
    await svc.start(b.companyId, { description: "B cafe", userId: b.userId });
    expect((await svc.status(a.companyId)).issue).toBeNull();
    expect(await svc.findIssue(a.companyId)).toBeNull();
    expect((await svc.status(b.companyId)).issue).not.toBeNull();
  });

  it("starts once and assigns the designer", async () => {
    const s = await seed();
    const svc = service();
    const first = await svc.start(s.companyId, { description: "A bakery in Leeds", userId: s.userId });
    const second = await svc.start(s.companyId, { description: "A bakery in Leeds", userId: s.userId });
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const rows = await db.select().from(issues).where(and(eq(issues.companyId, s.companyId), eq(issues.originKind, BRAND_STARTER_ORIGIN_KIND)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assigneeAgentId).toBe(s.designerId);
    expect(rows[0]!.description).toContain("A bakery in Leeds");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(s.designerId, expect.objectContaining({ payload: expect.objectContaining({ issueId: first!.issueId }) }));
  });

  it("publishes 12 files, lists concepts, and is idempotent on re-publish", async () => {
    const s = await seed();
    const svc = service();
    const started = (await svc.start(s.companyId, { description: "A bakery", userId: s.userId }))!;
    await db.insert(issueComments).values({
      companyId: s.companyId, issueId: started.issueId, authorAgentId: s.designerId, authorType: "agent", body: "\nThree concepts ready.\nSecond line",
    });
    const publish = () => svc.publish(s.companyId, { issueId: started.issueId, spec: spec(), document: "# Brand starter", tagline: "Baked daily", actor: agentActor(s.designerId!) });
    const status = await publish();
    const count = async () => (await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, started.issueId))).length;
    expect(await count()).toBe(12);
    expect(status.concepts.map((c) => [c.index, c.name, c.kind])).toEqual([[1, "Sun", "geometric"], [2, "Letter", "monogram"], [3, "Word", "wordmark"]]);
    for (const c of status.concepts) {
      expect(c.markPath).toMatch(/^\/api\/attachments\/.+\/content$/);
      expect(c.lockupPath).toMatch(/^\/api\/attachments\//);
      expect(c.previewPath).toMatch(/^\/api\/attachments\//);
    }
    expect(status.documentPath).toBeTruthy();
    expect(status.palettePath).toBeTruthy();
    expect(status.tagline).toBe("Baked daily");
    expect(status.designerName).toBe("Brand Designer");
    expect(status.latestNote).toBe("Three concepts ready.");
    expect(status.issue?.id).toBe(started.issueId);

    const again = await publish();
    expect(await count()).toBe(12);
    expect(again.concepts).toHaveLength(3);
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "issue.brand_kit_published")));
    expect(logged).toHaveLength(2);
  });

  it("refuses an unrelated issue, another company's issue and a failing lint", async () => {
    const s = await seed();
    const other = await seed();
    const svc = service();
    const started = (await svc.start(s.companyId, { description: "A bakery", userId: s.userId }))!;
    const otherStarted = (await svc.start(other.companyId, { description: "A cafe", userId: other.userId }))!;
    const actor = agentActor(s.designerId!);
    await expect(svc.publish(s.companyId, { issueId: otherStarted.issueId, spec: spec(), document: "x", actor })).rejects.toMatchObject({ status: 404 });
    const [plain] = await db.insert(issues).values({ companyId: s.companyId, title: "Other", status: "todo", priority: "medium" }).returning();
    await expect(svc.publish(s.companyId, { issueId: plain!.id, spec: spec(), document: "x", actor })).rejects.toMatchObject({ status: 422 });
    const bad = spec();
    bad.concepts[1] = { kind: "monogram", name: "Bad", letters: "\u{1F600}", frame: "circle" };
    await expect(svc.publish(s.companyId, { issueId: started.issueId, spec: bad, document: "x", actor })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, started.issueId))).toHaveLength(0);
  });

  it("replaces artifact work products when re-publishing with a registered run", async () => {
    const s = await seed();
    const svc = service();
    const started = (await svc.start(s.companyId, { description: "A bakery", userId: s.userId }))!;
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.designerId!, status: "running" }).returning();
    const actor = { ...agentActor(s.designerId!), runId: run!.id };
    const publish = () => svc.publish(s.companyId, { issueId: started.issueId, spec: spec(), document: "# Brand", actor });
    await publish();
    const products = () => db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, started.issueId));
    expect((await products()).length).toBe(12);
    await publish();
    const after = await products();
    expect(after.length).toBe(12);
    expect(after.filter((p) => String(p.title).endsWith("-lockup.svg"))).toHaveLength(3);
    const live = new Set((await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, started.issueId))).map((a) => a.id));
    expect(after.every((p) => p.externalId && live.has(p.externalId))).toBe(true);
  });
});

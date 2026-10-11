import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyDocuments, createDb, documentRevisions, issues } from "@paperclipai/db";
import { COMPANY_BRIEF_MAX_CHARS, COMPANY_BRIEF_WAKE_EXCERPT_CHARS } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyBriefService } from "../services/company-brief.js";
import { companySignalsService } from "../services/company-signals.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { companyBriefRoutes } from "../routes/company-brief.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres company brief tests: ${support.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("company brief", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-brief-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Acme", issuePrefix: `B${id.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return id;
  }

  const board = (companyId: string, role = "owner") => ({
    type: "board", userId: "user-1", source: "session", isInstanceAdmin: false,
    companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: role }],
  });

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    server.use("/api", companyBriefRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("creates, reads and revises the brief as a company document", async () => {
    const companyId = await company();
    const svc = companyBriefService(db);
    expect(await svc.get(companyId)).toBeNull();

    const created = await svc.update(companyId, { body: "# Mission\nShip it." }, { userId: "user-1" });
    const first = created.brief;
    expect(created.changed).toBe(true);
    expect(first).toMatchObject({ body: "# Mission\nShip it.", revisionNumber: 1 });
    expect(typeof first.revisionId).toBe("string");
    expect(await svc.get(companyId)).toEqual(first);

    const { brief: second } = await svc.update(companyId, { body: "# Mission\nShip it well.", baseRevisionId: first.revisionId }, { userId: "user-1" });
    expect(second.revisionNumber).toBe(2);
    expect(second.revisionId).not.toBe(first.revisionId);

    // Saving the same body again is a no-op, not a new revision.
    const same = await svc.update(companyId, { body: "# Mission\nShip it well.", baseRevisionId: second.revisionId }, { userId: "user-1" });
    expect(same).toMatchObject({ changed: false, brief: { revisionId: second.revisionId } });

    const [link] = await db.select().from(companyDocuments).where(eq(companyDocuments.companyId, companyId));
    expect(link).toMatchObject({ key: "brief" });
    const revisions = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, link!.documentId));
    expect(revisions.map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
  });

  it("never lets a writer without the current revision overwrite an existing brief", async () => {
    const companyId = await company();
    const svc = companyBriefService(db);
    // Two people open the empty brief page; both save without a base revision.
    await svc.update(companyId, { body: "Alice's brief" }, { userId: "alice" });
    await expect(svc.update(companyId, { body: "Bob's brief" }, { userId: "bob" })).rejects.toMatchObject({ status: 409 });
    await expect(svc.update(companyId, { body: "Bob's brief", baseRevisionId: null }, { userId: "bob" })).rejects.toMatchObject({ status: 409 });
    expect((await svc.get(companyId))?.body).toBe("Alice's brief");

    const owner = app(board(companyId));
    const res = await request(owner).put(`/api/companies/${companyId}/brief`).send({ body: "Carol's brief" });
    expect(res.status).toBe(409);
    expect((await svc.get(companyId))?.body).toBe("Alice's brief");
  });

  it("serves GET/PUT over the API with conflict, viewer and cross-company checks", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const owner = app(board(companyId));

    const empty = await request(owner).get(`/api/companies/${companyId}/brief`);
    expect(empty.status).toBe(200);
    expect(empty.body).toBeNull();

    const created = await request(owner).put(`/api/companies/${companyId}/brief`).send({ body: "Glossary: TPS = report" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ body: "Glossary: TPS = report", revisionNumber: 1 });
    expect(typeof created.body.updatedAt).toBe("string");

    const read = await request(owner).get(`/api/companies/${companyId}/brief`);
    expect(read.body).toEqual(created.body);

    const updated = await request(owner).put(`/api/companies/${companyId}/brief`)
      .send({ body: "Glossary v2", baseRevisionId: created.body.revisionId });
    expect(updated.status).toBe(200);
    // A no-op save returns the brief but logs nothing.
    const noop = await request(owner).put(`/api/companies/${companyId}/brief`)
      .send({ body: "Glossary v2", baseRevisionId: updated.body.revisionId });
    expect(noop.status).toBe(200);
    expect(noop.body.revisionId).toBe(updated.body.revisionId);

    const stale = await request(owner).put(`/api/companies/${companyId}/brief`)
      .send({ body: "Stale edit", baseRevisionId: created.body.revisionId });
    expect(stale.status).toBe(409);
    expect((await request(owner).get(`/api/companies/${companyId}/brief`)).body.body).toBe("Glossary v2");

    const viewer = app(board(companyId, "viewer"));
    expect((await request(viewer).get(`/api/companies/${companyId}/brief`)).status).toBe(200);
    expect((await request(viewer).put(`/api/companies/${companyId}/brief`).send({ body: "nope" })).status).toBe(403);

    expect((await request(owner).get(`/api/companies/${otherCompanyId}/brief`)).status).toBe(403);
    expect((await request(owner).put(`/api/companies/${otherCompanyId}/brief`).send({ body: "x" })).status).toBe(403);

    const agent = app({ type: "agent", agentId: randomUUID(), companyId, source: "agent_key" });
    expect((await request(agent).get(`/api/companies/${companyId}/brief`)).body.body).toBe("Glossary v2");
    expect((await request(agent).put(`/api/companies/${companyId}/brief`).send({ body: "agent edit" })).status).toBe(403);

    const tooLong = await request(owner).put(`/api/companies/${companyId}/brief`).send({ body: "x".repeat(COMPANY_BRIEF_MAX_CHARS + 1) });
    expect(tooLong.status).toBe(400);
    expect((await request(owner).get("/api/companies/not-a-uuid/brief")).status).toBe(400);

    const activity = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.brief_updated")));
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: "user-1", entityType: "company", entityId: companyId });
  });

  it("reports hasBrief in company signals only for a non-blank brief", async () => {
    const companyId = await company();
    expect((await companySignalsService(db).get(companyId)).hasBrief).toBe(false);
    await companyBriefService(db).update(companyId, { body: "   \n" }, { userId: "user-1" });
    expect((await companySignalsService(db).get(companyId)).hasBrief).toBe(false);
    const blank = await companyBriefService(db).get(companyId);
    await companyBriefService(db).update(companyId, { body: "Mission", baseRevisionId: blank!.revisionId }, { userId: "user-1" });
    expect((await companySignalsService(db).get(companyId)).hasBrief).toBe(true);
  });

  it("injects a capped brief into every agent's wake payload and prompt", async () => {
    const companyId = await company();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Do the thing", status: "todo" });
    const wake = () => buildPaperclipWakePayload({
      db, companyId, agentId: randomUUID(), contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const none = await wake();
    expect(none?.companyBrief).toBeNull();
    expect(renderPaperclipWakePrompt(none, {})).not.toContain("## Company brief");

    const { brief } = await companyBriefService(db).update(companyId, { body: "We sell staplers. TPS = report." }, { userId: "user-1" });
    const small = await wake();
    expect(small?.companyBrief).toEqual({
      body: "We sell staplers. TPS = report.", truncated: false, revisionId: brief.revisionId, revisionNumber: 1, companyId,
    });
    const prompt = renderPaperclipWakePrompt(small, {});
    expect(prompt).toContain("## Company brief");
    expect(prompt).toContain("We sell staplers. TPS = report.");

    const long = "a".repeat(COMPANY_BRIEF_WAKE_EXCERPT_CHARS) + "TAIL";
    await companyBriefService(db).update(companyId, { body: long, baseRevisionId: brief.revisionId }, { userId: "user-1" });
    const big = await wake();
    expect(big?.companyBrief?.truncated).toBe(true);
    expect(big?.companyBrief?.body).toHaveLength(COMPANY_BRIEF_WAKE_EXCERPT_CHARS);
    const bigPrompt = renderPaperclipWakePrompt(big, {});
    expect(bigPrompt).not.toContain("TAIL");
    expect(bigPrompt).toContain(`(truncated — read the full brief at /company/brief or GET /api/companies/${companyId}/brief)`);
  });
});

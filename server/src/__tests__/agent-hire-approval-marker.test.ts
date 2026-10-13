import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, createDb } from "@paperclipai/db";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { approvalService } from "../services/approvals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire approval activation hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-hire-approval-marker");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 60_000);
  afterAll(async () => { await cleanup?.(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Hire hardening", issuePrefix: `HH${id.slice(0, 6).toUpperCase()}` });
    return id;
  }
  async function pendingHire(companyId: string) {
    return createAgentLifecycle(db).requestHire(companyId, {
      name: `Pending ${randomUUID().slice(0, 6)}`, status: "pending_approval", role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    });
  }
  async function hireApproval(companyId: string, payload: Record<string, unknown>) {
    const [row] = await db.insert(approvals).values({ companyId, type: "hire_agent", status: "pending", requestedByUserId: "requester", payload }).returning();
    return row!;
  }

  it("refuses a hire approval payload that would write a built-in marker", async () => {
    const companyId = await company();
    const pending = await pendingHire(companyId);
    for (const marker of [{ key: "assistant", featureKeys: ["assistant"] }, { key: "assistant" }]) {
      const approval = await hireApproval(companyId, { agentId: pending.id, name: pending.name, metadata: { paperclipBuiltInAgent: marker } });
      await expect(approvalService(db).approve(approval.id, "board-user"))
        .rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });
      const [agent] = await db.select().from(agents).where(eq(agents.id, pending.id));
      expect(agent).toMatchObject({ status: "pending_approval" });
      expect((agent!.metadata ?? {}) as Record<string, unknown>).not.toHaveProperty("paperclipBuiltInAgent");
      const [stillPending] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(stillPending!.status).toBe("pending");
    }
  });

  it("refuses to activate an agent from another company", async () => {
    const companyA = await company();
    const companyB = await company();
    const foreign = await pendingHire(companyB);
    const approval = await hireApproval(companyA, { agentId: foreign.id, name: "Foreign" });
    await expect(approvalService(db).approve(approval.id, "board-user")).rejects.toMatchObject({ status: 422 });
    const [agent] = await db.select().from(agents).where(eq(agents.id, foreign.id));
    expect(agent).toMatchObject({ status: "pending_approval", companyId: companyB });
    const rejectApproval = await hireApproval(companyA, { agentId: foreign.id, name: "Foreign" });
    await expect(approvalService(db).reject(rejectApproval.id, "board-user")).rejects.toMatchObject({ status: 422 });
    expect((await db.select().from(agents).where(eq(agents.id, foreign.id)))[0]).toMatchObject({ status: "pending_approval" });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  configureSelfServePolicy,
  resetSelfServePolicy,
  SELF_SERVE_RUN_REFUSED_ERROR_CODE,
} from "../services/self-serve-policy.js";
import { accessService } from "../services/access.js";
import { approvalService } from "../services/approvals.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { onboardingSeedService } from "../services/onboarding-seed.js";
import { heartbeatService } from "../services/heartbeat.js";

/**
 * The self-serve floor at the layers every path converges on: agent record
 * creation, approvals, built-in provisioning, onboarding seed, the heartbeat
 * runtime backstop, and the per-user creation lock under a small pool.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping self-serve floor DB tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("self-serve floor (database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-serve-floor-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
    vi.stubEnv("STAPLES_HOSTED_ANTHROPIC_API_KEY", "sk-ant-test-self-serve-floor");
    vi.stubEnv("STAPLES_HOSTED_INFERENCE", "");
  });

  afterEach(async () => {
    resetSelfServePolicy();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany(selfServe: boolean, createdBy: string | null = null, status = "active") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Floor ${id.slice(0, 6)}`,
      status,
      issuePrefix: `F${id.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      selfServe,
      selfServeCreatedByUserId: createdBy,
    });
    return id;
  }

  async function agentsIn(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  it("refuses a direct process hire approval when filed and when approved", async () => {
    const companyId = await insertCompany(true, "u1");
    const payload = { name: "Shell", role: "engineer", adapterType: "process", adapterConfig: { command: "sh", args: ["-c", "id"] } };

    await expect(approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByUserId: "u1",
      status: "pending",
      payload,
    } as never)).rejects.toMatchObject({ status: 403 });

    // An approval row that predates the floor (or was written directly) still
    // cannot produce the agent on approve.
    const [row] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      requestedByUserId: "u1",
      status: "pending",
      payload,
    }).returning();
    await expect(approvalService(db).approve(row!.id, "u1")).rejects.toMatchObject({ status: 403 });
    expect(await agentsIn(companyId)).toHaveLength(0);
  });

  it("refuses a claude_managed apiBaseUrl override at record creation", async () => {
    const companyId = await insertCompany(true, "u1");
    await expect(createAgentLifecycle(db).requestHire(companyId, {
      name: "Remote",
      role: "engineer",
      adapterType: "claude_managed",
      adapterConfig: { apiBaseUrl: "http://169.254.169.254/latest" },
      runtimeConfig: {},
      permissions: {},
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    } as never)).rejects.toMatchObject({ status: 403 });
    expect(await agentsIn(companyId)).toHaveLength(0);
  });

  it("refuses built-in provisioning on claude_local in a self-serve company", async () => {
    const companyId = await insertCompany(true, "u1");
    await expect(builtInAgentService(db).provision(companyId, "summarizer", { adapterType: "claude_local" }))
      .rejects.toMatchObject({ status: 403 });
    expect((await agentsIn(companyId)).some((agent) => agent.adapterType === "claude_local")).toBe(false);
  });

  it("provisions the Assistant on Claude (hosted) and never a local CLI", async () => {
    const companyId = await insertCompany(true, "u1");
    await builtInAgentService(db).autoProvisionBundledAgents(companyId);
    const rows = await agentsIn(companyId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((agent) => agent.adapterType === "claude_managed")).toBe(true);
  });

  it("keeps admin-created companies on their normal adapters", async () => {
    const companyId = await insertCompany(false);
    const created = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Local",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    } as never);
    expect(created.adapterType).toBe("claude_local");
  });

  it("seeds a self-serve company's first agent on claude_managed", async () => {
    const companyId = await insertCompany(true, "u1");
    const result = await onboardingSeedService(db).apply(companyId, {
      revision: "r1",
      agent: { name: "Lead", role: "CEO" },
    }, { actorType: "user", actorId: "u1" });
    const [seeded] = await db.select().from(agents).where(eq(agents.id, result.agentId!));
    expect(seeded?.adapterType).toBe("claude_managed");
  });

  it("fails a run for a local agent written straight into a self-serve company", async () => {
    const companyId = await insertCompany(true, "u1");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Smuggled",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { command: "sh" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test",
      requestedByActorType: "user",
      requestedByActorId: "u1",
    });

    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.some((run) => run.status === "failed" && run.errorCode === SELF_SERVE_RUN_REFUSED_ERROR_CODE)).toBe(true);
    }, { timeout: 15_000, interval: 250 });

    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }, 30_000);

  it("counts self-serve companies by creator, archived ones only for creation", async () => {
    const userId = `u-${randomUUID()}`;
    const active = await insertCompany(true, userId);
    await insertCompany(true, userId, "archived");
    await insertCompany(false, userId);
    await insertCompany(true, `other-${randomUUID()}`);
    const svc = accessService(db);

    await expect(svc.countSelfServeCompaniesCreatedBy(userId, { includeArchived: true })).resolves.toBe(2);
    await expect(svc.countSelfServeCompaniesCreatedBy(userId, { includeArchived: false })).resolves.toBe(1);
    await expect(svc.countSelfServeCompaniesCreatedBy(userId, { includeArchived: false, excludeCompanyId: active })).resolves.toBe(0);
  });

  it("does not stall a small pool under concurrent creates, and refuses same-user contention with 409", async () => {
    const small = createDb(tempDb!.connectionString, { maxConnections: 2 });
    const svc = accessService(small);
    const createFor = (userId: string) => svc.withSelfServeCompanyLock(userId, async (tx, count) => {
      const before = await count();
      if (before >= 1) return "limit";
      const id = randomUUID();
      await tx.insert(companies).values({
        id,
        name: `Lock ${id.slice(0, 6)}`,
        issuePrefix: `L${id.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
        selfServe: true,
        selfServeCreatedByUserId: userId,
      });
      await tx.insert(companyMemberships).values({
        companyId: id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
      });
      // Hold the lock a little so concurrent requests overlap.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "created";
    }).catch((error: { status?: number }) => (error.status === 409 ? "busy" : Promise.reject(error)));

    const sameUser = `same-${randomUUID()}`;
    const sameResults = await Promise.all(Array.from({ length: 10 }, () => createFor(sameUser)));
    expect(sameResults.filter((result) => result === "created")).toHaveLength(1);
    expect(sameResults.every((result) => ["created", "busy", "limit"].includes(result))).toBe(true);

    const manyUsers = Array.from({ length: 8 }, () => `many-${randomUUID()}`);
    const manyResults = await Promise.all(manyUsers.map(createFor));
    expect(manyResults.every((result) => result === "created")).toBe(true);
  }, 30_000);
});

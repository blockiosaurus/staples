import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  boardApiKeys,
  builtInManagedResources,
  heartbeatRuns,
} from "@paperclipai/db";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { BUILT_IN_AGENT_METADATA_KEY } from "../lib/built-in-agent-metadata.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDbState(input: {
  agent: { id: string; companyId: string; status?: string; metadata?: Record<string, unknown> | null };
  /** The company's Assistant provisioning record binds this agent id. */
  assistantBindingAgentId?: string;
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null };
  run?: { id: string; companyId: string; agentId: string; responsibleUserId?: string | null;
    status?: string; contextSnapshot?: Record<string, unknown>; resultJson?: Record<string, unknown> };
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
    metadata: input.agent.metadata ?? null,
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
        status: input.run.status ?? "running",
        contextSnapshot: input.run.contextSnapshot ?? {},
        resultJson: input.run.resultJson ?? {},
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        if (table === builtInManagedResources) {
          return input.assistantBindingAgentId ? [{ agentId: input.assistantBindingAgentId }] : [];
        }
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.post("/api/routine-triggers/public/:publicId/fire", (req, res) => {
    res.json({ reachedWebhook: true, actorType: req.actor.type });
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayProtocol: true, actorType: req.actor.type });
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, writable: true });
  });
  app.get("/api/issues/:issueId", (req, res) => res.json({ id: req.params.issueId, readable: true }));
  app.post("/api/issues/:issueId/comments", (req, res) => res.status(201).json({ commented: true }));
  app.patch("/api/issues/:issueId", (req, res) => res.json({ updated: true }));
  app.post("/api/mcp/assistant-tools", (req, res) => res.json({ reachedAssistantTools: true }));
  app.post("/api/mcp/paperclip-tools", (req, res) => res.json({ reachedPaperclipTools: true }));
  app.use(errorHandler);
  return app;
}

const ASSISTANT_METADATA = { [BUILT_IN_AGENT_METADATA_KEY]: { key: ASSISTANT_BUILT_IN_AGENT_KEY, featureKeys: [] } };

function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
  expiresInSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + (input.expiresInSeconds ?? 3600),
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent auth middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "auth-middleware-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    // Pin the control-plane instance so mint/verify (and the hand-crafted
    // legacy token helper) all derive keys under the "default" live instance.
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it.each([
    { status: "cancelled", conversationMode: false, requested: false },
    { status: "running", conversationMode: false, requested: true },
    { status: "cancelled", conversationMode: true, requested: false },
    { status: "running", conversationMode: true, requested: true },
  ])("revokes writes but preserves reads for a stopped run: %j", async ({ status, conversationMode, requested }) => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId }, run: {
      id: runId, companyId, agentId, status, contextSnapshot: { conversationMode },
      resultJson: requested ? { executionCancellation: { state: "requested" } } : {},
    } });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, null);
    const client = createApp(db);
    const endpoint = `/companies/${companyId}/issues/${randomUUID()}`;
    const write = await request(client).patch(endpoint).set("Authorization", `Bearer ${token}`).send({ status: "done" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe(conversationMode ? "conversation_turn_cancelled" : "agent_run_cancelled");
    const read = await request(client).get(endpoint).set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.readable).toBe(true);
  });

  describe("provisioned Assistant run token", () => {
    function assistantClient(input: { provisioned: boolean; marked?: boolean; via?: "run_jwt" | "api_key" }) {
      const agentId = randomUUID();
      const companyId = randomUUID();
      const runId = randomUUID();
      const apiKey = `pcp_${randomUUID()}`;
      const { db } = createDbState({
        agent: { id: agentId, companyId, metadata: input.marked === false ? null : ASSISTANT_METADATA },
        assistantBindingAgentId: input.provisioned ? agentId : undefined,
        run: { id: runId, companyId, agentId },
        ...(input.via === "api_key"
          ? { agentKey: { id: randomUUID(), agentId, companyId, keyHash: hashToken(apiKey), responsibleUserId: "user-1" } }
          : {}),
      });
      const token = input.via === "api_key" ? apiKey : createLocalAgentJwt(agentId, companyId, "claude_local", runId, null);
      return { client: createApp(db), auth: `Bearer ${token}` };
    }

    it("refuses writes from an API key of the Assistant's agent but keeps reads", async () => {
      const { client, auth } = assistantClient({ provisioned: true, via: "api_key" });
      const issueId = randomUUID();
      const comment = await request(client).post(`/api/issues/${issueId}/comments`).set("Authorization", auth).send({ body: "hi" });
      expect(comment.status).toBe(403);
      expect(comment.body.code).toBe("assistant_read_only");
      const patch = await request(client).patch(`/api/issues/${issueId}`).set("Authorization", auth).send({ status: "done" });
      expect(patch.status).toBe(403);
      const read = await request(client).get(`/api/issues/${issueId}`).set("Authorization", auth);
      expect(read.status).toBe(200);
    });

    it("leaves writes from another agent's API key unchanged", async () => {
      const { client, auth } = assistantClient({ provisioned: false, marked: false, via: "api_key" });
      const comment = await request(client).post(`/api/issues/${randomUUID()}/comments`).set("Authorization", auth).send({ body: "hi" });
      expect(comment.status).toBe(201);
    });

    it("cannot comment on or update a task", async () => {
      const { client, auth } = assistantClient({ provisioned: true });
      const issueId = randomUUID();
      const comment = await request(client).post(`/api/issues/${issueId}/comments`).set("Authorization", auth).send({ body: "hi" });
      expect(comment.status).toBe(403);
      expect(comment.body).toEqual({
        error: "The Assistant cannot make changes directly. Propose the change for a person to confirm.",
        code: "assistant_read_only",
      });
      const patch = await request(client).patch(`/api/issues/${issueId}`).set("Authorization", auth).send({ status: "done" });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe("assistant_read_only");
      // Case and trailing-slash variants route to the same handlers.
      const variant = await request(client).post(`/API/Issues/${issueId}/comments/`).set("Authorization", auth).send({ body: "hi" });
      expect(variant.status).toBe(403);
    });

    it("still reads and reaches its MCP tool servers", async () => {
      const { client, auth } = assistantClient({ provisioned: true });
      const read = await request(client).get(`/api/issues/${randomUUID()}`).set("Authorization", auth);
      expect(read.status).toBe(200);
      expect(read.body.readable).toBe(true);
      const tools = await request(client).post("/api/mcp/assistant-tools").set("Authorization", auth)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "staples_save_weekly_update" } });
      expect(tools.status).toBe(200);
      expect(tools.body.reachedAssistantTools).toBe(true);
      const paperclip = await request(client).post("/api/mcp/paperclip-tools/").set("Authorization", auth)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(paperclip.status).toBe(200);
      expect(paperclip.body.reachedPaperclipTools).toBe(true);
    });

    it("does not allow other methods on the allowlisted paths", async () => {
      const { client, auth } = assistantClient({ provisioned: true });
      const res = await request(client).delete("/api/mcp/assistant-tools").set("Authorization", auth);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("assistant_read_only");
    });

    it.each([
      { name: "an ordinary agent", provisioned: false, marked: false },
      { name: "an agent that only carries the Assistant marker", provisioned: false, marked: true },
    ])("leaves writes from $name unchanged", async ({ provisioned, marked }) => {
      const { client, auth } = assistantClient({ provisioned, marked });
      const issueId = randomUUID();
      const comment = await request(client).post(`/api/issues/${issueId}/comments`).set("Authorization", auth).send({ body: "hi" });
      expect(comment.status).toBe(201);
      const patch = await request(client).patch(`/api/issues/${issueId}`).set("Authorization", auth).send({ status: "done" });
      expect(patch.status).toBe(200);
      expect(patch.body.updated).toBe(true);
    });
  });

  it("keeps header-less local requests as the implicit board actor with their run id", async () => {
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", userId: "local-board", runId });
  });

  it.each([
    ["empty bearer token", "Bearer   ", "Empty bearer token"],
    ["unverified token", "Bearer not-a-token", "Agent token did not verify"],
  ])("rejects %s instead of retaining the implicit local-board actor", async (_label, authorization, error) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    let commentWrites = 0;
    const app = createApp(db, "local_trusted");
    app.post("/comments", (_req, res) => {
      commentWrites += 1;
      res.status(201).json({ ok: true });
    });

    const res = await request(app).post("/comments").set("Authorization", authorization).send({ body: "reply" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
    expect(commentWrites).toBe(0);
  });

  it.each(["authenticated", "local_trusted"] as const)(
    "leaves webhook authentication to the trigger in %s mode",
    async (deploymentMode) => {
      const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
      const res = await request(createApp(db, deploymentMode))
        .post(`/api/routine-triggers/public/${"a".repeat(24)}/fire`)
        .set("Authorization", "Bearer routine-secret")
        .send({ event: "created" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reachedWebhook: true, actorType: "none" });
    },
  );

  it.each([
    `/api/routine-triggers/public/${"a".repeat(24)}/rotate-secret`,
    "/api/routine-triggers/public/not-a-public-id/fire",
    `/api/routine-triggers/public/${"a".repeat(24)}/fire/extra`,
  ])("does not bypass actor authentication for %s", async (path) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const res = await request(createApp(db)).post(path).set("Authorization", "Bearer routine-secret");
    expect(res.status).toBe(401);
  });

  it("leaves public MCP gateway bearers for the gateway protocol to validate", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const publicId = `gw_${"a".repeat(32)}`;

    const res = await request(createApp(db, "local_trusted"))
      .post(`/mcp/gateways/${publicId}`)
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayProtocol: true });
  });

  it("does not bypass actor authentication for lookalike MCP gateway paths", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .post("/mcp/gateways/not-a-public-id")
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });

  it.each([
    ["terminated", "Agent is terminated"],
    ["pending_approval", "Agent is pending approval"],
  ])("rejects a %s agent JWT instead of retaining local-board", async (status, error) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId, status } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
  });

  it("rejects an agent JWT when the agent record belongs to another company", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId: randomUUID() } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("reports an expired agent JWT specifically", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
      expiresInSeconds: -1,
    });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Expired agent token");
  });

  it("uses the signed responsible_user_id claim and keeps the signed run id authoritative", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-row" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      onBehalfOfUserId: "user-claim",
      source: "agent_jwt",
    });
  });

  it("preserves signed skill_test JWT scope on the request actor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim", {
      kind: "skill_test",
      issueId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      keyScope: { kind: "skill_test", issueId },
      source: "agent_jwt",
    });
  });

  it("rejects mismatched run headers for agent JWTs and audits the spoof attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      details: { claimRunId: runId, headerRunId: spoofedRunId },
    });
  });

  it("falls back to the run row responsible user for legacy claim-less agent JWTs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-legacy" },
    });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      runId,
      onBehalfOfUserId: "user-legacy",
      source: "agent_jwt",
    });
  });

  it("rejects fork-minted run JWTs before issue reads or writes reach live issue data", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });

    process.env.PAPERCLIP_INSTANCE_ID = "pap-12899-worktree";
    const forkToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    expect(forkToken).not.toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const app = createApp(db);
    const readRes = await request(app)
      .get(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId);
    const writeRes = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "should not write" });

    expect(readRes.status).toBe(401);
    expect(writeRes.status).toBe(401);
  });

  it("populates agent-key actors from the key responsible user binding", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: "user-key",
      source: "agent_key",
    });
  });

  it("rejects agent keys that lack a responsible user binding and audits the denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = "pcp_test_agent_key_without_user";
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: keyId,
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: null,
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: keyId,
      details: { method: "GET", url: `/companies/${companyId}/protected` },
    });
  });
});

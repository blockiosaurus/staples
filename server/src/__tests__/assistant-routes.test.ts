import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const assistantId = "11111111-1111-4111-8111-111111111111";

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureAssistant: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getConversation: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/built-in-agents.js", () => ({
    builtInAgentService: () => mockBuiltInAgentService,
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
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
  beforeEach(() => {
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
  });

  it("ensures the Assistant and returns it with no conversation yet", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agent: { id: assistantId, name: "Assistant", urlKey: "assistant", adapterType: "claude_local", status: "idle" },
      conversationIssueId: null,
    });
    expect(mockBuiltInAgentService.ensureAssistant).toHaveBeenCalledWith(companyId);
    expect(mockIssueService.getConversation).toHaveBeenCalledWith(companyId, assistantId, "user-1");
  });

  it("returns the caller's existing conversation issue id", async () => {
    mockIssueService.getConversation.mockResolvedValue({ id: "issue-1" });
    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/assistant`);
    expect(res.status).toBe(200);
    expect(res.body.conversationIssueId).toBe("issue-1");
  });

  it("rejects agents and callers without company access", async () => {
    const agentApp = await createApp({ type: "agent", agentId: "agent-1", companyId, source: "agent_key" });
    expect((await request(agentApp).get(`/api/companies/${companyId}/assistant`)).status).toBe(403);

    const boardApp = await createApp(boardActor);
    expect((await request(boardApp).get(`/api/companies/${otherCompanyId}/assistant`)).status).toBe(403);
    expect(mockBuiltInAgentService.ensureAssistant).not.toHaveBeenCalled();
  });
});

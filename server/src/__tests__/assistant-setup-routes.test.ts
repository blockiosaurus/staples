import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
}));

const mockAdapterPluginStore = vi.hoisted(() => ({
  getDisabledAdapterTypes: vi.fn<() => string[]>(() => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  getById: vi.fn(),
  listBindings: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  syncEnvBindingsForTarget: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null })),
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async (): Promise<{ enableNativeRunner: boolean; enableOpenAiDot?: boolean }> => ({ enableNativeRunner: false })),
}));

const mockManagedAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockRemoteAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockEnsureAssistant = vi.hoisted(() => vi.fn());
const mockLifecycle = vi.hoisted(() => ({ retry: vi.fn(), updateAndTransition: vi.fn() }));
const mockReadAssistantLifecycle = vi.hoisted(() => vi.fn());
const mockAdapterAvailability = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn(), ensureAssistant: mockEnsureAssistant }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/managed-agent-profiles.js", () => ({
  managedAgentProfileService: () => mockManagedAgentProfileService,
}));

vi.mock("../services/remote-agent-profiles.js", () => ({
  remoteAgentProfileService: () => mockRemoteAgentProfileService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn(), ensureAssistant: mockEnsureAssistant }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/agent-lifecycle.js", () => ({
    createAgentLifecycle: () => mockLifecycle,
  }));

  vi.doMock("../services/assistant-setup.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/assistant-setup.js")>()),
    readAssistantLifecycle: mockReadAssistantLifecycle,
    assistantAdapterAvailability: mockAdapterAvailability,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/managed-agent-profiles.js", () => ({
    managedAgentProfileService: () => mockManagedAgentProfileService,
  }));

  vi.doMock("../services/remote-agent-profiles.js", () => ({
    remoteAgentProfileService: () => mockRemoteAgentProfileService,
  }));

  // The adapter registry reads the disabled set from this store. Mock it so a
  // test can declare an adapter disabled without writing to the real
  // ~/.paperclip/adapter-settings.json.
  vi.doMock("../services/adapter-plugin-store.js", () => ({
    getDisabledAdapterTypes: mockAdapterPluginStore.getDisabledAdapterTypes,
    isAdapterDisabled: (type: string) =>
      mockAdapterPluginStore.getDisabledAdapterTypes().includes(type),
    listAdapterPlugins: () => [],
    getAdapterPluginByType: () => undefined,
    setAdapterDisabled: vi.fn(),
  }));
}

async function createApp(actorOverride: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverride,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const assistantId = "11111111-1111-4111-8111-111111111111";
const assistantRow = {
  id: assistantId,
  companyId: "company-1",
  name: "Assistant",
  urlKey: "assistant",
  role: "general",
  title: null,
  icon: null,
  status: "paused",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-4-6", instructionsBundleMode: "managed" },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  lifecycleState: "verifying",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const failedLifecycle = (codes: string[]) => ({
  adapterType: "claude_local", lifecycleState: "verifying", lifecycleVersion: 2,
  lifecycleError: "The lifecycle step failed. Retry the operation.", lifecycleHolds: [],
  lifecycleOperation: { id: "op", hostComplete: false, completedPluginIds: [], attempts: 1,
    lastHarnessTest: { version: 2, adapterType: "claude_local", checks: codes.map((code) => ({ code, level: "error" })) } },
});

const DUMMY_KEY = "sk-ant-test-dummy-key-0000";
let savedAnthropicKey: string | undefined;
let savedHostedFlag: string | undefined;

describe("POST /companies/:companyId/assistant/setup", () => {
  afterEach(() => {
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    if (savedHostedFlag === undefined) delete process.env.STAPLES_HOSTED_INFERENCE;
    else process.env.STAPLES_HOSTED_INFERENCE = savedHostedFlag;
  });

  beforeEach(() => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedHostedFlag = process.env.STAPLES_HOSTED_INFERENCE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.STAPLES_HOSTED_INFERENCE;
    mockSecretService.create.mockImplementation(async (_companyId: string, input: { name: string }) => ({
      id: "22222222-2222-4222-8222-222222222222", name: input.name, provider: "local_encrypted",
    }));
    mockSecretService.remove.mockResolvedValue(null);
    mockSecretService.getById.mockResolvedValue(null);
    mockSecretService.listBindings.mockResolvedValue([]);
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "test" });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    mockEnsureAssistant.mockResolvedValue(assistantRow);
    mockAgentService.getById.mockResolvedValue(assistantRow);
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...assistantRow, ...patch }));
    mockLifecycle.retry.mockResolvedValue(assistantRow);
    mockReadAssistantLifecycle.mockResolvedValue(failedLifecycle(["adapter_engine_unavailable"]));
  });

  it("updates the Assistant's adapter through the configuration path, picks the CLI engine, and retries the lifecycle", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup")
      .send({ adapterType: "claude_local", adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-1" } } } }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnsureAssistant).toHaveBeenCalledWith("company-1");
    const [id, patch, options] = mockAgentService.update.mock.calls.at(-1)!;
    expect(id).toBe(assistantId);
    expect(patch).toMatchObject({
      adapterType: "claude_local",
      adapterConfig: { engine: "cli", model: "claude-sonnet-4-6" },
    });
    expect(patch).not.toHaveProperty("runtimeConfig");
    expect(options).toMatchObject({ recordRevision: { createdByUserId: "local-board", source: "assistant_setup" } });
    expect(mockLifecycle.retry).toHaveBeenCalledWith(assistantId);
    expect(res.body).toMatchObject({ agent: { id: assistantId }, setup: { adapterType: "claude_local" } });
  }, 60_000);

  it("binds an AI connection through the PATCH binding checks", async () => {
    const app = await createApp();
    // An OpenAI connection cannot drive claude_local: the shared compatibility check rejects it.
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup")
      .send({ adapterType: "claude_local", aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("switches to another runtime adapter and keeps an explicit engine", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup")
      .send({ adapterType: "codex_local", adapterConfig: { engine: "acp", model: "gpt-5.4" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, any>;
    expect(patch.adapterType).toBe("codex_local");
    expect(patch.adapterConfig).toMatchObject({ engine: "acp", model: "gpt-5.4" });
  });

  it("rejects adapters the Assistant cannot run on and unknown config keys", async () => {
    const app = await createApp();
    const wrongAdapter = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "process" }));
    expect(wrongAdapter.status).toBe(400);
    const extraKey = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local", adapterConfig: { command: "/bin/sh" } }));
    expect(extraKey.status).toBe(400);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("does not retry the lifecycle once the Assistant is ready", async () => {
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...assistantRow, ...patch, lifecycleState: "ready", status: "idle" }));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLifecycle.retry).not.toHaveBeenCalled();
  });

  it("checks access before validating the body", async () => {
    const viewer = await createApp({
      source: "session", userId: "viewer-1", companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const res = await requestApp(viewer, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "process", junk: true }));
    expect(res.status).toBe(403);
    expect(mockEnsureAssistant).not.toHaveBeenCalled();
  });

  it("lists the runtime adapters from cheap host detection, for people who can configure", async () => {
    const entries = [{ adapterType: "claude_local", installed: true, available: true, engine: "cli", signedIn: null }];
    mockAdapterAvailability.mockResolvedValue(entries);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/assistant/adapters"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ adapters: entries });
    const deps = mockAdapterAvailability.mock.calls.at(-1)![0];
    expect(typeof deps.commandResolvable).toBe("function");
    expect(deps.nodeVersion).toBe(process.version);

    const viewer = await createApp({
      source: "session", userId: "viewer-1", companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const viewerRes = await requestApp(viewer, (baseUrl) => request(baseUrl).get("/api/companies/company-1/assistant/adapters"));
    expect(viewerRes.status).toBe(403);
  });

  it("stores a person's Anthropic key as a company secret bound by reference, never echoing it", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup")
      .send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.create).toHaveBeenCalledTimes(1);
    const [secretCompanyId, secretInput] = mockSecretService.create.mock.calls[0]!;
    expect(secretCompanyId).toBe("company-1");
    expect(secretInput).toMatchObject({ value: DUMMY_KEY, key: expect.stringMatching(/^ANTHROPIC_API_KEY\.assistant-setup\./) });
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, any>;
    expect(patch.adapterType).toBe("claude_managed");
    expect(patch.adapterConfig.model).toBe("claude-opus-5-5");
    expect(patch.adapterConfig.env.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest",
    });
    expect(JSON.stringify(patch)).not.toContain(DUMMY_KEY);
    expect(JSON.stringify(res.body)).not.toContain(DUMMY_KEY);
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain(DUMMY_KEY);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "secret.created", entityType: "secret" }));
  }, 60_000);

  it("connects Claude (hosted) without a key when the server has hosted inference", async () => {
    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup")
      .send({ adapterType: "claude_managed", model: "claude-sonnet-5-5" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.create).not.toHaveBeenCalled();
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, any>;
    expect(patch.adapterType).toBe("claude_managed");
    expect(patch.adapterConfig.model).toBe("claude-sonnet-5-5");
    expect(JSON.stringify(patch)).not.toContain(DUMMY_KEY);
  });

  it("asks for a key when there is no hosted inference and none is bound", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed" }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Add an Anthropic API key to use Claude (hosted).");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses a key for other adapters without echoing it", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local", apiKey: DUMMY_KEY }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(DUMMY_KEY);
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("removes the stored key secret when the save is refused", async () => {
    mockAgentService.update.mockRejectedValue(new Error("save failed"));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(res.status).toBe(500);
    expect(mockSecretService.remove).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(res.body)).not.toContain(DUMMY_KEY);
  });

  it("binds an existing company secret only after checking it belongs to the company", async () => {
    const secretId = "33333333-3333-4333-8333-333333333333";
    mockSecretService.getById.mockResolvedValue({ id: secretId, companyId: "company-2", key: "OTHER" });
    const app = await createApp();
    const foreign = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKeySecretId: secretId }));
    expect(foreign.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();

    mockSecretService.getById.mockResolvedValue({ id: secretId, companyId: "company-1", key: "MY_ANTHROPIC" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKeySecretId: secretId }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.create).not.toHaveBeenCalled();
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, any>;
    expect(patch.adapterConfig.env.ANTHROPIC_API_KEY).toEqual({ type: "secret_ref", secretId, version: "latest" });
  });

  it("deletes the key secret an earlier setup created once a new key replaces it", async () => {
    const oldId = "44444444-4444-4444-8444-444444444444";
    const current = { ...assistantRow, adapterType: "claude_managed",
      adapterConfig: { model: "claude-opus-5-5", env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: oldId, version: "latest" } } } };
    mockAgentService.getById.mockResolvedValue(current);
    mockEnsureAssistant.mockResolvedValue(current);
    mockSecretService.getById.mockImplementation(async (id: string) => id === oldId
      ? { id: oldId, companyId: "company-1", key: "ANTHROPIC_API_KEY.assistant-setup.old" } : null);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.remove).toHaveBeenCalledWith(oldId);
    expect(mockSecretService.remove).not.toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("keeps a superseded secret the setup card did not create, or that something still uses", async () => {
    const oldId = "44444444-4444-4444-8444-444444444444";
    const current = { ...assistantRow, adapterType: "claude_managed",
      adapterConfig: { model: "claude-opus-5-5", env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: oldId, version: "latest" } } } };
    mockAgentService.getById.mockResolvedValue(current);
    mockEnsureAssistant.mockResolvedValue(current);
    mockSecretService.getById.mockResolvedValue({ id: oldId, companyId: "company-1", key: "ANTHROPIC_API_KEY.setup.shared" });
    const app = await createApp();
    await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(mockSecretService.remove).not.toHaveBeenCalled();

    mockSecretService.getById.mockResolvedValue({ id: oldId, companyId: "company-1", key: "ANTHROPIC_API_KEY.assistant-setup.old" });
    mockSecretService.listBindings.mockResolvedValue([{ id: "binding-1" }]);
    await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(mockSecretService.remove).not.toHaveBeenCalled();
  });

  it("removes the new key secret when recording its activity fails", async () => {
    mockLogActivity.mockRejectedValueOnce(new Error("activity failed"));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_managed", apiKey: DUMMY_KEY }));
    expect(res.status).toBe(500);
    expect(mockSecretService.remove).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("does not count a key binding whose secret no longer exists", async () => {
    mockAdapterAvailability.mockResolvedValue([]);
    mockEnsureAssistant.mockResolvedValue({
      ...assistantRow,
      adapterConfig: { ...assistantRow.adapterConfig, env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-gone" } } },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/assistant/adapters"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapterAvailability.mock.calls.at(-1)![0]).toMatchObject({ hostedInferenceAvailable: false, anthropicKeyBound: false });
  });

  it("tells adapter detection about hosted inference and a bound key", async () => {
    mockAdapterAvailability.mockResolvedValue([]);
    mockSecretService.getById.mockResolvedValue({ id: "secret-1", companyId: "company-1", key: "MY_ANTHROPIC" });
    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    mockEnsureAssistant.mockResolvedValue({
      ...assistantRow,
      adapterConfig: { ...assistantRow.adapterConfig, env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-1" } } },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/assistant/adapters"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapterAvailability.mock.calls.at(-1)![0]).toMatchObject({ hostedInferenceAvailable: true, anthropicKeyBound: true });
    expect(JSON.stringify(res.body)).not.toContain(DUMMY_KEY);
  });

  it("forbids members without the agent configure grant, matching what saving would need", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_missing_grant", explanation: "no grant" });
    const member = await createApp({
      source: "session", userId: "member-1", companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }],
    });
    const res = await requestApp(member, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local" }));
    expect(res.status).toBe(403);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:update",
      resource: { type: "agent", companyId: "company-1", agentId: assistantId },
    }));
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("forbids viewers, agents, and other companies", async () => {
    const viewer = await createApp({
      source: "session", userId: "viewer-1", companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const viewerRes = await requestApp(viewer, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local" }));
    expect(viewerRes.status).toBe(403);

    const agent = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" });
    const agentRes = await requestApp(agent, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/assistant/setup").send({ adapterType: "claude_local" }));
    expect(agentRes.status).toBe(403);

    const board = await createApp({ source: "session", memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }] });
    const otherRes = await requestApp(board, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-2/assistant/setup").send({ adapterType: "claude_local" }));
    expect(otherRes.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterRuntimeEvent, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  budgetReachedTurn,
  fakeEvents,
  type FakeManagedAgentsServer,
  startFakeManagedAgentsServer,
  type TurnScript,
} from "../testing/fake-managed-agents-server.js";
import { startFakeMcpServer, type FakeMcpServer } from "../testing/fake-mcp-server.js";
import { execute, resolveNetworking } from "./execute.js";
import { sessionCodec } from "./session.js";
import { DEFAULT_MANAGED_AGENTS_BASE_URL } from "../types.js";
import { testEnvironment } from "./test-environment.js";

const RUN_TOKEN = "staples-run-jwt-SECRET-0001";

let fake: FakeManagedAgentsServer;
let mcp: FakeMcpServer | null = null;
let tmpDir: string;

beforeEach(async () => {
  fake = await startFakeManagedAgentsServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-managed-"));
});

afterEach(async () => {
  await fake.close();
  await mcp?.close();
  mcp = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function turn(text: string, cumulativeCents: number, tokens = { input: 100, output: 20 }): TurnScript {
  return [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "emit", event: fakeEvents.agentMessage(text) },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: tokens.input, outputTokens: tokens.output, listCostCents: cumulativeCents }) },
    { kind: "emit", event: fakeEvents.idle() },
  ];
}

interface Harness {
  ctx: AdapterExecutionContext;
  logs: string[];
  usage: AdapterUsageCheckpoint[];
  events: AdapterRuntimeEvent[];
  onDispatch: ReturnType<typeof vi.fn>;
  onCancellationReady: ReturnType<typeof vi.fn>;
}

function harness(options: {
  sessionParams?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  servers?: Array<{ name: string; url: string; token: string; connectionId: string }>;
  signal?: AbortSignal;
} = {}): Harness {
  const logs: string[] = [];
  const usage: AdapterUsageCheckpoint[] = [];
  const events: AdapterRuntimeEvent[] = [];
  const onDispatch = vi.fn();
  const onCancellationReady = vi.fn(async () => undefined);
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1234567890", companyId: "company-1", name: "Researcher", adapterType: "claude_managed", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: options.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: fake.baseUrl, ...options.config },
    context: { ...options.context },
    runtimeMcp: { getServers: () => options.servers ?? [] },
    signal: options.signal,
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
    onUsage: async (checkpoint) => {
      usage.push(checkpoint);
    },
    onEvent: async (event) => {
      events.push(event);
    },
    onDispatch,
    onCancellationReady,
  };
  return { ctx, logs, usage, events, onDispatch, onCancellationReady };
}

function logEvents(logs: string[]): Array<Record<string, unknown>> {
  return logs
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function requestsMatching(method: string, pattern: RegExp) {
  return fake.requests.filter((r) => r.method === method && pattern.test(r.path));
}

describe("claude_managed execute", () => {
  it("first run creates environment, agent and session, then streams the turn", async () => {
    fake.queueTurns(turn("All done.\nDetails follow.", 3));
    const h = harness();
    const result = await execute(h.ctx);

    expect(result).toMatchObject({ exitCode: 0, summary: "All done.\nDetails follow.", provider: "anthropic", biller: "anthropic", billingType: "api", model: "claude-opus-5-5" });
    expect(h.onCancellationReady).toHaveBeenCalledTimes(1);
    expect(h.onDispatch).toHaveBeenCalledTimes(1);

    const envReq = requestsMatching("POST", /^\/v1\/environments$/);
    expect(envReq).toHaveLength(1);
    expect(envReq[0].body).toMatchObject({ config: { type: "cloud", networking: { type: "unrestricted" } } });
    expect((envReq[0].body as { name: string }).name).toMatch(/^staples-agent1234567-[0-9a-f]{8}$/);

    const agentReq = requestsMatching("POST", /^\/v1\/agents$/);
    expect(agentReq).toHaveLength(1);
    expect(agentReq[0].body).toMatchObject({ name: "Staples: Researcher", model: "claude-opus-5-5", tools: [{ type: "agent_toolset_20260401" }] });
    expect(requestsMatching("POST", /^\/v1\/sessions$/)).toHaveLength(1);

    // The stream is opened before the user.message is sent.
    const streamIndex = fake.requests.findIndex((r) => r.method === "GET" && r.path.endsWith("/events/stream"));
    const sendIndex = fake.requests.findIndex((r) => r.method === "POST" && r.path.endsWith("/events"));
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(streamIndex).toBeLessThan(sendIndex);

    const params = sessionCodec.deserialize(result.sessionParams);
    expect(params).toMatchObject({ managedAgentVersion: 1, sessionId: fake.sessionIds()[0] });
    expect(result.sessionDisplayId).toBe(fake.sessionIds()[0]);

    const types = logEvents(h.logs).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["claude_managed.init", "claude_managed.message", "claude_managed.usage", "claude_managed.result"]));
    expect(h.events.map((e) => e.eventType)).toEqual(["claude_managed.session", "claude_managed.stop"]);
    expect(h.logs.join("")).not.toContain(fake.apiKey);
  });

  it("second run resumes the same session and bills only this run's usage", async () => {
    fake.queueTurns(turn("first", 3), turn("second", 8, { input: 250, output: 50 }));
    const first = await execute(harness().ctx);
    const h = harness({ sessionParams: first.sessionParams });
    const second = await execute(h.ctx);

    expect(second.exitCode).toBe(0);
    expect(requestsMatching("POST", /^\/v1\/agents/)).toHaveLength(1);
    expect(requestsMatching("POST", /^\/v1\/environments$/)).toHaveLength(1);
    expect(requestsMatching("POST", /^\/v1\/sessions$/)).toHaveLength(1);
    expect(second.sessionParams).toEqual(first.sessionParams);
    expect(fake.receivedEvents(fake.sessionIds()[0]).filter((e) => e.type === "user.message")).toHaveLength(2);
    expect(second.costUsd).toBeCloseTo(0.05, 10);
    expect(second.usage).toMatchObject({ inputTokens: 150, outputTokens: 30 });
    expect(logEvents(h.logs).find((e) => e.type === "claude_managed.init")).toMatchObject({ resumed: true });
  });

  it("changed instructions create a new agent version and a new session", async () => {
    const file = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(file, "Be brief.");
    fake.queueTurns(turn("one", 1), turn("two", 1));
    const first = await execute(harness({ config: { instructionsFilePath: file } }).ctx);
    expect(requestsMatching("POST", /^\/v1\/agents$/)[0].body).toMatchObject({ system: "Be brief." });

    await fs.writeFile(file, "Be thorough.");
    const second = await execute(harness({ sessionParams: first.sessionParams, config: { instructionsFilePath: file } }).ctx);
    expect(second.exitCode).toBe(0);
    const update = requestsMatching("POST", /^\/v1\/agents\/[^/]+$/);
    expect(update).toHaveLength(1);
    expect(update[0].body).toMatchObject({ system: "Be thorough.", version: 1 });
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(1);
    expect(fake.sessionIds()).toHaveLength(2);
    const firstParams = sessionCodec.deserialize(first.sessionParams)!;
    const secondParams = sessionCodec.deserialize(second.sessionParams)!;
    expect(secondParams.managedAgentId).toBe(firstParams.managedAgentId);
    expect(secondParams.managedAgentVersion).toBe(2);
    expect(secondParams.sessionId).not.toBe(firstParams.sessionId);
    expect(secondParams.fingerprint).not.toBe(firstParams.fingerprint);
  });

  it("starts a new session when the stored one was archived", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1));
    const first = await execute(harness().ctx);
    const firstSession = fake.sessionIds()[0];
    await fetch(`${fake.baseUrl}/sessions/${firstSession}/archive`, {
      method: "POST",
      headers: { "x-api-key": fake.apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01" },
    });
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx);
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(firstSession);
  });

  it("proxies custom tools to the Staples MCP server and keeps the run token away from Anthropic", async () => {
    mcp = await startFakeMcpServer({
      token: RUN_TOKEN,
      tools: [{ name: "lookup", description: "Find a record", inputSchema: { type: "object", properties: { q: { type: "string" } } }, handler: (args) => ({ content: [{ type: "text", text: `found ${String(args.q)}` }] }) }],
    });
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "custom_tool_call", name: "staples-tools__lookup", input: { q: "widgets" }, id: "sevt_tool_1" },
      { kind: "emit", event: fakeEvents.agentMessage("Found it.") },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 2 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const h = harness({ servers: [{ name: "Staples tools", url: mcp.url, token: RUN_TOKEN, connectionId: "c1" }] });
    const result = await execute(h.ctx);

    expect(result.exitCode).toBe(0);
    expect(mcp.calls()).toEqual([{ name: "lookup", arguments: { q: "widgets" } }]);
    expect(mcp.requests.every((r) => r.headers.authorization === `Bearer ${RUN_TOKEN}`)).toBe(true);

    const agentReq = requestsMatching("POST", /^\/v1\/agents$/)[0];
    expect((agentReq.body as { tools: unknown[] }).tools).toEqual([
      { type: "agent_toolset_20260401" },
      expect.objectContaining({ type: "custom", name: "staples-tools__lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }),
    ]);
    const toolResult = fake.receivedEvents(fake.sessionIds()[0]).find((e) => e.type === "user.custom_tool_result");
    expect(toolResult).toMatchObject({ custom_tool_use_id: "sevt_tool_1", is_error: false, content: [{ type: "text", text: "found widgets" }] });

    // The run token never reaches the Managed Agents API, in any request.
    expect(JSON.stringify(fake.requests)).not.toContain(RUN_TOKEN);
    expect(h.logs.join("")).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(h.events)).not.toContain(RUN_TOKEN);
    const toolLogs = logEvents(h.logs).filter((e) => String(e.type).startsWith("claude_managed.tool_"));
    expect(toolLogs.map((e) => e.type)).toEqual(["claude_managed.tool_use", "claude_managed.tool_result"]);
  });

  it("reports usage incrementally and in the final result", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.usage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, listCostCents: 4 }) },
      { kind: "emit", event: fakeEvents.agentMessage("Done.") },
      { kind: "emit", event: fakeEvents.usage({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 80, listCostCents: 7 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const h = harness();
    const result = await execute(h.ctx);

    const midRun = h.usage.filter((u) => !u.complete);
    expect(midRun.map((u) => u.costUsd)).toEqual([0.04, 0.07]);
    expect(h.usage.at(-1)).toMatchObject({ complete: true, costUsd: 0.07, costUsdExact: "0.07", costStatus: "reported", provider: "anthropic", biller: "anthropic", billingType: "api", usageBasis: "per_run" });
    expect(result).toMatchObject({ costUsd: 0.07, costUsdExact: "0.07", costStatus: "reported", usageBasis: "per_run" });
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30, cachedInputTokens: 80, cacheWriteTokens: 0 });
  });

  it("caps the session at the remaining budget and reports budget_reached", async () => {
    fake.queueTurns(budgetReachedTurn(50));
    const h = harness({ context: { paperclipBudgetRemainingUsd: 0.5 } });
    const result = await execute(h.ctx);

    expect(requestsMatching("POST", /^\/v1\/sessions$/)[0].body).toMatchObject({ budget: { type: "limit", max_list_cost: { amount: "50", currency: "USD" } } });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "budget_reached", costUsd: 0.5 });
    expect(result.summary).toContain("spending cap");
    expect(result.resultJson).toMatchObject({ status: "budget_reached", budgetStopped: true, stopReason: "budget_reached" });
    expect(logEvents(h.logs).at(-1)).toMatchObject({ type: "claude_managed.result", status: "budget_reached" });
  });

  it("creates the session without a cap when no budget is known", async () => {
    fake.queueTurns(turn("ok", 1));
    await execute(harness().ctx);
    expect((requestsMatching("POST", /^\/v1\/sessions$/)[0].body as Record<string, unknown>).budget).toBeUndefined();
  });

  it("fails with the session.error message", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.error("overloaded_error", "Model is overloaded", "retrying") },
      { kind: "emit", event: fakeEvents.error("api_error", "Upstream exploded", "terminal") },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const h = harness();
    const result = await execute(h.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Upstream exploded");
    expect(result.sessionParams).toBeTruthy();
    expect(logEvents(h.logs).filter((e) => e.type === "claude_managed.error")).toHaveLength(2);
  });

  it("never retries the user.message on a 5xx", async () => {
    fake.failNext({ method: "POST", path: /\/events$/, status: 500, times: 3 });
    const result = await execute(harness().ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("500");
    const messages = requestsMatching("POST", /\/events$/).filter(
      (r) => (r.body as { events: Array<{ type: string }> }).events[0].type === "user.message",
    );
    expect(messages).toHaveLength(1);
  });

  it("cancellation sends user.interrupt, returns promptly and keeps the session", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage("Working on it") },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 2 }) },
      { kind: "hang" },
    ]);
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const running = execute(h.ctx, { cancelGraceMs: 2_000 });
    await vi.waitFor(() => expect(h.logs.join("")).toContain("Working on it"), { timeout: 2_000 });
    const started = Date.now();
    controller.abort(new Error("operator cancelled"));
    const result = await running;

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result).toMatchObject({
      exitCode: null,
      errorCode: "cancelled",
      costUsd: 0.02,
      executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
      resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: expect.any(String) } },
    });
    const sessionId = fake.sessionIds()[0];
    expect(fake.receivedEvents(sessionId).map((e) => e.type)).toEqual(["user.message", "user.interrupt"]);
    await fake.settled();
    expect(fake.getSessionStatus(sessionId)).toBe("idle");
    expect(requestsMatching("POST", /\/archive$/)).toHaveLength(0);
    expect(result.sessionDisplayId).toBe(sessionId);
    expect(logEvents(h.logs).at(-1)).toMatchObject({ type: "claude_managed.result", status: "cancelled" });
  });

  it("returns a configuration error without an API key", async () => {
    const h = harness({ config: { env: {} } });
    const result = await execute(h.ctx, { env: {} });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_api_key_missing", errorFamily: "configuration" });
    expect(fake.requests).toHaveLength(0);
  });

  it("falls back to the server ANTHROPIC_API_KEY only when the server allows it, for the default API base URL", async () => {
    fake.queueTurns(turn("ok", 1));
    // Default base URL: requests are rerouted to the fake by the fetch seam.
    const toFake: typeof fetch = (input, init) => fetch(String(input).replace(DEFAULT_MANAGED_AGENTS_BASE_URL, fake.baseUrl), init);
    const h = harness({ config: { env: {}, apiBaseUrl: "" } });
    h.ctx.hostedInferenceAllowed = true;
    const result = await execute(h.ctx, { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiFetch: toFake });
    expect(result.exitCode).toBe(0);
  });

  it("refuses the server key for an agent the server did not allow hosted inference for", async () => {
    const toFake: typeof fetch = (input, init) => fetch(String(input).replace(DEFAULT_MANAGED_AGENTS_BASE_URL, fake.baseUrl), init);
    const h = harness({ config: { env: {}, apiBaseUrl: "" } });
    const requestsBefore = fake.requests.length;
    const result = await execute(h.ctx, { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiFetch: toFake });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_api_key_missing", errorFamily: "configuration",
      errorMessage: "This agent needs its own Anthropic API key; the server's hosted inference is not available to it (hosted inference is off, or its spending caps could not be set)." });
    expect(fake.requests.length).toBe(requestsBefore);
    // A config flag cannot grant it: only the server-owned context field counts.
    const spoofed = harness({ config: { env: {}, apiBaseUrl: "", hostedInferenceAllowed: true } });
    expect(await execute(spoofed.ctx, { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiFetch: toFake }))
      .toMatchObject({ errorCode: "claude_managed_api_key_missing" });

    const check = await testEnvironment(
      { companyId: "company-1", adapterType: "claude_managed", config: { hostedInferenceAllowed: true } },
      { env: { ANTHROPIC_API_KEY: fake.apiKey } },
    );
    expect(check.checks).toEqual([expect.objectContaining({ code: "claude_managed_api_key_missing",
      message: "This agent needs its own Anthropic API key; the server's hosted inference is not available to it (hosted inference is off, or its spending caps could not be set)." })]);
    expect(JSON.stringify(check)).not.toContain(fake.apiKey);
  });

  it("never sends the server key to a custom API base URL", async () => {
    const h = harness({ config: { env: {} } }); // apiBaseUrl is the fake (custom)
    h.ctx.hostedInferenceAllowed = true;
    const result = await execute(h.ctx, { env: { ANTHROPIC_API_KEY: fake.apiKey } });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_api_key_missing", errorFamily: "configuration" });
    expect(result.errorMessage).toContain("custom API base URL");
    expect(fake.requests).toHaveLength(0);

    const check = await testEnvironment(
      { companyId: "company-1", adapterType: "claude_managed", config: { apiBaseUrl: fake.baseUrl }, hostedInferenceAllowed: true },
      { env: { ANTHROPIC_API_KEY: fake.apiKey } },
    );
    expect(check.status).toBe("fail");
    expect(check.checks).toEqual([expect.objectContaining({ code: "claude_managed_api_key_missing", message: expect.stringContaining("custom API base URL") })]);
    expect(fake.requests).toHaveLength(0);
  });

  it("honors a configured environmentId", async () => {
    const env = await (await fetch(`${fake.baseUrl}/environments`, {
      method: "POST",
      headers: { "x-api-key": fake.apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" },
      body: JSON.stringify({ name: "mine", config: { type: "cloud", networking: { type: "limited" } } }),
    })).json() as { id: string };
    fake.queueTurns(turn("ok", 1));
    const result = await execute(harness({ config: { environmentId: env.id } }).ctx);
    expect(result.exitCode).toBe(0);
    expect(requestsMatching("POST", /^\/v1\/environments$/)).toHaveLength(1);
    expect(requestsMatching("POST", /^\/v1\/sessions$/)[0].body).toMatchObject({ environment_id: env.id });
  });
});

describe("claude_managed stuck sessions", () => {
  it("fails and interrupts after the inactivity timeout", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 1 }) },
      { kind: "hang" },
    ]);
    const h = harness();
    const started = Date.now();
    const result = await execute(h.ctx, { inactivityTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_inactive", errorFamily: "transient_upstream" });
    expect(result.errorMessage).toContain("No activity");
    expect(result.costUsd).toBeCloseTo(0.01, 10);
    expect(fake.receivedEvents(fake.sessionIds()[0]).map((e) => e.type)).toContain("user.interrupt");
  });

  it("reads inactivityTimeoutSec from the adapter config", async () => {
    const { resolveInactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS } = await import("./execute.js");
    expect(resolveInactivityTimeoutMs({})).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBe(15 * 60_000);
    expect(resolveInactivityTimeoutMs({ inactivityTimeoutSec: 60 })).toBe(60_000);
    expect(resolveInactivityTimeoutMs({ inactivityTimeoutSec: "90" })).toBe(90_000);
    expect(resolveInactivityTimeoutMs({ inactivityTimeoutSec: 0 })).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs({ inactivityTimeoutSec: 60 }, 5)).toBe(5);
  });

  it("fails and interrupts when requires_action names events the adapter cannot answer", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.idle({ type: "requires_action", event_ids: ["sevt_builtin_confirm_1"] }) },
      { kind: "hang" },
    ]);
    const h = harness();
    const result = await execute(h.ctx, { inactivityTimeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_managed_unsupported_action", errorFamily: "configuration" });
    expect(result.errorMessage).toContain("sevt_builtin_confirm_1");
    expect(fake.receivedEvents(fake.sessionIds()[0]).map((e) => e.type)).toContain("user.interrupt");
  });
});

describe("environment names", () => {
  it("differ by a networking fingerprint suffix", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1));
    await execute(harness().ctx);
    await execute(harness({ config: { networkingMode: "limited", networkAllowedHosts: "example.com" } }).ctx);
    const names = requestsMatching("POST", /^\/v1\/environments$/).map((r) => (r.body as { name: string }).name);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^staples-agent1234567-[0-9a-f]{8}$/);
    expect(names[1]).toMatch(/^staples-agent1234567-[0-9a-f]{8}$/);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe("resolveNetworking", () => {
  it("defaults to explicit unrestricted networking and supports limited opt-in", () => {
    expect(resolveNetworking({})).toEqual({ type: "unrestricted" });
    expect(resolveNetworking({ networking: { type: "limited", allowedHosts: ["api.example.com", ""], allowPackageManagers: true } })).toEqual({
      type: "limited",
      allowed_hosts: ["api.example.com"],
      allow_package_managers: true,
      allow_mcp_servers: false,
    });
  });
});

describe("claude_managed testEnvironment", () => {
  const base = { companyId: "company-1", adapterType: "claude_managed" };

  it("passes with a working key and never echoes it", async () => {
    const result = await testEnvironment({ ...base, config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: fake.baseUrl } }, { env: {} });
    expect(result.status).toBe("pass");
    expect(result.checks.map((c) => c.code)).toEqual(["claude_managed_api_key_present", "claude_managed_auth_ok"]);
    expect(JSON.stringify(result)).not.toContain(fake.apiKey);
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/v1/agents", query: expect.stringContaining("limit=1") });
  });

  it("maps a missing key, a rejected key, rate limits and network errors to plain checks", async () => {
    const missing = await testEnvironment({ ...base, config: {} }, { env: {} });
    expect(missing.checks.map((c) => c.code)).toEqual(["claude_managed_api_key_missing"]);

    const rejected = await testEnvironment({ ...base, config: { env: { ANTHROPIC_API_KEY: "sk-ant-wrong-key-xyz" }, apiBaseUrl: fake.baseUrl } }, { env: {} });
    expect(rejected.status).toBe("fail");
    expect(rejected.checks.at(-1)?.code).toBe("claude_managed_auth_invalid");
    expect(JSON.stringify(rejected)).not.toContain("sk-ant-wrong-key-xyz");

    fake.failNext({ method: "GET", path: "/v1/agents", status: 403 });
    const denied = await testEnvironment({ ...base, config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: fake.baseUrl } }, { env: {} });
    expect(denied.checks.at(-1)?.code).toBe("claude_managed_access_denied");

    fake.failNext({ method: "GET", path: "/v1/agents", status: 429 });
    const limited = await testEnvironment({ ...base, config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: fake.baseUrl } }, { env: {} });
    expect(limited.status).toBe("warn");
    expect(limited.checks.at(-1)?.code).toBe("claude_managed_rate_limited");

    const unreachable = await testEnvironment({ ...base, config: { env: { ANTHROPIC_API_KEY: fake.apiKey }, apiBaseUrl: "http://127.0.0.1:1/v1" } }, { env: {} });
    expect(unreachable.checks.at(-1)?.code).toBe("claude_managed_unreachable");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1: cancellation contract, stream failure, settling, adoption
// ---------------------------------------------------------------------------

async function api(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${fake.baseUrl}${apiPath}`, {
    method,
    headers: {
      "x-api-key": fake.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return (await response.json()) as Record<string, unknown>;
}

async function sendUserMessage(sessionId: string): Promise<void> {
  await api("POST", `/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "leftover" }] }] });
}

describe("claude_managed cancellation and recovery", () => {
  it("acknowledges a cancellation that arrives before any provider work", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    const result = await execute(h.ctx);
    expect(result).toMatchObject({
      exitCode: null,
      errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(fake.requests).toHaveLength(0);
    expect(logEvents(h.logs).at(-1)).toMatchObject({ type: "claude_managed.result", status: "cancelled" });
  });

  it("without an observed idle, a cancelled run omits interrupted evidence and still bills usage", async () => {
    fake.ignoreInterrupts = true;
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage("Working") },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 2 }) },
      { kind: "hang" },
    ]);
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const running = execute(h.ctx, { cancelGraceMs: 400 });
    await vi.waitFor(() => expect(h.logs.join("")).toContain("Working"), { timeout: 2_000 });
    const sessionId = fake.sessionIds()[0];
    const started = Date.now();
    controller.abort();
    const result = await running;

    expect(Date.now() - started).toBeLessThan(1_200);
    expect(result).toMatchObject({ exitCode: null, errorCode: "cancelled", costUsd: 0.02, resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(result.executionRecovery).toBeUndefined();
    expect(fake.receivedEvents(sessionId).map((e) => e.type)).toEqual(["user.message", "user.interrupt"]);
    expect(h.usage.at(-1)).toMatchObject({ complete: true, costUsd: 0.02 });
  });

  it("a dropped stream sends an interrupt and bills the session's final usage", async () => {
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage("Halfway") },
      { kind: "emit", event: fakeEvents.usage({ listCostCents: 3 }) },
      { kind: "hang" },
    ]);
    const h = harness();
    const running = execute(h.ctx);
    await vi.waitFor(() => expect(h.logs.join("")).toContain("Halfway"), { timeout: 2_000 });
    const sessionId = fake.sessionIds()[0];
    fake.dropStreams(sessionId);
    // Spend that happened after the stream dropped: only the session resource shows it.
    fake.emit(sessionId, fakeEvents.usage({ listCostCents: 9 }));
    const result = await running;

    expect(result).toMatchObject({ exitCode: 1, errorFamily: "transient_upstream", costUsd: 0.09 });
    expect(fake.receivedEvents(sessionId).map((e) => e.type)).toEqual(["user.message", "user.interrupt"]);
    expect(h.usage.at(-1)).toMatchObject({ complete: true, costUsd: 0.09 });
  });

  it("an abort while the task is being sent still interrupts the session", async () => {
    fake.failNext({ method: "POST", path: /\/events$/, status: 200, delayMs: 400, passThrough: true });
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const running = execute(h.ctx, { cancelGraceMs: 500 });
    await vi.waitFor(() => expect(requestsMatching("POST", /\/events$/)).toHaveLength(1), { timeout: 2_000 });
    controller.abort();
    const result = await running;

    expect(result).toMatchObject({ exitCode: null, errorCode: "cancelled", resultJson: { executionCancellation: { state: "acknowledged" } } });
    const bodies = requestsMatching("POST", /\/events$/).map((r) => (r.body as { events: Array<{ type: string }> }).events[0].type);
    expect(bodies).toEqual(["user.message", "user.interrupt"]);
  });

  it("settles a resumed session left running by a crashed run, then resumes it", async () => {
    fake.queueTurns(turn("first", 1), [{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }], turn("second", 4));
    const first = await execute(harness().ctx);
    const sessionId = fake.sessionIds()[0];
    await sendUserMessage(sessionId);
    await vi.waitFor(() => expect(fake.getSessionStatus(sessionId)).toBe("running"));

    const h = harness({ sessionParams: first.sessionParams });
    const second = await execute(h.ctx, { settlePollMs: 20 });
    expect(second).toMatchObject({ exitCode: 0, sessionDisplayId: sessionId, summary: "second" });
    expect(fake.sessionIds()).toHaveLength(1);
    expect(fake.receivedEvents(sessionId).map((e) => e.type)).toEqual(["user.message", "user.message", "user.interrupt", "user.message"]);
    expect(second.costUsd).toBeCloseTo(0.03, 10);
  });

  it("settles and archives the session a continuation turn supersedes before starting a fresh one", async () => {
    // A conversation run failed while its session kept working; the server then
    // forces a fresh session for the continuation turn and names the old one.
    fake.queueTurns(turn("first", 1), [{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }], turn("continued", 1));
    const first = await execute(harness().ctx);
    const oldSession = fake.sessionIds()[0];
    await sendUserMessage(oldSession);
    await vi.waitFor(() => expect(fake.getSessionStatus(oldSession)).toBe("running"));

    const h = harness({ sessionParams: null, context: { paperclipSupersededSessionParams: first.sessionParams } });
    const second = await execute(h.ctx, { settlePollMs: 20 });
    expect(second).toMatchObject({ exitCode: 0, summary: "continued" });
    const sessions = fake.sessionIds();
    expect(sessions).toHaveLength(2);
    // The old session was interrupted (and settled) before the new turn was sent.
    expect(fake.receivedEvents(oldSession).map((e) => e.type)).toEqual(["user.message", "user.message", "user.interrupt", "user.interrupt"]);
    expect(fake.getSessionStatus(oldSession)).not.toBe("running");
    expect((await api("GET", `/sessions/${oldSession}`)).archived_at).toEqual(expect.any(String));
    expect(fake.receivedEvents(sessions[1]).map((e) => e.type)).toEqual(["user.message"]);
    expect(h.logs.join("")).toContain("superseded session");
  });

  it("leaves an idle superseded session alone", async () => {
    fake.queueTurns(turn("first", 1), turn("fresh", 1));
    const first = await execute(harness().ctx);
    const oldSession = fake.sessionIds()[0];
    const second = await execute(harness({ sessionParams: null, context: { paperclipSupersededSessionParams: first.sessionParams } }).ctx, { settlePollMs: 20 });
    expect(second.exitCode).toBe(0);
    expect(fake.receivedEvents(oldSession).map((e) => e.type)).toEqual(["user.message"]);
  });

  it("settles a resumed session waiting on tool results from a crashed run", async () => {
    fake.queueTurns(turn("first", 1), [{ kind: "custom_tool_call", name: "gone__tool" }], turn("second", 2));
    const first = await execute(harness().ctx);
    const sessionId = fake.sessionIds()[0];
    await sendUserMessage(sessionId);
    await vi.waitFor(async () => expect((await api("GET", `/sessions/${sessionId}`)).stop_reason).toMatchObject({ type: "requires_action" }));

    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { settlePollMs: 20 });
    expect(second).toMatchObject({ exitCode: 0, sessionDisplayId: sessionId });
    expect(fake.receivedEvents(sessionId).map((e) => e.type)).toEqual(["user.message", "user.message", "user.interrupt", "user.message"]);
  });

  it("starts a new session when the resumed one will not settle", async () => {
    fake.queueTurns(turn("first", 1), [{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }], turn("second", 1));
    const first = await execute(harness().ctx);
    const stuck = fake.sessionIds()[0];
    await sendUserMessage(stuck);
    await vi.waitFor(() => expect(fake.getSessionStatus(stuck)).toBe("running"));
    fake.ignoreInterrupts = true;

    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { settlePollMs: 20, settleTimeoutMs: 200 });
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(stuck);
    // The abandoned session is interrupted and archived (best effort).
    expect((await api("GET", `/sessions/${stuck}`)).archived_at).toBeTruthy();
    expect(fake.receivedEvents(stuck).filter((e) => e.type === "user.interrupt").length).toBeGreaterThanOrEqual(2);
  });

  it("an abandoned session that cannot be archived does not fail the run", async () => {
    fake.queueTurns(turn("first", 1), [{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }], turn("second", 1));
    const first = await execute(harness().ctx);
    const stuck = fake.sessionIds()[0];
    await sendUserMessage(stuck);
    await vi.waitFor(() => expect(fake.getSessionStatus(stuck)).toBe("running"));
    fake.ignoreInterrupts = true;
    fake.failNext({ method: "POST", path: `/v1/sessions/${stuck}/archive`, status: 500, times: 5 });
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { settlePollMs: 20, settleTimeoutMs: 100 });
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
  });
});

describe("claude_managed settle and send failures", () => {
  async function stuckSession() {
    fake.queueTurns(turn("first", 1), [{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }], turn("second", 1));
    const first = await execute(harness().ctx);
    const stuck = fake.sessionIds()[0];
    await sendUserMessage(stuck);
    await vi.waitFor(() => expect(fake.getSessionStatus(stuck)).toBe("running"));
    return { first, stuck };
  }

  it("starts a new session when the settle interrupt cannot be sent", async () => {
    const { first, stuck } = await stuckSession();
    fake.failNext({ method: "POST", path: `/v1/sessions/${stuck}/events`, status: 400 });
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { settlePollMs: 20 });
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(stuck);
  });

  it("starts a new session when polling the settling session fails", async () => {
    const { first, stuck } = await stuckSession();
    fake.ignoreInterrupts = true;
    // The resume lookup passes; every settle poll after it fails.
    fake.failNext({ method: "GET", path: `/v1/sessions/${stuck}`, status: 200, passThrough: true });
    fake.failNext({ method: "GET", path: `/v1/sessions/${stuck}`, status: 400, times: 50 });
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { settlePollMs: 20 });
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(stuck);
  });

  it("interrupts the session when the user.message send fails with a 5xx", async () => {
    fake.failNext({ method: "POST", path: /\/events$/, status: 500 });
    const result = await execute(harness().ctx);
    expect(result.exitCode).toBe(1);
    const types = requestsMatching("POST", /\/events$/).map((r) => (r.body as { events: Array<{ type: string }> }).events[0].type);
    expect(types).toEqual(["user.message", "user.interrupt"]);
  });
});

describe("claude_managed agent and environment reuse", () => {
  it("writes company and instance ids into metadata and only adopts resources from the same instance", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1), turn("three", 1));
    await execute(harness().ctx, { instanceId: "instance-a" });
    const agentCreate = requestsMatching("POST", /^\/v1\/agents$/)[0].body as { metadata: Record<string, string> };
    expect(agentCreate.metadata).toMatchObject({ staples_agent_id: "agent-1234567890", staples_company_id: "company-1", staples_instance_id: "instance-a" });
    const envCreate = requestsMatching("POST", /^\/v1\/environments$/)[0].body as { metadata: Record<string, string> };
    expect(envCreate.metadata).toMatchObject({ staples_company_id: "company-1", staples_instance_id: "instance-a" });

    // A forked instance with the same agent and company ids creates its own resources.
    await execute(harness().ctx, { instanceId: "instance-b" });
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(2);
    expect(requestsMatching("POST", /^\/v1\/environments$/)).toHaveLength(2);

    // A different company with the same agent id does not adopt either.
    const other = harness();
    other.ctx.agent = { ...other.ctx.agent, companyId: "company-2" };
    await execute(other.ctx, { instanceId: "instance-a" });
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(3);
  });

  it("adopts the Staples agent's existing Managed Agents agent and environment for a new task", async () => {
    fake.queueTurns(turn("task one", 1), turn("task two", 1));
    const one = await execute(harness().ctx);
    const two = await execute(harness().ctx); // another task: no sessionParams
    expect(two.exitCode).toBe(0);
    expect(requestsMatching("POST", /^\/v1\/agents/)).toHaveLength(1);
    expect(requestsMatching("POST", /^\/v1\/environments$/)).toHaveLength(1);
    expect(fake.sessionIds()).toHaveLength(2);
    const a = sessionCodec.deserialize(one.sessionParams)!;
    const b = sessionCodec.deserialize(two.sessionParams)!;
    expect(b.managedAgentId).toBe(a.managedAgentId);
    expect(b.environmentId).toBe(a.environmentId);
  });

  it("applies tool changes to the resumed session in place and to a new agent version", async () => {
    const tools: Array<{ name: string; inputSchema: Record<string, unknown> }> = [
      { name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ];
    mcp = await startFakeMcpServer({ token: RUN_TOKEN, tools });
    const servers = [{ name: "Staples tools", url: mcp.url, token: RUN_TOKEN, connectionId: "c1" }];
    fake.queueTurns(turn("one", 1), turn("two", 2));
    const first = await execute(harness({ servers }).ctx);
    const sessionId = fake.sessionIds()[0];

    tools[0].inputSchema = { type: "object", properties: { q: { type: "string" }, limit: { type: "number" } } };
    tools.push({ name: "create", inputSchema: { type: "object", properties: {} } });
    const second = await execute(harness({ servers, sessionParams: first.sessionParams }).ctx);

    expect(second).toMatchObject({ exitCode: 0, sessionDisplayId: sessionId });
    expect(fake.sessionIds()).toHaveLength(1);
    const sessionUpdate = requestsMatching("POST", new RegExp(`^/v1/sessions/${sessionId}$`));
    expect(sessionUpdate).toHaveLength(1);
    const updatedNames = (fake.sessionAgent(sessionId)!.tools as Array<{ name?: string }>).map((t) => t.name);
    expect(updatedNames).toEqual([undefined, "staples-tools__lookup", "staples-tools__create"]);
    expect(requestsMatching("POST", /^\/v1\/agents\/[^/]+$/)).toHaveLength(1);
    expect(sessionCodec.deserialize(second.sessionParams)).toMatchObject({ managedAgentVersion: 2 });
  });

  it("ignores stored session params whose resources another instance owns", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1));
    const first = await execute(harness().ctx, { instanceId: "instance-a" });
    const firstSession = fake.sessionIds()[0];
    // A fork instance with a copied database (same agent, company and stored ids).
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { instanceId: "instance-b" });
    expect(second.exitCode).toBe(0);
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(2);
    expect(requestsMatching("POST", /^\/v1\/agents\/[^/]+$/)).toHaveLength(0);
    expect(requestsMatching("POST", /^\/v1\/environments$/)).toHaveLength(2);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(firstSession);
    // The original session was never touched: one user.message, no interrupt, no update.
    expect(fake.receivedEvents(firstSession).map((e) => e.type)).toEqual(["user.message"]);
    expect(requestsMatching("POST", new RegExp(`^/v1/sessions/${firstSession}($|/archive)`))).toHaveLength(0);
  });

  it("starts a new session when the stored session carries another instance id", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1));
    const first = await execute(harness().ctx, { instanceId: "instance-a" });
    const firstSession = fake.sessionIds()[0];
    fake.setMetadata("session", firstSession, { staples_agent_id: "agent-1234567890", staples_company_id: "company-1", staples_instance_id: "instance-x" });
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx, { instanceId: "instance-a" });
    expect(second.exitCode).toBe(0);
    expect(fake.sessionIds()).toHaveLength(2);
    expect(second.sessionDisplayId).not.toBe(firstSession);
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(1);
    expect(fake.receivedEvents(firstSession).map((e) => e.type)).toEqual(["user.message"]);
  });

  it("creates a new agent when the stored one was archived", async () => {
    fake.queueTurns(turn("one", 1), turn("two", 1));
    const first = await execute(harness().ctx);
    const stored = sessionCodec.deserialize(first.sessionParams)!;
    fake.archiveAgent(String(stored.managedAgentId));
    const second = await execute(harness({ sessionParams: first.sessionParams }).ctx);
    expect(second.exitCode).toBe(0);
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(2);
    expect(sessionCodec.deserialize(second.sessionParams)!.managedAgentId).not.toBe(stored.managedAgentId);
    expect(fake.sessionIds()).toHaveLength(2);
  });
});

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFromUsd, ManagedAgentsApiError, ManagedAgentsClient, type ManagedAgentsEvent } from "./client.js";
import {
  budgetReachedTurn,
  fakeEvents,
  FakeManagedAgentsServer,
  simpleTurn,
  startFakeManagedAgentsServer,
} from "./testing/fake-managed-agents-server.js";

const noSleep = async () => undefined;

async function setup(fake: FakeManagedAgentsServer, client: ManagedAgentsClient) {
  const agent = await client.createAgent({
    name: "test-agent",
    model: "claude-sonnet-5-5",
    system: "You are helpful.",
    tools: [
      { type: "agent_toolset_20260401" },
      { type: "custom", name: "lookup", description: "Look something up", input_schema: { type: "object", properties: {} } },
    ],
  });
  const env = await client.createEnvironment({ name: "test-env", config: { type: "cloud", networking: { type: "limited", allow_package_managers: true } } });
  const session = await client.createSession({ agent: agent.id, environment_id: env.id });
  expect(fake.sessionIds()).toContain(session.id);
  return { agent, env, session };
}

async function collectUntilIdle(stream: AsyncIterable<ManagedAgentsEvent>, onEvent?: (e: ManagedAgentsEvent) => Promise<void>) {
  const events: ManagedAgentsEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    await onEvent?.(event);
    if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") break;
  }
  return events;
}

describe("ManagedAgentsClient against the fake server", () => {
  let fake: FakeManagedAgentsServer;
  let client: ManagedAgentsClient;

  beforeEach(async () => {
    fake = await startFakeManagedAgentsServer();
    client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
  });

  afterEach(async () => {
    await fake.close();
  });

  it("sends the required headers on every request, including the stream", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns(simpleTurn("hi"));
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "hello" }] }]);
    await collectUntilIdle(stream);
    await client.getSession(session.id);
    await client.archiveSession(session.id);

    expect(fake.requests.length).toBeGreaterThanOrEqual(7);
    for (const request of fake.requests) {
      expect(request.hasValidKey).toBe(true);
      expect(request.headers["x-api-key"]).toBe("[redacted]");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");
      expect(request.query).toBe("?beta=true");
    }
    const streamRequest = fake.requests.find((r) => r.path.endsWith("/events/stream"));
    expect(streamRequest?.headers.accept).toBe("text/event-stream");
    const archive = fake.requests.find((r) => r.path === `/v1/sessions/${session.id}/archive`);
    expect(archive?.method).toBe("POST");
  });

  it("creates, reads, and updates agents (update bumps the version)", async () => {
    const agent = await client.createAgent({ name: "a", model: "claude-sonnet-5-5" });
    expect(agent.version).toBe(1);
    const updated = await client.updateAgent(agent.id, { system: "new", version: 1 });
    expect(updated.version).toBe(2);
    expect((await client.getAgent(agent.id)).system).toBe("new");
    await expect(client.updateAgent(agent.id, { system: "stale", version: 1 })).rejects.toMatchObject({ status: 409 });
    const env = await client.createEnvironment({ name: "e", config: { type: "cloud" } });
    expect((await client.getEnvironment(env.id)).name).toBe("e");
  });

  it("streams a scripted turn with a custom tool call answered by user.custom_tool_result", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentToolUse("bash", { command: "ls" }) },
      { kind: "custom_tool_call", id: "sevt_tool1", name: "lookup", input: { q: "x" } },
      { kind: "emit", event: fakeEvents.agentMessage("Got it") },
      { kind: "emit", event: fakeEvents.usage({ inputTokens: 500, outputTokens: 50, listCostCents: 12 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const events = await collectUntilIdle(stream, async (event) => {
      if (event.type === "agent.custom_tool_use") {
        await client.sendEvents(session.id, [
          { type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text: "answer" }] },
        ]);
      }
    });

    expect(events.map((e) => e.type)).toEqual([
      "session.status_running",
      "agent.tool_use",
      "agent.custom_tool_use",
      "session.status_idle",
      "session.status_running",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    const tool = events.find((e) => e.type === "agent.custom_tool_use");
    expect(tool).toMatchObject({ id: "sevt_tool1", name: "lookup", input: { q: "x" } });
    const requiresAction = events[3];
    expect(requiresAction).toMatchObject({ stop_reason: { type: "requires_action", event_ids: ["sevt_tool1"] } });
    const usage = events.find((e) => e.type === "session.usage");
    expect(usage).toMatchObject({ usage: { input_tokens: 500, output_tokens: 50, list_cost: { amount: "12", currency: "USD" } } });
    const result = fake.receivedEvents(session.id).find((e) => e.type === "user.custom_tool_result");
    expect(result).toMatchObject({ custom_tool_use_id: "sevt_tool1", content: [{ type: "text", text: "answer" }] });
  });

  it("parses multi-line data and skips keep-alives", async () => {
    await fake.close();
    fake = await startFakeManagedAgentsServer({ multilineData: true, keepAlives: true });
    client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    const { session } = await setup(fake, client);
    fake.queueTurns(simpleTurn("multi, \"quoted\" line"));
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const events = await collectUntilIdle(stream);
    expect(events.map((e) => e.type)).toEqual(["session.status_running", "agent.message", "session.usage", "session.status_idle"]);
    expect(events[1]).toMatchObject({ content: [{ type: "text", text: "multi, \"quoted\" line" }] });
  });

  it("creates a budgeted session and reports budget_reached", async () => {
    const agent = await client.createAgent({ name: "a", model: "claude-sonnet-5-5" });
    const env = await client.createEnvironment({ name: "e" });
    const budget = budgetFromUsd(1.25)!;
    expect(budget).toEqual({ type: "limit", max_list_cost: { amount: "125", currency: "USD" } });
    const session = await client.createSession({ agent: agent.id, environment_id: env.id, budget });
    expect(session.budget).toEqual(budget);
    fake.queueTurns(budgetReachedTurn(127, budget));
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const events = await collectUntilIdle(stream);
    const idle = events.at(-1);
    expect(idle).toMatchObject({ type: "session.status_idle", stop_reason: { type: "budget_reached" } });
    expect(events.at(-2)).toMatchObject({ type: "session.usage", usage: { list_cost: { amount: "127" } }, budget });
  });

  it("interrupts a running turn and the session goes idle", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns([{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }, { kind: "emit", event: fakeEvents.agentMessage("never") }]);
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const events = await collectUntilIdle(stream, async (event) => {
      if (event.type === "session.status_running") await client.sendEvents(session.id, [{ type: "user.interrupt" }]);
    });
    expect(events.map((e) => e.type)).toEqual(["session.status_running", "session.usage", "session.status_idle"]);
    expect(fake.receivedEvents(session.id).map((e) => e.type)).toEqual(["user.message", "user.interrupt"]);
    await fake.settled();
    expect(fake.getSessionStatus(session.id)).toBe("idle");
  });

  it("ends the stream quietly when the signal aborts", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns([{ kind: "emit", event: fakeEvents.running() }, { kind: "hang" }]);
    const controller = new AbortController();
    const stream = await client.openEventStream(session.id, { signal: controller.signal });
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.type);
      controller.abort();
    }
    expect(seen).toEqual(["session.status_running"]);
  });

  it("drops events emitted before the stream opens (mirrors the real API)", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns(simpleTurn("early"), simpleTurn("late"));
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "first" }] }]);
    await fake.settled();
    expect(fake.emittedEvents(session.id).map((e) => e.type)).toContain("agent.message");
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "second" }] }]);
    const events = await collectUntilIdle(stream);
    const texts = events.flatMap((e) => (e.type === "agent.message" ? e.content.map((c) => (c as { text?: string }).text) : []));
    expect(texts).toEqual(["late"]);
  });

  it("can buffer events until a stream opens when opted in", async () => {
    await fake.close();
    fake = await startFakeManagedAgentsServer({ bufferUntilStream: true });
    client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    const { session } = await setup(fake, client);
    fake.queueTurns(simpleTurn("buffered"));
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    await fake.settled();
    const events = await collectUntilIdle(await client.openEventStream(session.id));
    expect(events.map((e) => e.type)).toEqual(["session.status_running", "agent.message", "session.usage", "session.status_idle"]);
  });

  it("streamEvents is a lazy wrapper over openEventStream", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns(simpleTurn("lazy"));
    const stream = client.streamEvents(session.id);
    const first = stream.next(); // opens the stream
    while (!fake.requests.some((r) => r.path.endsWith("/events/stream"))) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    expect((await first).value).toMatchObject({ type: "session.status_running" });
    await stream.return(undefined);
  });

  it("passes unknown event types through", async () => {
    const { session } = await setup(fake, client);
    fake.queueTurns([
      { kind: "emit", event: { type: "span.model_request_start" } },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
    const stream = await client.openEventStream(session.id);
    await client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }]);
    const events = await collectUntilIdle(stream);
    expect(events[0]).toMatchObject({ type: "unknown", eventType: "span.model_request_start" });
  });
});

describe("ManagedAgentsClient errors and retries", () => {
  let fake: FakeManagedAgentsServer;

  beforeEach(async () => {
    fake = await startFakeManagedAgentsServer();
  });

  afterEach(async () => {
    await fake.close();
  });

  it("retries GETs on 429 and 5xx up to 3 times with backoff, honoring retry-after", async () => {
    const delays: number[] = [];
    const client = new ManagedAgentsClient({
      apiKey: fake.apiKey,
      baseUrl: fake.baseUrl,
      retryBaseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const agent = await client.createAgent({ name: "a", model: "m" });
    fake.failNext({ method: "GET", status: 429, retryAfterSeconds: 2 });
    fake.failNext({ method: "GET", status: 503 });
    fake.failNext({ method: "GET", status: 529 });
    expect((await client.getAgent(agent.id)).id).toBe(agent.id);
    expect(fake.requests.filter((r) => r.method === "GET")).toHaveLength(4);
    expect(delays[0]).toBe(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(250);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
    expect(delays[2]).toBeLessThan(500);
  });

  it("retries POSTs only on 429 by default, never on 5xx", async () => {
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    fake.failNext({ method: "POST", path: "/v1/agents", status: 429 });
    fake.failNext({ method: "POST", path: "/v1/agents", status: 429 });
    expect((await client.createAgent({ name: "a", model: "m" })).id).toMatch(/^agent_/);
    expect(fake.requests.filter((r) => r.path === "/v1/agents")).toHaveLength(3);

    fake.failNext({ method: "POST", path: "/v1/agents", status: 503 });
    await expect(client.createAgent({ name: "b", model: "m" })).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fake.requests.filter((r) => r.path === "/v1/agents")).toHaveLength(4);
  });

  it("sendEvents: user.message is never retried on 5xx; custom tool results may opt in", async () => {
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    const agent = await client.createAgent({ name: "a", model: "m" });
    const env = await client.createEnvironment({ name: "e" });
    const session = await client.createSession({ agent: agent.id, environment_id: env.id });
    const eventPosts = () => fake.requests.filter((r) => r.path === `/v1/sessions/${session.id}/events`).length;

    fake.failNext({ method: "POST", path: /\/events$/, status: 500 });
    await expect(
      client.sendEvents(session.id, [{ type: "user.message", content: [{ type: "text", text: "x" }] }], { retry: "all" }),
    ).rejects.toMatchObject({ status: 500 });
    expect(eventPosts()).toBe(1);

    fake.failNext({ method: "POST", path: /\/events$/, status: 502, times: 2 });
    await client.sendEvents(session.id, [{ type: "user.custom_tool_result", custom_tool_use_id: "sevt_x", content: [] }], { retry: "all" });
    expect(eventPosts()).toBe(4);

    fake.failNext({ method: "POST", path: /\/events$/, status: 429 });
    await expect(client.sendEvents(session.id, [{ type: "user.interrupt" }], { retry: "none" })).rejects.toMatchObject({ status: 429 });
    expect(eventPosts()).toBe(5);
  });

  it("gives up after 3 retries with a typed error", async () => {
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    fake.failNext({ path: /\/v1\/environments/, status: 500, times: 10, message: "boom" });
    const error = await client.getEnvironment("env_x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagedAgentsApiError);
    expect(error).toMatchObject({ status: 500, errorType: "api_error", retryable: true });
    expect(fake.requests).toHaveLength(4);
  });

  it("does not retry 4xx and exposes status and API error type", async () => {
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    const error = await client.getSession("sesn_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagedAgentsApiError);
    expect(error).toMatchObject({ status: 404, errorType: "not_found_error", retryable: false });
    expect((error as ManagedAgentsApiError).requestId).toMatch(/^req_/);
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry the event stream", async () => {
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    fake.failNext({ path: /\/events\/stream$/, status: 503 });
    const iterate = async () => {
      for await (const _ of client.streamEvents("sesn_any")) {
        // no-op
      }
    };
    await expect(iterate()).rejects.toMatchObject({ status: 503 });
    expect(fake.requests).toHaveLength(1);
  });

  it("never includes the API key in thrown messages", async () => {
    const wrongKey = "sk-ant-wrong-secret-key-abcdef";
    const badClient = new ManagedAgentsClient({ apiKey: wrongKey, baseUrl: fake.baseUrl, sleep: noSleep });
    const authError = (await badClient.getAgent("agent_x").catch((e: unknown) => e)) as ManagedAgentsApiError;
    expect(authError).toMatchObject({ status: 401, errorType: "authentication_error" });
    expect(authError.message).not.toContain(wrongKey);
    expect(String(authError.stack)).not.toContain(wrongKey);

    // A server that echoes the key in its error message is redacted.
    const client = new ManagedAgentsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: noSleep });
    fake.failNext({ status: 400, message: `bad key ${fake.apiKey}` });
    const echoed = (await client.getAgent("agent_x").catch((e: unknown) => e)) as ManagedAgentsApiError;
    expect(echoed.message).toContain("[redacted]");
    expect(echoed.message).not.toContain(fake.apiKey);

    // Connection failures are wrapped without the key either.
    const offline = new ManagedAgentsClient({
      apiKey: fake.apiKey,
      baseUrl: "http://127.0.0.1:1/v1",
      maxRetries: 0,
      sleep: noSleep,
    });
    const connError = (await offline.getAgent("agent_x").catch((e: unknown) => e)) as ManagedAgentsApiError;
    expect(connError).toMatchObject({ status: 0, errorType: "connection_error" });
    expect(connError.message).not.toContain(fake.apiKey);
  });

  it("never exposes the API key through JSON.stringify or util.inspect", () => {
    const secret = "sk-ant-serialization-secret-999";
    const client = new ManagedAgentsClient({ apiKey: secret, baseUrl: fake.baseUrl });
    expect(JSON.stringify(client)).not.toContain(secret);
    expect(JSON.stringify({ nested: { client } })).not.toContain(secret);
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(secret);
    expect(inspect({ client }, { depth: 10 })).not.toContain(secret);
    expect(Object.values(client).map(String).join(" ")).not.toContain(secret);
  });

  it("wraps an invalid JSON 2xx body in a redacted, truncated error", async () => {
    const client = new ManagedAgentsClient({
      apiKey: "sk-ant-json-secret",
      fetch: async () => new Response(`not json sk-ant-json-secret ${"x".repeat(500)}`, { status: 200 }),
    });
    const error = (await client.getAgent("agent_x").catch((e: unknown) => e)) as ManagedAgentsApiError;
    expect(error).toBeInstanceOf(ManagedAgentsApiError);
    expect(error).toMatchObject({ status: 200, errorType: "invalid_response" });
    expect(error.message).not.toContain("sk-ant-json-secret");
    expect(error.message.length).toBeLessThan(400);
  });

  it("rejects an empty API key up front", () => {
    expect(() => new ManagedAgentsClient({ apiKey: "  " })).toThrow(/API key/);
  });

  it("validates required headers in the fake server", async () => {
    const response = await fetch(`${fake.baseUrl}/agents`, { method: "POST", headers: { "x-api-key": fake.apiKey } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { startFakeMcpServer, type FakeMcpServer } from "../testing/fake-mcp-server.js";
import { buildToolName, mcpResultToToolContent, MAX_TOOL_NAME_LENGTH, ToolsProxy } from "./tools-proxy.js";

const TOKEN = "staples-run-token-abc123";
const servers: FakeMcpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(options: Parameters<typeof startFakeMcpServer>[0]) {
  const server = await startFakeMcpServer(options);
  servers.push(server);
  return server;
}

describe("buildToolName", () => {
  it("joins a server slug and the tool name with a double underscore", () => {
    expect(buildToolName("Staples assistant", "create_task", new Set())).toBe("staples-assistant__create_task");
  });

  it("sanitizes characters outside [a-zA-Z0-9_-]", () => {
    expect(buildToolName("Project Tools!", "files.read/v2", new Set())).toBe("project-tools__files_read_v2");
  });

  it("truncates long names to 64 characters with a hash suffix", () => {
    const name = buildToolName("a".repeat(40), "b".repeat(40), new Set());
    expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+_[0-9a-f]{8}$/);
    expect(buildToolName("a".repeat(40), "b".repeat(40), new Set())).toBe(name);
  });

  it("adds a hash suffix on collision and avoids reserved prefixes", () => {
    const taken = new Set(["x__tool"]);
    const second = buildToolName("x", "tool", taken);
    expect(second).not.toBe("x__tool");
    expect(second).toMatch(/^x__tool_[0-9a-f]{8}$/);
    expect(buildToolName("mcp", "tool", new Set())).toBe("s-mcp__tool");
    expect(buildToolName("ant", "tool", new Set()).startsWith("ant__")).toBe(false);
  });
});

describe("mcpResultToToolContent", () => {
  it("caps large results with a note", () => {
    const out = mcpResultToToolContent({ content: [{ type: "text", text: "x".repeat(500) }] }, 100);
    expect(out.truncated).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text.startsWith("x".repeat(100))).toBe(true);
    expect(text).toContain("truncated this tool result: 500 characters");
  });

  it("falls back to structuredContent and keeps isError", () => {
    const out = mcpResultToToolContent({ content: [], structuredContent: { a: 1 }, isError: true });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toBe('{"a":1}');
  });
});

describe("ToolsProxy", () => {
  it("lists and calls tools over JSON responses with the bearer token", async () => {
    const mcp = await start({
      token: TOKEN,
      tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { msg: { type: "string" } } }, handler: (args) => ({ content: [{ type: "text", text: `echo:${String(args.msg)}` }] }) }],
    });
    const proxy = await ToolsProxy.discover([{ name: "Staples tools", url: mcp.url, token: TOKEN }]);
    expect(proxy.definitions()).toEqual([
      expect.objectContaining({ type: "custom", name: "staples-tools__echo", input_schema: { type: "object", properties: { msg: { type: "string" } } } }),
    ]);
    const result = await proxy.call("staples-tools__echo", { msg: "hi" });
    expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: "echo:hi" }] });
    expect(mcp.calls()).toEqual([{ name: "echo", arguments: { msg: "hi" } }]);
    expect(mcp.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(mcp.requests.every((r) => String(r.headers.accept).includes("text/event-stream"))).toBe(true);
  });

  it("scrubs the run token from successful tool results", async () => {
    const mcp = await start({
      token: TOKEN,
      tools: [{ name: "headers", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: `authorization: Bearer ${TOKEN}` }], structuredContent: { token: TOKEN } }) }],
    });
    const proxy = await ToolsProxy.discover([{ name: "Staples tools", url: mcp.url, token: TOKEN }]);
    const result = await proxy.call("staples-tools__headers", {});
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.content).toEqual([{ type: "text", text: "authorization: Bearer [redacted]" }]);
    expect(result.preview).toBe("authorization: Bearer [redacted]");
  });

  it("handles SSE responses and Streamable HTTP sessions", async () => {
    const mcp = await start({ token: TOKEN, sse: true, sessions: true, tools: [{ name: "ping", handler: () => ({ content: [{ type: "text", text: "pong" }] }) }] });
    const proxy = await ToolsProxy.discover([{ name: "gw", url: mcp.url, token: TOKEN }]);
    expect(proxy.definitions().map((d) => d.name)).toEqual(["gw__ping"]);
    expect(await proxy.call("gw__ping", {})).toMatchObject({ isError: false, content: [{ text: "pong" }] });
    const methods = mcp.requests.map((r) => r.body?.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(mcp.requests.slice(2).every((r) => r.headers["mcp-session-id"] === "fake-mcp-session")).toBe(true);
  });

  it("works with stateless servers that do not implement initialize", async () => {
    const mcp = await start({ token: TOKEN, noInitialize: true, tools: [{ name: "a" }] });
    const proxy = await ToolsProxy.discover([{ name: "s", url: mcp.url, token: TOKEN }]);
    expect(proxy.definitions().map((d) => d.name)).toEqual(["s__a"]);
  });

  it("returns tool failures as tool errors instead of throwing", async () => {
    const mcp = await start({ token: TOKEN, tools: [{ name: "boom", handler: () => { throw new Error("kaput"); } }] });
    const proxy = await ToolsProxy.discover([{ name: "s", url: mcp.url, token: TOKEN }]);
    const result = await proxy.call("s__boom", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("kaput");
    const unknown = await proxy.call("nope", {});
    expect(unknown.isError).toBe(true);
  });

  it("skips a server whose token is rejected, with a warning that hides the token", async () => {
    const good = await start({ token: TOKEN, tools: [{ name: "ok" }] });
    const bad = await start({ token: "other-token", tools: [{ name: "hidden" }] });
    const warnings: string[] = [];
    const proxy = await ToolsProxy.discover(
      [
        { name: "bad", url: bad.url, token: TOKEN },
        { name: "good", url: good.url, token: TOKEN },
      ],
      { onWarning: (m) => void warnings.push(m) },
    );
    expect(proxy.definitions().map((d) => d.name)).toEqual(["good__ok"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"bad"');
    expect(warnings.join("")).not.toContain(TOKEN);
    expect(JSON.stringify(proxy)).not.toContain(TOKEN);
  });
});

describe("ToolsProxy.discover with a rejected run token", () => {
  it("skips an optional server that rejects the run token, with a warning", async () => {
    const mcp = await start({ token: "right", tools: [] });
    const warnings: string[] = [];
    const proxy = await ToolsProxy.discover(
      [{ name: "Other tools", url: mcp.url, token: "wrong", connectionId: "c1" }],
      { onWarning: (m) => { warnings.push(m); } },
    );
    expect(proxy.definitions()).toEqual([]);
    expect(warnings[0]).toMatch(/Skipping tools from "Other tools".*HTTP 401/);
  });

  it("fails discovery when a required server rejects the run token", async () => {
    const mcp = await start({ token: "right", tools: [] });
    await expect(ToolsProxy.discover(
      [{ name: "Staples assistant", url: mcp.url, token: "wrong", connectionId: "staples-assistant-tools", required: true }],
    )).rejects.toMatchObject({ name: "RequiredToolServerError", serverName: "Staples assistant" });
  });
});

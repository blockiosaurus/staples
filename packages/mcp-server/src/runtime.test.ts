import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createRuntimeToolDefinitions, listRuntimeTools, RUNTIME_EXCLUDED_TOOL_NAMES, RUNTIME_READ_ONLY_TOOL_NAMES } from "./runtime.js";
import { createToolDefinitions } from "./tools.js";

const client = new PaperclipApiClient({ apiUrl: "http://localhost:3100/api", apiKey: "k", companyId: null, agentId: null, runId: null });

describe("runtime tool set", () => {
  it("keeps the issue, comment, document, approval and question tools and drops local-only ones", () => {
    const names = createRuntimeToolDefinitions(client).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "paperclipGetIssue", "paperclipUpdateIssue", "paperclipAddComment", "paperclipGetDocument",
      "paperclipUpsertIssueDocument", "paperclipCreateApproval", "paperclipAskUserQuestions", "paperclipApiRequest",
    ]));
    for (const excluded of RUNTIME_EXCLUDED_TOOL_NAMES) expect(names).not.toContain(excluded);
    // `paperclip__<tool>` must fit the 64-character custom tool name limit.
    for (const name of names) expect(`paperclip__${name}`.length).toBeLessThanOrEqual(64);
  });

  it("lists plain JSON Schema object inputs without $schema or uuid regexes", () => {
    const tools = listRuntimeTools(createRuntimeToolDefinitions(client));
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe("object");
    const text = JSON.stringify(tools);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("[0-9a-fA-F]{8}-");
    expect(tools.find((tool) => tool.name === "paperclipGetIssue")?.inputSchema).toMatchObject({
      properties: { issueId: { type: "string" } }, required: ["issueId"],
    });
    // Keep the hosted tool set's schema payload bounded.
    expect(text.length).toBeLessThan(80_000);
  });
});

describe("read-only runtime tool set", () => {
  it("keeps only reads: no writes, interactions, decisions or paperclipApiRequest", () => {
    const names = createRuntimeToolDefinitions(client, { readOnly: true }).map((tool) => tool.name);
    expect(new Set(names)).toEqual(RUNTIME_READ_ONLY_TOOL_NAMES);
    for (const write of [
      "paperclipCreateIssue", "paperclipUpdateIssue", "paperclipAddComment", "paperclipUpsertIssueDocument",
      "paperclipAskUserQuestions", "paperclipCreateApproval", "paperclipApprovalDecision", "paperclipCheckoutIssue",
      "paperclipApiRequest",
    ]) expect(names).not.toContain(write);
  });
});

describe("API path guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  const hostile = [
    "/https://attacker.example/x",
    "/\\attacker.example/x",
    "//attacker.example/x",
    "/http:/\\attacker.example/x",
    "/ht\ttps://attacker.example/x",
    "/issues/%2e%2e/%2e%2e/x",
    "/issues/../../x",
  ];

  it.each(hostile)("paperclipApiRequest refuses %j without any fetch", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = createToolDefinitions(client).find((t) => t.name === "paperclipApiRequest")!;
    const result = await tool.execute({ method: "GET", path });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(hostile)("requestJson refuses %j before any fetch or transport call", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = vi.fn();
    await expect(client.requestJson("GET", path)).rejects.toThrow();
    await expect(new PaperclipApiClient({ apiUrl: "http://127.0.0.1:3100/api", apiKey: "k", companyId: null, agentId: null, runId: null }, transport).requestJson("GET", path)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends a valid path through the transport relative to the API base", async () => {
    const transport = vi.fn(async (): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { ok: true } }));
    const viaTransport = new PaperclipApiClient({ apiUrl: "http://paperclip.internal/api", apiKey: "k", companyId: null, agentId: null, runId: "r1" }, transport);
    await expect(viaTransport.requestJson("POST", "/issues/a%20b/comments?x=1", { body: { body: "hi" } })).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: "/issues/a%20b/comments?x=1", body: { body: "hi" } }));
    transport.mockResolvedValueOnce({ status: 404, body: { error: "Not found" } });
    await expect(viaTransport.requestJson("GET", "/issues/x")).rejects.toMatchObject({ status: 404 });
  });
});

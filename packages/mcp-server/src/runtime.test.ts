import { describe, expect, it } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createRuntimeToolDefinitions, listRuntimeTools, RUNTIME_EXCLUDED_TOOL_NAMES } from "./runtime.js";

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

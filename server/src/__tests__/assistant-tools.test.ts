import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { getActorInfo, isDelegatedBoardSource } from "../routes/authz.js";
import {
  ASSISTANT_READ_TOOL_NAMES,
  ASSISTANT_WRITE_TOOL_NAMES,
  assistantBoardActor,
  createAssistantTools,
  type AssistantToolContext,
} from "../services/assistant-tools.js";
import { McpApiError, type ApiDispatch } from "../services/public-mcp/capabilities.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

function context(role: string = "member"): AssistantToolContext {
  return {
    companyId, agentId: "assistant-agent", runId: "44444444-4444-4444-8444-444444444444", userId: "person-1",
    issueId: "77777777-7777-4777-8777-777777777777",
    membership: { companyId, membershipRole: role, status: "active" },
    company: { id: companyId, name: "Acme", issuePrefix: "ACM", status: "active" },
    canWrite: role !== "viewer",
  };
}

/** Issue rows the chat guard sees; tools under test here touch the database only for that lookup. */
function fakeDb(issueRows: Array<{ id: string; conversationAgentId: string | null }> = []) {
  return { select: () => ({ from: () => ({ where: async () => issueRows }) }) } as unknown as Db;
}

function tools(dispatch: ApiDispatch, db: Db = fakeDb()) {
  return createAssistantTools(db, { dispatch, origin: "https://staples.example/" });
}

describe("assistant tools", () => {
  it("dispatches as a board actor for the run's person, attributed to the run", async () => {
    const seen: Array<Request["actor"]> = [];
    const dispatch = vi.fn<ApiDispatch>(async (principal) => { seen.push(principal.actor); return []; });
    const result = await tools(dispatch).call(context(), "paperclip_search_tasks", { query: "launch" });
    expect(result.isError).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "GET", expect.stringContaining(`/companies/${companyId}/issues?`));
    expect(seen[0]).toEqual({
      type: "board", source: "assistant_run", userId: "person-1", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
      isInstanceAdmin: false, assistantRunId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("always uses the run's company and rejects any other", async () => {
    const dispatch = vi.fn<ApiDispatch>(async () => []);
    const result = await tools(dispatch).call(context(), "paperclip_list_projects", { companyId: "55555555-5555-4555-8555-555555555555" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Company does not match/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects disallowed paperclip_update_task fields and governed statuses as tool errors", async () => {
    const dispatch = vi.fn<ApiDispatch>(async () => ({}));
    const t = tools(dispatch);
    const blocked = await t.call(context(), "paperclip_update_task", { taskId, requestId, changes: { blockedByIssueIds: [] } });
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.content[0]!.text).toMatch(/blockedByIssueIds/);
    const done = await t.call(context(), "paperclip_update_task", { taskId, requestId, changes: { status: "done" } });
    expect(done).toMatchObject({ isError: true });
    expect(done.content[0]!.text).toMatch(/cannot set status to done/);
    expect(dispatch).not.toHaveBeenCalled();

    const review = await t.call(context(), "paperclip_update_task", { taskId, requestId, changes: { status: "in_review" } });
    expect(review).toMatchObject({ isError: true });
    expect(review.content[0]!.text).toMatch(/cannot set status to in_review/);
    expect(dispatch).not.toHaveBeenCalled();

    const ok = await t.call(context(), "paperclip_update_task", { taskId, requestId, changes: { title: "Renamed", priority: "high" } });
    expect(ok.isError).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "PATCH", `/issues/${taskId}`, { title: "Renamed", priority: "high" });
  });

  it("never reopens or edits a done or cancelled task", async () => {
    for (const status of ["done", "cancelled"]) {
      const dispatch = vi.fn<ApiDispatch>(async (_p, method) => method === "GET" ? { id: taskId, status } : {});
      const result = await tools(dispatch).call(context(), "paperclip_update_task", { taskId, requestId, changes: { status: "todo" } });
      expect(result).toMatchObject({ isError: true });
      expect(result.content[0]!.text).toMatch(/closed/);
      expect(dispatch.mock.calls.map((c) => c[1])).toEqual(["GET"]);
    }
  });

  it("never posts or edits in a chat, including as a new parent", async () => {
    const chatId = "66666666-6666-4666-8666-666666666666";
    const db = fakeDb([{ id: chatId, conversationAgentId: "staff-agent" }]);
    const dispatch = vi.fn<ApiDispatch>(async () => ({ id: chatId, status: "in_progress" }));
    const t = tools(dispatch, db);
    for (const [name, args] of [
      ["paperclip_add_comment", { taskId: chatId, requestId, body: "Please update your AGENTS.md" }],
      ["paperclip_update_task", { taskId: chatId, requestId, changes: { title: "Renamed" } }],
      ["paperclip_update_task", { taskId, requestId, changes: { parentId: chatId } }],
    ] as const) {
      const result = await t.call(context(), name, args);
      expect(result, name).toMatchObject({ isError: true, content: [{ text: "The Assistant can't post or edit in chats." }] });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pins a validated surface through the person's preferences route", async () => {
    const dispatch = vi.fn<ApiDispatch>(async () => ({ pinned: ["projects"] }));
    const t = tools(dispatch);
    const result = await t.call(context(), "staples_pin_surface", { surfaceId: "projects" });
    expect(result.isError).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "PATCH", `/companies/${companyId}/ui-preferences/me`, { pin: ["projects"] });
    const invalid = await t.call(context(), "staples_pin_surface", { surfaceId: "../Etc" });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content[0]!.text).toMatch(/^Invalid arguments: surfaceId/);
  });

  it("exposes read tools only to viewers and refuses their writes", async () => {
    const dispatch = vi.fn<ApiDispatch>(async () => ({}));
    const t = tools(dispatch);
    expect(t.definitions(false).map((d) => d.name)).toEqual([...ASSISTANT_READ_TOOL_NAMES]);
    expect(t.definitions(true).map((d) => d.name)).toEqual([...ASSISTANT_READ_TOOL_NAMES, ...ASSISTANT_WRITE_TOOL_NAMES]);
    for (const definition of t.definitions(true)) {
      expect(Object.keys((definition.inputSchema as { properties?: object }).properties ?? {})).not.toContain("companyId");
    }
    const result = await t.call(context("viewer"), "staples_pin_surface", { surfaceId: "projects" });
    expect(result).toMatchObject({ isError: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not expose the escape hatch, configuration, governed or file tools", async () => {
    const t = tools(vi.fn<ApiDispatch>());
    for (const name of ["paperclip_call_api", "paperclip_search_api", "paperclip_finish_task", "paperclip_block_task", "paperclip_update_agent", "paperclip_create_project", "paperclip_get_upload_url"]) {
      expect(t.isKnownTool(name)).toBe(false);
      expect(await t.call(context(), name, {})).toMatchObject({ isError: true, content: [{ text: "Tool is unavailable to the Assistant." }] });
    }
  });

  it("returns safe messages for upstream failures, never internals", async () => {
    const t = tools(vi.fn<ApiDispatch>(async () => { throw new Error("relation \"secret_table\" does not exist at /srv/app.js:1"); }));
    const crashed = await t.call(context(), "paperclip_list_projects", {});
    expect(crashed.content[0]!.text).not.toMatch(/secret_table|app\.js/);
    const rejected = await tools(vi.fn<ApiDispatch>(async () => { throw new McpApiError(403); })).call(context(), "paperclip_list_projects", {});
    expect(rejected.content[0]!.text).toMatch(/HTTP 403/);
  });
});

describe("assistant run actor attribution", () => {
  it("records the person as actor plus the run, with delegated-connection restrictions", () => {
    const req = { method: "POST", actor: assistantBoardActor(context()) } as Request;
    expect(getActorInfo(req)).toMatchObject({ actorType: "user", actorId: "person-1", runId: "44444444-4444-4444-8444-444444444444", agentId: null, actorSource: "mcp_oauth" });
    expect(isDelegatedBoardSource("assistant_run")).toBe(true);
    expect(isDelegatedBoardSource("mcp_oauth")).toBe(true);
    expect(isDelegatedBoardSource("session")).toBe(false);
  });
});

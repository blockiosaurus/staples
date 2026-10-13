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
const create = vi.hoisted(() => vi.fn());
vi.mock("../services/issue-thread-interactions.js", () => ({ issueThreadInteractionService: () => ({ create }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
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

describe("assistant template tools", () => {
  it("lists non-preview templates and reads one with the person's and company's names resolved", async () => {
    const t = tools(vi.fn<ApiDispatch>(), { select: () => ({ from: () => ({ where: async () => [{ name: "Acme" }] }) }) } as unknown as Db);
    expect(ASSISTANT_READ_TOOL_NAMES).toEqual(expect.arrayContaining(["staples_list_templates", "staples_get_template"]));
    expect(t.definitions(false).map((d) => d.name)).toEqual(expect.arrayContaining(["staples_list_templates", "staples_get_template"]));
    const listed = await t.call(context("viewer"), "staples_list_templates", {});
    expect(listed.isError).toBeUndefined();
    const templates = (listed.structuredContent as { templates: Array<{ ref: string; preview?: boolean }> }).templates;
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((x) => x.ref.startsWith("staples/") && x.preview !== true)).toBe(true);
    const read = await t.call(context(), "staples_get_template", { ref: templates[0]!.ref });
    expect(read.isError).toBeUndefined();
    const detail = (read.structuredContent as { template: { ref: string; setupQuestions: unknown[] } }).template;
    expect(detail.ref).toBe(templates[0]!.ref);
    expect(JSON.stringify(detail)).not.toMatch(/\{\{(person|company)\./);
    const missing = await t.call(context(), "staples_get_template", { ref: "staples/does-not-exist" });
    expect(missing.isError).toBe(true);
  });

  it("describes templated hires and optional tasks on the plan tool", () => {
    const plan = tools(vi.fn<ApiDispatch>()).definitions(true).find((d) => d.name === "staples_propose_plan")!;
    expect(plan.description).toMatch(/0 to 25 tasks/);
    expect(plan.description).toMatch(/templateRef/);
    expect(plan.description).toMatch(/templateAnswers/);
  });
});

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

  it("tells the Assistant its own adapter and engine in paperclip_connection, never its config", async () => {
    const { withBuiltInAgentMarker } = await import("../lib/built-in-agent-metadata.js");
    const results = [
      [{ agentId: "assistant-agent" }],
      [{ id: "assistant-agent", metadata: withBuiltInAgentMarker({}, { key: "assistant", featureKeys: [] }) }],
      [{ adapterType: "codex_local", adapterConfig: { engine: "cli", env: { OPENAI_API_KEY: "sk-secret" } } }],
    ];
    const db = { select: () => ({ from: () => ({ where: async () => results.shift() ?? [] }) }) } as unknown as Db;
    const result = await tools(vi.fn<ApiDispatch>(), db).call(context(), "paperclip_connection", {});
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).assistant).toMatchObject({ adapterType: "codex_local", engine: "cli" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("sk-secret");
  });

  it("always uses the run's company and rejects any other", async () => {
    const dispatch = vi.fn<ApiDispatch>(async () => []);
    const result = await tools(dispatch).call(context(), "paperclip_list_projects", { companyId: "55555555-5555-4555-8555-555555555555" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Company does not match/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is proposal-only: no tool changes tasks, comments, answers or pins directly", async () => {
    expect([...ASSISTANT_WRITE_TOOL_NAMES]).toEqual(["staples_propose_action", "staples_ask_questions", "staples_propose_plan"]);
    const dispatch = vi.fn<ApiDispatch>(async () => ({}));
    const t = tools(dispatch);
    const names = t.definitions(true).map((d) => d.name);
    const direct = [
      ["paperclip_create_task", { requestId, title: "Draft", description: "", assigneeAgentId: taskId }],
      ["paperclip_update_task", { taskId, requestId, changes: { title: "Renamed" } }],
      ["paperclip_add_comment", { taskId, requestId, body: "hi" }],
      ["staples_answer_question", { issueId: taskId, interactionId: requestId, answers: [{ questionId: "q1", optionIds: ["yes"] }] }],
      ["staples_pin_surface", { surfaceId: "projects" }],
    ] as const;
    for (const [name, args] of direct) {
      expect(names, name).not.toContain(name);
      expect(t.isKnownTool(name), name).toBe(false);
      const result = await t.call(context(), name, args);
      expect(result, name).toMatchObject({ isError: true, content: [{ text: "Tool is unavailable to the Assistant." }] });
    }
    expect(dispatch).not.toHaveBeenCalled();
    // The proposal tool documents the task work it can put in front of the person.
    const propose = t.definitions(true).find((d) => d.name === "staples_propose_action")!;
    for (const route of ["/api/companies/<companyId>/issues", "PATCH /api/issues/<id>", "/api/issues/<id>/comments", "/respond", "ui-preferences/me"]) {
      expect(propose.description).toContain(route);
    }
  });

  it("reads the company brief; brief edits are governed proposals, not a direct write tool", async () => {
    const brief = { body: "Mission", revisionId: requestId, revisionNumber: 1, updatedAt: "2026-10-11T00:00:00.000Z" };
    const dispatch = vi.fn<ApiDispatch>(async () => brief);
    const t = tools(dispatch);
    expect(ASSISTANT_READ_TOOL_NAMES).toContain("staples_get_company_brief");
    const read = await t.call(context(), "staples_get_company_brief", {});
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toEqual({ brief });
    expect(dispatch).toHaveBeenLastCalledWith(expect.anything(), "GET", `/companies/${companyId}/brief`);

    dispatch.mockClear();
    expect(t.isKnownTool("staples_update_company_brief")).toBe(false);
    expect(await t.call(context(), "staples_update_company_brief", { body: "Mission v2" }))
      .toMatchObject({ isError: true, content: [{ text: "Tool is unavailable to the Assistant." }] });
    expect(dispatch).not.toHaveBeenCalled();
    const propose = t.definitions(true).find((d) => d.name === "staples_propose_action")!;
    expect(propose.description).toMatch(/company brief/i);
  });

  it("reads the briefing as the acting person through the briefing route, company-scoped", async () => {
    const briefing = { items: [{ id: "i1", title: "Approve hire" }] };
    const seen: Array<Request["actor"]> = [];
    const dispatch = vi.fn<ApiDispatch>(async (principal) => { seen.push(principal.actor); return briefing; });
    const t = tools(dispatch);
    expect(ASSISTANT_READ_TOOL_NAMES).toContain("staples_get_briefing");
    expect(t.definitions(false).map((d) => d.name)).toContain("staples_get_briefing");
    const read = await t.call(context("viewer"), "staples_get_briefing", {});
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toEqual({ briefing });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "GET", `/companies/${companyId}/briefing`);
    expect(seen[0]).toMatchObject({ type: "board", userId: "person-1", companyIds: [companyId] });
    const other = await t.call(context(), "staples_get_briefing", { companyId: "99999999-9999-4999-8999-999999999999" });
    expect(other).toMatchObject({ isError: true });
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

describe("staples_ask_questions", () => {
  const issueRow = {
    id: "77777777-7777-4777-8777-777777777777", companyId, status: "in_progress", assigneeAgentId: "assistant-agent",
    conversationAgentId: "assistant-agent", conversationUserId: "person-1",
  };
  /** First select is the conversation issue, the second the Assistant's pending question cards. */
  const askDb = (pending: unknown[] = [], issue: Record<string, unknown> = issueRow) => {
    let call = 0;
    return { select: () => ({ from: () => ({ where: async () => (call++ === 0 ? [issue] : pending) }) }) } as unknown as Db;
  };
  const questions = [{
    id: "owner", prompt: "Should I assign this to Riley?", required: true, answerMode: "single_select",
    options: [{ id: "yes", label: "Yes, Riley", recommended: true }, { id: "no", label: "Someone else" }],
  }];

  it("is a write tool hidden from viewers", () => {
    const t = tools(vi.fn() as unknown as ApiDispatch);
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("staples_ask_questions");
    // The weekly update is saved only by its routine run, never from a chat.
    expect(ASSISTANT_WRITE_TOOL_NAMES).not.toContain("staples_save_weekly_update");
    expect(t.definitions(true).some((d) => d.name === "staples_ask_questions")).toBe(true);
    expect(t.definitions(false).some((d) => d.name === "staples_ask_questions")).toBe(false);
  });

  it("creates an Assistant-authored question card addressed to the person", async () => {
    create.mockResolvedValueOnce({ id: "int-1", issueId: issueRow.id, kind: "ask_user_questions", status: "pending" });
    const t = tools(vi.fn() as unknown as ApiDispatch, askDb());
    const result = await t.call(context(), "staples_ask_questions", { title: "Quick check", questions });
    expect(result.isError).toBeUndefined();
    const [, data, actor] = create.mock.calls[0];
    expect(actor).toEqual({ agentId: "assistant-agent", runId: context().runId });
    expect(data).toMatchObject({
      kind: "ask_user_questions", addresseeUserId: "person-1", continuationPolicy: "wake_assignee", sourceRunId: context().runId,
    });
    expect(data.idempotencyKey).toMatch(new RegExp(`^assistant-questions:${context().runId}:[0-9a-f]{16,}$`));
    expect(data.payload.questionSet).toMatchObject({ schema: "paperclip.question_set.v1", title: "Quick check" });
    expect(data.payload.questions[0].id).toBe("owner");
  });

  it("surfaces missing recommendations as a tool error listing the question ids", async () => {
    create.mockRejectedValueOnce(Object.assign(new Error("Every question needs a recommended option"), {
      status: 422, details: { code: "question_recommendation_required", questionIds: ["owner", "when"] },
    }));
    const t = tools(vi.fn() as unknown as ApiDispatch, askDb());
    const result = await t.call(context(), "staples_ask_questions", { questions });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("owner, when");
    expect(result.content[0].text).toContain("recommended");
  });

  it("refuses a second card while one is pending, but replays the same ask", async () => {
    const pending = { id: "int-0", issueId: issueRow.id, status: "pending", idempotencyKey: "other" };
    const blocked = await tools(vi.fn() as unknown as ApiDispatch, askDb([pending])).call(context(), "staples_ask_questions", { questions });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("still waiting for the person");

    create.mockResolvedValueOnce({ id: "int-1", issueId: issueRow.id, kind: "ask_user_questions", status: "pending" });
    await tools(vi.fn() as unknown as ApiDispatch, askDb()).call(context(), "staples_ask_questions", { title: "T", questions });
    const key = create.mock.calls.at(-1)![1].idempotencyKey as string;
    create.mockClear();
    const replay = await tools(vi.fn() as unknown as ApiDispatch, askDb([{ ...pending, idempotencyKey: key }])).call(context(), "staples_ask_questions", { title: "T", questions });
    expect(replay.isError).toBeUndefined();
    expect(replay.structuredContent).toMatchObject({ interaction: { id: "int-0" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("includes the title in the idempotency key", async () => {
    create.mockResolvedValue({ id: "int-1", issueId: issueRow.id, kind: "ask_user_questions", status: "pending" });
    create.mockClear();
    const t = tools(vi.fn() as unknown as ApiDispatch);
    await createWith(t, "A");
    await createWith(t, "B");
    expect(create.mock.calls[0][1].idempotencyKey).not.toBe(create.mock.calls[1][1].idempotencyKey);
    async function createWith(tt: ReturnType<typeof tools>, title: string) {
      const db = askDb();
      await createAssistantTools(db, { dispatch: vi.fn() as unknown as ApiDispatch }).call(context(), "staples_ask_questions", { title, questions });
    }
  });

  it("errors when the conversation is not assigned to the Assistant", async () => {
    const result = await tools(vi.fn() as unknown as ApiDispatch, askDb([], { ...issueRow, assigneeAgentId: "someone-else" }))
      .call(context(), "staples_ask_questions", { questions });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not assigned to the Assistant");
  });

  it("refuses viewers and rejects more than 8 questions", async () => {
    const t = tools(vi.fn() as unknown as ApiDispatch, askDb());
    expect((await t.call(context("viewer"), "staples_ask_questions", { questions })).isError).toBe(true);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...questions[0], id: `q${i}` }));
    expect((await t.call(context(), "staples_ask_questions", { questions: many })).isError).toBe(true);
  });
});

describe("staples_propose_plan", () => {
  it("is a write tool hidden from viewers, with the plan schema as input", () => {
    const t = tools(vi.fn() as unknown as ApiDispatch);
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("staples_propose_plan");
    const definition = t.definitions(true).find((d) => d.name === "staples_propose_plan");
    expect(definition?.inputSchema).toMatchObject({ required: expect.arrayContaining(["plan", "summary"]) });
    expect(JSON.stringify(definition?.inputSchema)).not.toContain("companyId");
    expect(definition?.description).toMatch(/never ceo/);
    expect(t.definitions(false).some((d) => d.name === "staples_propose_plan")).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueRelations,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import type { AttentionFeed, AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { briefingRoutes } from "../routes/briefing.js";
import {
  agentActionsTitle,
  askUserQuestionsRecommendation,
  briefingService,
  companyRelativeHref,
  interactionTitle,
  RECOMMENDATION_LABEL_MAX,
  requestConfirmationRecommendation,
} from "../services/briefing.js";

import {
  budgetIncidentCopy,
  failureCause,
  failureReason,
  suggestedBudgetCents,
} from "../services/briefing-reasons.js";
import { budgetService } from "../services/budgets.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("briefing failure reasons", () => {
  it.each([
    [{ errorCode: "claude_managed_out_of_credit", error: "Needs attention: the Anthropic account is out of credit." }, "out_of_credit"],
    [{ error: "This agent reached its monthly hosted inference limit (Claude hosted on the Staples server's key)." }, "hosted_limit"],
    [{ error: "This company reached its monthly spending cap for hosted inference (Claude hosted on the Staples server's key)." }, "hosted_limit"],
    [{ error: "Available budget is reserved by unfinished runs" }, "budget_reached"],
    [{ errorCode: "binding_missing", error: "Tool binding missing" }, "not_connected"],
    [{ errorCode: "claude_managed_api_key_missing" }, "not_connected"],
    [{ errorCode: "hosted_limit_reached", error: "anything" }, "hosted_limit"],
    [{ errorCode: "budget_reached" }, "budget_reached"],
    [{ errorCode: "adapter_failed", agentPaused: true, agentPauseReason: "budget" }, "budget_reached"],
    [{ error: "Agent is paused because its budget hard-stop was reached." }, "budget_reached"],
    [{ errorCode: "agent_not_invokable", error: "Cancelled: agent not invokable at execution-start" }, "agent_paused"],
    // Mentions of budgets, credit or connections that are not enforcement stay unknown.
    [{ errorCode: "adapter_failed", error: "budget.xlsx not found" }, "unknown"],
    [{ errorCode: "setup_failed", error: "Resolve unpriced usage or explicitly allow it in the budget policy before resuming" }, "unknown"],
    [{ errorCode: "adapter_failed", error: "Store credit API returned 500; please reconnect later" }, "unknown"],
    [{ errorCode: "adapter_failed", agentPaused: true }, "agent_paused"],
    [{ errorCode: "timeout" }, "timed_out"],
    [{ runStatus: "timed_out" }, "timed_out"],
    [{ errorCode: "adapter_failed", error: "Error: ENOENT at /tmp/x.js:12" }, "unknown"],
  ] as const)("classifies %o as %s", (input, cause) => {
    expect(failureCause(input)).toBe(cause);
  });

  it("writes plain, short sentences without internal terms", () => {
    for (const cause of ["out_of_credit", "hosted_limit", "budget_reached", "not_connected", "agent_paused", "timed_out", "unknown"] as const) {
      for (const kind of ["run", "agent"] as const) {
        const reason = failureReason(cause, "Riley", kind);
        expect(reason.length).toBeLessThanOrEqual(140);
        expect(reason).not.toMatch(/error_?code|adapter|heartbeat|errorFamily|run failed|_/i);
      }
    }
    expect(failureReason("hosted_limit", "Riley", "run")).toBe("Riley reached its monthly hosted limit, so it stopped.");
    expect(failureReason("unknown", "x".repeat(200), "run").length).toBe(140);
  });

  it("suggests twice the limit, always above what was spent", () => {
    expect(suggestedBudgetCents(5000, 5100)).toBe(10000);
    expect(suggestedBudgetCents(5000, 12000)).toBe(12100);
    expect(suggestedBudgetCents(0, 0)).toBe(100);
  });

  it("words hosted and spending budget incidents plainly", () => {
    const base = {
      incidentId: "i1", policyId: "p1", scopeType: "agent" as const, scopeId: "a1", scopeName: "Riley",
      thresholdType: "hard", amountLimit: 5000, amountObserved: 5012, observedPercent: 100,
    };
    expect(budgetIncidentCopy({ ...base, metric: "hosted_billed_cents" }, "Acme")).toEqual({
      title: "Riley reached its monthly hosted limit",
      reason: "Riley spent $50.12 of its $50 monthly hosted limit. Its hosted runs are on hold until you raise it.",
    });
    expect(budgetIncidentCopy({ ...base, metric: "billed_cents", scopeType: "company", scopeId: "c1", thresholdType: "soft", observedPercent: 87.4 }, "Acme"))
      .toEqual({ title: "Acme is close to its budget", reason: "Your company has used 87% of its $50 budget." });
  });
});

describe("briefing recommendation derivation", () => {
  it("recommends the single recommended option of a lone single-select question", () => {
    expect(askUserQuestionsRecommendation({
      version: 1,
      questions: [{
        id: "team",
        prompt: "Which team?",
        selectionMode: "single",
        options: [
          { id: "dev", label: "Developers", recommended: true },
          { id: "ops", label: "Operations" },
          { id: "other", label: "Something else", freeText: true },
        ],
      }],
    })).toEqual({ label: "Developers", inline: true, answers: [{ questionId: "team", optionIds: ["dev"] }] });
  });

  it("recommends every recommended option of a multi-select question", () => {
    expect(askUserQuestionsRecommendation({
      version: 1,
      questions: [{
        id: "langs",
        prompt: "Languages?",
        selectionMode: "multi",
        options: [
          { id: "ts", label: "TypeScript", recommended: true },
          { id: "go", label: "Go" },
          { id: "py", label: "Python", recommended: true },
        ],
      }],
    })).toEqual({ label: "TypeScript, Python", inline: true, answers: [{ questionId: "langs", optionIds: ["ts", "py"] }] });
  });

  it("uses initialText for text questions and counts recommendations across a question set", () => {
    const questionSet = {
      schema: "paperclip.question_set.v1",
      questions: [
        {
          id: "name",
          prompt: "Product name?",
          required: true,
          answerMode: "text",
          initialText: "Staples",
        },
        {
          id: "tier",
          prompt: "Tier?",
          required: true,
          answerMode: "single_select",
          options: [{ id: "pro", label: "Pro", recommended: true }, { id: "free", label: "Free" }],
        },
        {
          id: "regions",
          prompt: "Regions?",
          required: false,
          answerMode: "multi_select",
          options: [{ id: "us", label: "US", recommended: true }, { id: "eu", label: "EU", recommended: true }],
        },
      ],
    };
    expect(askUserQuestionsRecommendation({ version: 1, questions: [], questionSet })).toEqual({
      label: "Staples · Pro · US, EU",
      inline: true,
      answers: [
        { questionId: "name", text: "Staples" },
        { questionId: "tier", optionIds: ["pro"] },
        { questionId: "regions", optionIds: ["us", "eu"] },
      ],
    });
    expect(askUserQuestionsRecommendation({
      version: 1,
      questions: [],
      questionSet: { ...questionSet, questions: [questionSet.questions[0]] },
    })).toEqual({ label: "Staples", inline: true, answers: [{ questionId: "name", text: "Staples" }] });
  });

  it("clips a long multi-question label to 60 characters", () => {
    const options = (word: string) => [{ id: word, label: `${word} with a fairly long recommended answer`, recommended: true }];
    const recommendation = askUserQuestionsRecommendation({
      version: 1,
      questions: ["alpha", "beta", "gamma"].map((word) => ({ id: word, prompt: `${word}?`, selectionMode: "single", options: options(word) })),
    });
    expect(recommendation?.inline).toBe(true);
    expect(recommendation?.label.length).toBe(RECOMMENDATION_LABEL_MAX);
    expect(recommendation?.label.endsWith("…")).toBe(true);
    expect(recommendation?.label.startsWith("alpha with a fairly long recommended answer · beta")).toBe(true);
  });

  it("titles interactions by what they actually ask", () => {
    const question = (id: string, prompt: string) => ({ id, prompt, selectionMode: "single", options: [] });
    expect(interactionTitle("ask_user_questions", { version: 1, questions: [question("a", "Which team?")] })).toBe("Which team?");
    expect(interactionTitle("ask_user_questions", {
      version: 1,
      questions: [question("a", "Which team?"), question("b", "When?"), question("c", "Budget?")],
    })).toBe("Which team? (+2 more)");
    expect(interactionTitle("ask_user_questions", { version: 1, title: "Launch plan", questions: [question("a", "Which team?")] }))
      .toBe("Launch plan");
    expect(interactionTitle("ask_user_questions", {
      version: 1,
      questions: [],
      questionSet: { schema: "paperclip.question_set.v1", title: "Setup", questions: [{ id: "x", prompt: "X?", required: true, answerMode: "text" }] },
    })).toBe("Setup");
    expect(interactionTitle("ask_user_questions", {
      version: 1,
      questions: [],
      questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "x", prompt: "Name   the\nproduct?", required: true, answerMode: "text" }] },
    })).toBe("Name the product?");
    expect(interactionTitle("request_confirmation", { version: 1, prompt: "Ship the release?" })).toBe("Ship the release?");
    expect(interactionTitle("request_confirmation", { version: 1, prompt: "x".repeat(300) })?.length).toBe(120);
    expect(interactionTitle("ask_user_questions", { version: 1, questions: [] })).toBeNull();
    expect(interactionTitle("request_confirmation", {})).toBeNull();
  });

  it("is not inline when any question lacks a recommendation", () => {
    expect(askUserQuestionsRecommendation({
      version: 1,
      questions: [
        {
          id: "a",
          prompt: "A?",
          selectionMode: "single",
          options: [{ id: "a1", label: "No hint" }, { id: "a2", label: "Also no hint" }],
        },
        {
          id: "b",
          prompt: "B?",
          selectionMode: "single",
          options: [{ id: "b1", label: "Blue", recommended: true }, { id: "b2", label: "Red" }],
        },
      ],
    })).toEqual({ label: "Blue", inline: false });
    expect(askUserQuestionsRecommendation({
      version: 1,
      questionSet: {
        schema: "paperclip.question_set.v1",
        questions: [{ id: "t", prompt: "Say something", required: true, answerMode: "text" }],
      },
      questions: [],
    })).toBeUndefined();
    expect(askUserQuestionsRecommendation({ version: 1, questions: [] })).toBeUndefined();
  });

  it("only offers inline confirmation without a server-owned flow", () => {
    expect(requestConfirmationRecommendation({ version: 1, prompt: "Ship?" }))
      .toEqual({ label: "Confirm", inline: true, accept: true });
    expect(requestConfirmationRecommendation({ version: 1, prompt: "Ship?", acceptLabel: "Ship it" }))
      .toEqual({ label: "Ship it", inline: true, accept: true });
    expect(requestConfirmationRecommendation({ version: 1, prompt: "Run?", proposedAction: { kind: "x" } }))
      .toEqual({ label: "Review", inline: false });
    expect(requestConfirmationRecommendation({ version: 1, prompt: "Run?", acceptLabel: "Run", toolAction: {} }))
      .toEqual({ label: "Run", inline: false });
    expect(requestConfirmationRecommendation({ version: 1, prompt: "Store?", secretProposal: {} }))
      .toEqual({ label: "Review", inline: false });
  });

  it("strips the company prefix from hrefs", () => {
    expect(companyRelativeHref("/BRF/issues/BRF-1#interaction-1", "BRF")).toBe("/issues/BRF-1#interaction-1");
    expect(companyRelativeHref("/BRF/costs", "BRF")).toBe("/costs");
    expect(companyRelativeHref("/BRFX/costs", "BRF")).toBe("/BRFX/costs");
    expect(companyRelativeHref(null, "BRF")).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres briefing service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("briefing service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-briefing-service-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(toolInvocations);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(inboxDismissals);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string) {
    return {
      type: "board" as const,
      source: "local_implicit" as const,
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const errorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "Riley",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Broken Agent",
        role: "engineer",
        status: "error",
        errorReason: "adapter config missing",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, workerId, errorAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    updatedAt?: Date;
    completedAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
      completedAt: input.completedAt ?? null,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  it("maps attention sources, derives interaction recommendations and keeps company-relative hrefs", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("BRF");
    const questionIssueId = await insertIssue({
      companyId, identifier: "BRF-1", title: "Pick a team", status: "in_progress", assigneeAgentId: workerId,
    });
    const confirmIssueId = await insertIssue({
      companyId, identifier: "BRF-2", title: "Ship it", status: "in_progress", assigneeAgentId: workerId,
    });
    const proposedIssueId = await insertIssue({
      companyId, identifier: "BRF-3", title: "Run the tool", status: "in_progress", assigneeAgentId: workerId,
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Designer" },
    });
    const questionId = randomUUID();
    const confirmId = randomUUID();
    const proposedId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: questionId,
        companyId,
        issueId: questionIssueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: workerId,
        title: "Questions need answers",
        payload: {
          version: 1,
          questions: [
            {
              id: "team",
              prompt: "Which team?",
              selectionMode: "single",
              options: [{ id: "dev", label: "Developers", recommended: true }, { id: "ops", label: "Operations" }],
            },
            {
              id: "when",
              prompt: "Start this week?",
              selectionMode: "single",
              options: [{ id: "yes", label: "Yes", recommended: true }, { id: "no", label: "No" }],
            },
          ],
        },
      },
      {
        id: confirmId,
        companyId,
        issueId: confirmIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Confirmation requested",
        payload: { version: 1, prompt: "Ship the release?", acceptLabel: "Ship it" },
      },
      {
        id: proposedId,
        companyId,
        issueId: proposedIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Run the proposed action?",
        payload: { version: 1, prompt: "Run it?", proposedAction: { kind: "example" } },
      },
    ]);
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
    });
    const incidentId = randomUUID();
    await db.insert(budgetIncidents).values({
      id: incidentId,
      companyId,
      policyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "lifetime",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2027-01-01T00:00:00.000Z"),
      thresholdType: "hard",
      amountLimit: 100,
      amountObserved: 120,
      status: "open",
    });

    const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    const byId = new Map(briefing.needsYou.map((item) => [item.id, item]));

    expect(byId.get(approvalId)).toMatchObject({ kind: "approval", href: `/approvals/${approvalId}` });
    expect(byId.get(approvalId)?.recommendation).toBeUndefined();
    expect(byId.get(questionId)).toMatchObject({
      kind: "question",
      title: "Which team? (+1 more)",
      subtitle: "BRF-1 · Pick a team",
      issueId: questionIssueId,
      href: `/issues/BRF-1#interaction-${questionId}`,
      recommendation: {
        label: "Developers · Yes",
        inline: true,
        answers: [{ questionId: "team", optionIds: ["dev"] }, { questionId: "when", optionIds: ["yes"] }],
      },
    });
    expect(byId.get(confirmId)).toMatchObject({
      kind: "confirmation",
      title: "Ship the release?",
      subtitle: "BRF-2 · Ship it",
      issueId: confirmIssueId,
      recommendation: { label: "Ship it", inline: true, accept: true },
    });
    expect(byId.get(proposedId)).toMatchObject({
      kind: "confirmation",
      recommendation: { label: "Review", inline: false },
    });
    expect(byId.get(proposedId)?.recommendation?.accept).toBeUndefined();
    expect(byId.get(incidentId)).toMatchObject({ kind: "budget_incident", href: "/costs" });
    expect(byId.get(errorAgentId)).toMatchObject({ kind: "agent_error", href: `/agents/${errorAgentId}` });
    expect(briefing.needsYou.every((item) => !item.href.startsWith("/BRF/"))).toBe(true);
    expect(briefing.counts.needsYou).toBe(briefing.needsYou.length);
    const times = briefing.needsYou.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("maps every attention source kind and drops kinds outside the briefing", async () => {
    const { companyId } = await seedCompany("BRM");
    const issueSubject = (id: string, identifier: string) => ({
      kind: "issue", id, companyId, title: identifier, identifier, status: "blocked",
      href: `/BRM/issues/${identifier}`, metadata: {},
    });
    const blockedId = randomUUID();
    const reviewId = randomUUID();
    const runIssueId = randomUUID();
    const make = (sourceKind: AttentionSourceKind, subject: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      id: `${sourceKind}:${subject.id}`,
      sourceKind,
      subject,
      whyNow: "why",
      relatedIssue: null,
      originAgentName: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      ...extra,
    }) as unknown as AttentionItem;
    const items: AttentionItem[] = [
      make("blocker_attention", issueSubject(blockedId, "BRM-1")),
      make("review", issueSubject(reviewId, "BRM-2"), { originAgentName: "Riley" }),
      make("failed_run", {
        kind: "run", id: "run-1", companyId, title: "Riley run failed", identifier: null, status: "failed",
        href: "/BRM/agents/a1/runs/run-1", metadata: { issueId: runIssueId },
      }, { relatedIssue: issueSubject(runIssueId, "BRM-3") }),
      make("decision", { kind: "decision", id: "d1", companyId, title: "Decide", identifier: null, status: "open", href: "/BRM/decisions?decisionId=d1", metadata: {} }),
      make("join_request", { kind: "join_request", id: "j1", companyId, title: "Join", identifier: null, status: "pending", href: "/BRM/settings/access", metadata: {} }),
      make("recovery_action", { kind: "recovery_action", id: "r1", companyId, title: "Recover", identifier: null, status: "open", href: null, metadata: {} }),
    ];
    const feed = { items } as unknown as AttentionFeed;

    const briefing = await briefingService(db, { attention: { list: async () => feed } })
      .get({ companyId, userId: "board-user", actor: boardActor(companyId) });

    expect(briefing.needsYou.map((item) => [item.kind, item.id])).toEqual([
      ["blocked_task", blockedId],
      ["review", reviewId],
      ["failed_run", "run-1"],
    ]);
    expect(briefing.needsYou[0]).toMatchObject({ href: "/issues/BRM-1", issueId: blockedId });
    expect(briefing.needsYou[1]).toMatchObject({ subtitle: "BRM-2 · Riley" });
    expect(briefing.needsYou[2]).toMatchObject({ href: "/agents/a1/runs/run-1", issueId: runIssueId, subtitle: "BRM-3" });
    expect(briefing.counts.needsYou).toBe(3);
  });

  it("lists live runs before in-progress tasks and recently done tasks within seven days", async () => {
    const { companyId, workerId } = await seedCompany("BRP");
    const now = Date.now();
    const liveIssueId = await insertIssue({
      companyId, identifier: "BRP-1", title: "Being worked live", status: "in_progress", assigneeAgentId: workerId,
    });
    const activeIssueId = await insertIssue({
      companyId, identifier: "BRP-2", title: "Waiting for the next run", status: "in_progress", assigneeAgentId: workerId,
    });
    const doneRecentId = await insertIssue({
      companyId, identifier: "BRP-3", title: "Shipped yesterday", status: "done", assigneeAgentId: workerId,
      completedAt: new Date(now - DAY_MS), updatedAt: new Date(now - DAY_MS),
    });
    const doneNewestId = await insertIssue({
      companyId, identifier: "BRP-4", title: "Shipped an hour ago", status: "done",
      completedAt: new Date(now - 60 * 60 * 1000), updatedAt: new Date(now - 60 * 60 * 1000),
    });
    // Touched recently but completed long ago: excluded by completedAt.
    await insertIssue({
      companyId, identifier: "BRP-5", title: "Old done, recently edited", status: "done",
      completedAt: new Date(now - 8 * DAY_MS), updatedAt: new Date(now - 60 * 1000),
    });
    await insertIssue({
      companyId, identifier: "BRP-6", title: "Old done", status: "done",
      completedAt: new Date(now - 10 * DAY_MS), updatedAt: new Date(now - 10 * DAY_MS),
    });
    const issueRunId = randomUUID();
    const companyRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: issueRunId, companyId, agentId: workerId, status: "running", scopeKind: "issue", issueId: liveIssueId, startedAt: new Date(now - 5000) },
      { id: companyRunId, companyId, agentId: workerId, status: "queued" },
      { id: randomUUID(), companyId, agentId: workerId, status: "succeeded", scopeKind: "issue", issueId: activeIssueId },
    ]);

    const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });

    const liveRuns = briefing.inProgress.filter((item) => item.kind === "live_run");
    expect(briefing.inProgress.slice(0, 2).map((item) => item.kind)).toEqual(["live_run", "live_run"]);
    expect(liveRuns.find((item) => item.id === issueRunId)).toMatchObject({
      title: "Being worked live",
      subtitle: "BRP-1 · Riley",
      href: "/issues/BRP-1",
      issueId: liveIssueId,
    });
    expect(liveRuns.find((item) => item.id === companyRunId)).toMatchObject({
      title: "Riley",
      href: `/agents/${workerId}`,
      issueId: null,
    });
    const activeTasks = briefing.inProgress.filter((item) => item.kind === "active_task");
    expect(activeTasks.map((item) => item.id)).toEqual([activeIssueId]);
    expect(activeTasks[0]).toMatchObject({ title: "Waiting for the next run", subtitle: "BRP-2 · Riley", href: "/issues/BRP-2" });
    expect(briefing.counts.inProgress).toBe(3);

    expect(briefing.doneRecently.map((item) => item.id)).toEqual([doneNewestId, doneRecentId]);
    expect(briefing.doneRecently[1]).toMatchObject({ kind: "done_task", subtitle: "BRP-3 · Riley", href: "/issues/BRP-3" });
    expect(briefing.counts.doneRecently).toBe(2);
  });

  it("keeps conversation, hidden and filtered-out issues out of live runs and dedupes issue-less runs per agent", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("BRV");
    const now = Date.now();
    const visibleIssueId = await insertIssue({
      companyId, identifier: "BRV-1", title: "Real work", status: "in_progress", assigneeAgentId: workerId,
    });
    const ownChatId = randomUUID();
    const otherChatId = randomUUID();
    const hiddenIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: ownChatId, companyId, identifier: "BRV-2", title: "My private chat with the assistant", status: "in_progress",
        priority: "medium", assigneeAgentId: workerId, conversationAgentId: workerId, conversationUserId: "board-user",
        conversationState: "active", originKind: "manual", originFingerprint: "default",
      },
      {
        id: otherChatId, companyId, identifier: "BRV-3", title: "Another member's chat", status: "in_progress",
        priority: "medium", assigneeAgentId: errorAgentId, conversationAgentId: errorAgentId, conversationUserId: "other-user",
        conversationState: "active", originKind: "manual", originFingerprint: "default",
      },
      {
        id: hiddenIssueId, companyId, identifier: "BRV-4", title: "Hidden harness work", status: "in_progress",
        priority: "medium", assigneeAgentId: workerId, hiddenAt: new Date(), originKind: "manual", originFingerprint: "default",
      },
    ]);
    const visibleRunId = randomUUID();
    const issueLessNewestId = randomUUID();
    const issueLessOlderId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: visibleRunId, companyId, agentId: workerId, status: "running", scopeKind: "issue", issueId: visibleIssueId, createdAt: new Date(now - 5000) },
      { id: randomUUID(), companyId, agentId: workerId, status: "running", scopeKind: "issue", issueId: ownChatId, createdAt: new Date(now - 4000) },
      { id: randomUUID(), companyId, agentId: errorAgentId, status: "running", scopeKind: "issue", issueId: otherChatId, createdAt: new Date(now - 3000) },
      { id: randomUUID(), companyId, agentId: workerId, status: "queued", scopeKind: "issue", issueId: hiddenIssueId, createdAt: new Date(now - 2000) },
      { id: issueLessNewestId, companyId, agentId: workerId, status: "queued", createdAt: new Date(now - 1000) },
      { id: issueLessOlderId, companyId, agentId: workerId, status: "running", createdAt: new Date(now - 6000) },
    ]);

    // An instance admin reads every issue, yet still never sees anyone's chats.
    const adminActor = { ...boardActor(companyId), source: "session" as const, isInstanceAdmin: true };
    for (const actor of [boardActor(companyId), adminActor]) {
      const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor });
      const serialized = JSON.stringify(briefing);
      for (const hidden of ["My private chat", "Another member's chat", "Hidden harness work", ownChatId, otherChatId, hiddenIssueId]) {
        expect(serialized).not.toContain(hidden);
      }
      const liveRuns = briefing.inProgress.filter((item) => item.kind === "live_run");
      expect(liveRuns.map((item) => item.id)).toEqual([issueLessNewestId, visibleRunId]);
      expect(liveRuns[0]).toMatchObject({ title: "Riley", href: `/agents/${workerId}`, issueId: null });
      expect(liveRuns.some((item) => item.title === "Broken Agent")).toBe(false);
      expect(briefing.inProgress.filter((item) => item.kind === "active_task")).toEqual([]);
      expect(briefing.counts.inProgress).toBe(2);
    }
  });

  it("never shows the title of an issue the person cannot read in an interaction subtitle", async () => {
    const { companyId, workerId } = await seedCompany("BRU");
    const privateIssueId = randomUUID();
    await db.insert(issues).values({
      id: privateIssueId, companyId, identifier: "BRU-1", title: "Secret acquisition plan", status: "in_progress",
      priority: "medium", assigneeAgentId: workerId, visibility: "private", createdByUserId: "someone-else",
      originKind: "manual", originFingerprint: "default",
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId: privateIssueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Go ahead?" },
    });
    const feed = {
      items: [{
        id: `issue_thread_interaction:${interactionId}`,
        sourceKind: "issue_thread_interaction",
        subject: {
          kind: "interaction", id: interactionId, companyId, title: "Confirm", identifier: null, status: "pending",
          href: `/BRU/issues/BRU-1#interaction-${interactionId}`, metadata: {},
        },
        whyNow: "why",
        relatedIssue: null,
        originAgentName: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      }],
    } as unknown as AttentionFeed;
    const memberActor = { ...boardActor(companyId), source: "session" as const };

    const briefing = await briefingService(db, { attention: { list: async () => feed } })
      .get({ companyId, userId: "board-user", actor: memberActor });

    expect(briefing.needsYou.map((item) => item.id)).toEqual([interactionId]);
    expect(JSON.stringify(briefing)).not.toContain("Secret acquisition plan");
  });

  it("caps each section while counts stay uncapped", async () => {
    const { companyId, workerId } = await seedCompany("BRC");
    const now = Date.now();
    await db.insert(approvals).values(Array.from({ length: 22 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: `Hire ${index}` },
      createdAt: new Date(now - index * 60_000),
      updatedAt: new Date(now - index * 60_000),
    })));
    for (let index = 0; index < 25; index += 1) {
      await insertIssue({
        companyId, identifier: `BRC-${index + 1}`, title: `Active ${index}`, status: "in_progress", assigneeAgentId: workerId,
      });
    }
    for (let index = 0; index < 12; index += 1) {
      await insertIssue({
        companyId, identifier: `BRC-${index + 100}`, title: `Done ${index}`, status: "done",
        completedAt: new Date(now - (index + 1) * 60 * 60 * 1000), updatedAt: new Date(now - (index + 1) * 60 * 60 * 1000),
      });
    }

    const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });

    expect(briefing.needsYou).toHaveLength(20);
    // 22 approvals plus the errored agent.
    expect(briefing.counts.needsYou).toBe(23);
    expect(briefing.inProgress).toHaveLength(20);
    expect(briefing.counts.inProgress).toBe(25);
    expect(briefing.doneRecently).toHaveLength(10);
    expect(briefing.counts.doneRecently).toBe(12);
  });

  it("keeps another company's items out of the briefing", async () => {
    const own = await seedCompany("BRO");
    const other = await seedCompany("BRX");
    const otherApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: otherApprovalId, companyId: other.companyId, type: "hire_agent", status: "pending", payload: { title: "Other hire" },
    });
    const otherActiveId = await insertIssue({
      companyId: other.companyId, identifier: "BRX-1", title: "Other active", status: "in_progress", assigneeAgentId: other.workerId,
    });
    const otherDoneId = await insertIssue({
      companyId: other.companyId, identifier: "BRX-2", title: "Other done", status: "done", completedAt: new Date(),
    });
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: other.companyId, agentId: other.workerId, status: "running" });
    const ownActiveId = await insertIssue({
      companyId: own.companyId, identifier: "BRO-1", title: "Own active", status: "in_progress",
    });

    const briefing = await briefingService(db).get({
      companyId: own.companyId, userId: "board-user", actor: boardActor(own.companyId),
    });

    const serialized = JSON.stringify(briefing);
    for (const foreignId of [otherApprovalId, otherActiveId, otherDoneId, otherRunId, other.errorAgentId]) {
      expect(serialized).not.toContain(foreignId);
    }
    expect(briefing.inProgress.map((item) => item.id)).toEqual([ownActiveId]);
    expect(briefing.needsYou.map((item) => item.id)).toEqual([own.errorAgentId]);
  });

  describe("spend", () => {
    const spend = async (companyId: string, agentId: string, cents: number, options: { hosted?: boolean; occurredAt?: Date } = {}) => {
      await db.insert(costEvents).values({ companyId, agentId, provider: "anthropic", biller: "anthropic", billingType: "metered_api",
        model: "claude", costCents: cents, occurredAt: options.occurredAt ?? new Date(), hostedInference: options.hosted ?? false });
    };
    const policy = (companyId: string, metric: string, amount: number, isActive = true) => db.insert(budgetPolicies).values({
      companyId, scopeType: "company", scopeId: companyId, metric, windowKind: "calendar_month_utc", amount, hardStopEnabled: true, isActive,
    });

    it("reports this month's spend with no limits when the company has no budgets", async () => {
      const { companyId, workerId } = await seedCompany("BSP");
      await spend(companyId, workerId, 1200);
      // Last month's spend does not count.
      const now = new Date();
      await spend(companyId, workerId, 9999, { occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - DAY_MS) });
      const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
      expect(briefing.spend).toEqual({ monthSpendCents: 1200, companyBudgetCents: null, hosted: null });
    });

    it("adds the company budget and the hosted cap with its hosted-only usage", async () => {
      const { companyId, workerId } = await seedCompany("BSQ");
      await spend(companyId, workerId, 1200);
      await spend(companyId, workerId, 800, { hosted: true });
      await policy(companyId, "billed_cents", 9000);
      await policy(companyId, "hosted_billed_cents", 5000);
      const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
      expect(briefing.spend).toEqual({ monthSpendCents: 2000, companyBudgetCents: 9000, hosted: { capCents: 5000, spentCents: 800 } });
    });

    it("ignores disabled budgets and keeps other companies' spend out", async () => {
      const own = await seedCompany("BSR");
      const other = await seedCompany("BSS");
      await spend(own.companyId, own.workerId, 300);
      await spend(other.companyId, other.workerId, 5000);
      await policy(own.companyId, "billed_cents", 9000, false);
      const briefing = await briefingService(db).get({ companyId: own.companyId, userId: "board-user", actor: boardActor(own.companyId) });
      expect(briefing.spend).toEqual({ monthSpendCents: 300, companyBudgetCents: null, hosted: null });
    });

    it("asks for a company-scope read of this company before showing spend", async () => {
      const { companyId } = await seedCompany("BSU");
      const asked: Array<{ action: string; resource: unknown; actor: unknown }> = [];
      const authorization = { decide: async (input: { action: string; resource: unknown; actor: unknown }) => { asked.push(input); return { allowed: true }; } };
      const actor = boardActor(companyId);
      const briefing = await briefingService(db, { authorization: authorization as never }).get({ companyId, userId: "board-user", actor });
      expect(asked.filter((entry) => entry.action === "company_scope:read")).toEqual([
        { action: "company_scope:read", resource: { type: "company", companyId }, actor },
      ]);
      expect(briefing.spend).not.toBeNull();
    });

    it("is null when the person may not read the company's costs", async () => {
      const { companyId } = await seedCompany("BST");
      const authorization = { decide: async (input: { action: string }) => ({ allowed: input.action !== "company_scope:read" }) };
      const briefing = await briefingService(db, { authorization: authorization as never }).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
      expect(briefing.spend).toBeNull();
    });
  });

  describe("templated agent roll-ups", () => {
    const EMAIL_TEMPLATE = {
      ref: "staples/email-secretary",
      version: "1.0.1",
      readOnly: false,
      outwardActions: [{
        capability: "email", label: "Sending email", destructiveLabel: "Deleting email",
        toolPatterns: ["*send*", "*reply*", "*forward*"], destructiveToolPatterns: ["*delete*", "*trash*"],
      }],
      requiredApps: [{ capability: "email", anyOf: ["agentmail", "gmail"], why: "Email." }],
    };
    const CODING_TEMPLATE = {
      ref: "staples/coding-agent",
      version: "1.0.1",
      readOnly: false,
      outwardActions: [{
        capability: "code", label: "Merging and pushing to the default branch", destructiveLabel: "Deleting branches or closing issues",
        toolPatterns: ["*merge*", "*push*"], destructiveToolPatterns: ["*delete*", "*close*"],
      }],
      requiredApps: [{ capability: "code", anyOf: ["github"], why: "Code." }],
    };

    async function insertTemplatedAgent(companyId: string, name: string, template: Record<string, unknown>) {
      const id = randomUUID();
      await db.insert(agents).values({
        id, companyId, name, role: "general", status: "idle", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {}, metadata: { staplesTemplate: template },
      });
      return id;
    }

    async function insertConnection(companyId: string, slug: string) {
      const [application] = await db.insert(toolApplications).values({
        companyId, applicationKey: `app-gallery:${slug}:${randomUUID()}`, name: slug, type: "mcp_http", status: "active",
        metadata: { sourceTemplateKey: slug },
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId, applicationId: application!.id, name: `${slug} connection`, uid: `test/${randomUUID()}`,
        transport: "mcp_remote", status: "active", enabled: true, config: { sourceTemplateKey: slug },
      }).returning();
      return connection!.id;
    }

    async function insertInvocation(input: {
      companyId: string; agentId: string; connectionId: string | null; toolName: string;
      riskLevel?: string; status?: string; completedAt: Date;
    }) {
      await db.insert(toolInvocations).values({
        companyId: input.companyId,
        agentId: input.agentId,
        connectionId: input.connectionId,
        toolName: input.toolName,
        riskLevel: (input.riskLevel ?? "write") as "write",
        status: (input.status ?? "succeeded") as "succeeded",
        actorType: "agent",
        completedAt: input.completedAt,
        createdAt: input.completedAt,
      });
    }

    it("words the roll-up by category", () => {
      expect(agentActionsTitle("Sam", 3, new Set(["email"]), ["AgentMail"])).toBe("Sam sent 3 emails");
      expect(agentActionsTitle("Sam", 1, new Set(["email"]), ["AgentMail"])).toBe("Sam sent 1 email");
      expect(agentActionsTitle("Cody", 2, new Set(["code"]), ["GitHub", "GitHub"])).toBe("Cody took 2 actions in GitHub");
      expect(agentActionsTitle("Pat", 4, new Set(["email", "social"]), ["AgentMail", "X"])).toBe("Pat took 4 actions in AgentMail and X");
    });

    it("counts each templated agent's succeeded outward write actions in the last 24 hours", async () => {
      const { companyId, workerId } = await seedCompany("BRT");
      const now = Date.now();
      const secretaryId = await insertTemplatedAgent(companyId, "Sam", EMAIL_TEMPLATE);
      const coderId = await insertTemplatedAgent(companyId, "Cody", CODING_TEMPLATE);
      const quietId = await insertTemplatedAgent(companyId, "Quiet", EMAIL_TEMPLATE);
      const mail = await insertConnection(companyId, "agentmail");
      const github = await insertConnection(companyId, "github");
      const hourAgo = new Date(now - 60 * 60 * 1000);
      for (const toolName of ["send_message", "reply_to_message", "forward_message"]) {
        await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName, completedAt: hourAgo });
      }
      // Not counted: failed, read-risk, destructive name, unrelated write, older than 24 hours.
      await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName: "send_message", status: "failed", completedAt: hourAgo });
      await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName: "send_preview", riskLevel: "read", completedAt: hourAgo });
      await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName: "trash_and_send", completedAt: hourAgo });
      await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName: "create_label", completedAt: hourAgo });
      await insertInvocation({ companyId, agentId: secretaryId, connectionId: mail, toolName: "send_message", completedAt: new Date(now - 25 * 60 * 60 * 1000) });
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
      await insertInvocation({ companyId, agentId: coderId, connectionId: github, toolName: "merge_pull_request", completedAt: twoHoursAgo });
      await insertInvocation({ companyId, agentId: coderId, connectionId: github, toolName: "push_files", completedAt: twoHoursAgo });
      // Untemplated agents never get a roll-up.
      await insertInvocation({ companyId, agentId: workerId, connectionId: mail, toolName: "send_message", completedAt: hourAgo });
      // Quiet only has a failed send: no row.
      await insertInvocation({ companyId, agentId: quietId, connectionId: mail, toolName: "send_message", status: "failed", completedAt: hourAgo });
      const doneId = await insertIssue({
        companyId, identifier: "BRT-1", title: "Shipped", status: "done",
        completedAt: new Date(now - 90 * 60 * 1000), updatedAt: new Date(now - 90 * 60 * 1000),
      });

      const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });

      expect(briefing.doneRecently.map((item) => [item.kind, item.id])).toEqual([
        ["agent_actions", secretaryId],
        ["done_task", doneId],
        ["agent_actions", coderId],
      ]);
      expect(briefing.doneRecently[0]).toMatchObject({
        title: "Sam sent 3 emails", subtitle: "Last 24 hours", href: `/agents/${secretaryId}`, createdAt: hourAgo.toISOString(),
      });
      expect(briefing.doneRecently[2]).toMatchObject({ title: "Cody took 2 actions in GitHub", href: `/agents/${coderId}` });
      expect(briefing.counts.doneRecently).toBe(3);
    });

    it("uses a rolling 24-hour window by completion time", async () => {
      const { companyId } = await seedCompany("BRW");
      const now = Date.parse("2026-10-11T12:00:00.000Z");
      const since = now - 24 * 60 * 60 * 1000;
      const agentId = await insertTemplatedAgent(companyId, "Sam", EMAIL_TEMPLATE);
      const mail = await insertConnection(companyId, "agentmail");
      async function insertAt(createdAt: number, completedAt: number | null) {
        await db.insert(toolInvocations).values({
          companyId, agentId, connectionId: mail, toolName: "send_message", riskLevel: "write", status: "succeeded",
          actorType: "agent", createdAt: new Date(createdAt), completedAt: completedAt === null ? null : new Date(completedAt),
        });
      }
      await insertAt(since + 60_000, since + 60_000); // just inside
      await insertAt(since - 30 * 60_000, since + 5 * 60_000); // created before, completed inside (within slack)
      await insertAt(since + 2 * 60_000, null); // no completion time: created inside
      await insertAt(since - 60_000, since - 60_000); // just outside
      await insertAt(since - 60_000, null); // created outside, never completed

      const briefing = await briefingService(db, { now: () => now }).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
      expect(briefing.doneRecently.map((item) => item.title)).toEqual(["Sam sent 3 emails"]);
      expect(briefing.doneRecently[0]!.createdAt).toBe(new Date(since + 5 * 60_000).toISOString());
    });

    it("leaves out a templated agent the person may not read, per agent", async () => {
      const { companyId } = await seedCompany("BRY");
      const now = new Date(Date.now() - 60_000);
      const shownId = await insertTemplatedAgent(companyId, "Shown", EMAIL_TEMPLATE);
      const hiddenId = await insertTemplatedAgent(companyId, "Hidden", EMAIL_TEMPLATE);
      const mail = await insertConnection(companyId, "agentmail");
      for (const agentId of [shownId, hiddenId]) {
        await insertInvocation({ companyId, agentId, connectionId: mail, toolName: "send_message", completedAt: now });
      }
      const asked: string[] = [];
      const authorization = {
        decide: async (input: { action: string; resource: { type: string; agentId?: string } }) => {
          asked.push(`${input.action}:${input.resource.agentId}`);
          return { allowed: input.resource.agentId !== hiddenId };
        },
      };
      const briefing = await briefingService(db, { authorization: authorization as never }).get({
        companyId, userId: "board-user", actor: boardActor(companyId),
      });
      expect(asked.filter((entry) => entry.startsWith("agent:read")).sort()).toEqual([`agent:read:${hiddenId}`, `agent:read:${shownId}`].sort());
      expect(briefing.doneRecently.map((item) => item.title)).toEqual(["Shown sent 1 email"]);
      expect(JSON.stringify(briefing)).not.toContain(hiddenId);
    });

    it("keeps other companies' agents and agents the person cannot see out of the roll-up", async () => {
      const own = await seedCompany("BRU");
      const other = await seedCompany("BRV");
      const now = new Date(Date.now() - 60 * 1000);
      const otherAgentId = await insertTemplatedAgent(other.companyId, "Elsewhere", EMAIL_TEMPLATE);
      const otherMail = await insertConnection(other.companyId, "agentmail");
      await insertInvocation({ companyId: other.companyId, agentId: otherAgentId, connectionId: otherMail, toolName: "send_message", completedAt: now });

      const ownBriefing = await briefingService(db).get({ companyId: own.companyId, userId: "board-user", actor: boardActor(own.companyId) });
      expect(ownBriefing.doneRecently).toEqual([]);
      expect(JSON.stringify(ownBriefing)).not.toContain(otherAgentId);

      const otherBriefing = await briefingService(db).get({ companyId: other.companyId, userId: "board-user", actor: boardActor(other.companyId) });
      expect(otherBriefing.doneRecently.map((item) => item.title)).toEqual(["Elsewhere sent 1 email"]);

      // An actor without access to the company sees no roll-up even if asked for it directly.
      const outsider = { type: "board" as const, source: "session" as const, userId: "outsider", companyIds: [], isInstanceAdmin: false };
      const hidden = await briefingService(db).get({ companyId: other.companyId, userId: "outsider", actor: outsider });
      expect(hidden.doneRecently.filter((item) => item.kind === "agent_actions")).toEqual([]);
    });
  });

  function feedItem(sourceKind: AttentionSourceKind, subject: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      id: `${sourceKind}:${subject.id}`,
      sourceKind,
      subject,
      whyNow: "why",
      relatedIssue: null,
      originAgentName: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      ...extra,
    } as unknown as AttentionItem;
  }

  it("gives each Needs you failure a plain reason and the fix for its cause", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("BRF");
    const pausedId = randomUUID();
    await db.insert(agents).values({
      id: pausedId, companyId, name: "Sam", role: "engineer", status: "paused", pauseReason: "manual",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const descriptorIssueId = randomUUID();
    const run = (id: string, agentId: string, agentName: string, metadata: Record<string, unknown>, status = "failed") =>
      feedItem("failed_run", {
        kind: "run", id, companyId, title: `${agentName} run ${status}`, identifier: null, status,
        href: `/BRF/agents/${agentId}/runs/${id}`, metadata: { agentId, agentName, issueId: null, ...metadata },
      });
    const hostedIncident = feedItem("budget_alert", {
      kind: "budget_incident", id: "incident-hosted", companyId, title: "Riley budget hard stop", identifier: null, status: "open",
      href: "/BRF/costs",
      metadata: {
        policyId: "policy-hosted", scopeType: "agent", scopeId: workerId, scopeName: "Riley", metric: "hosted_billed_cents",
        thresholdType: "hard", amountLimit: 5000, amountObserved: 5010, observedPercent: 100,
      },
    });
    const feed = {
      items: [
        run("run-credit", workerId, "Riley", { errorCode: "claude_managed_out_of_credit", error: "Needs attention: the Anthropic account is out of credit." }),
        run("run-hosted", workerId, "Riley", { error: "This agent reached its monthly hosted inference limit (Claude hosted on the Staples server's key)." }),
        run("run-budget", workerId, "Riley", { error: "Available budget is reserved by unfinished runs" }),
        run("run-connect", workerId, "Riley", { errorCode: "binding_missing", error: "binding missing" }),
        run("run-paused", pausedId, "Sam", { errorCode: "adapter_failed", error: "stopped" }),
        run("run-timeout", workerId, "Riley", { errorCode: "timeout" }, "timed_out"),
        run("run-unknown", workerId, "Riley", { errorCode: "adapter_failed", error: "TypeError: x is undefined at y.js:1" }),
        feedItem("agent_error_alert", {
          kind: "agent", id: errorAgentId, companyId, title: "Broken Agent", identifier: null, status: "error",
          href: `/BRF/agents/${errorAgentId}`, metadata: { role: "engineer", errorReason: "adapter config missing" },
        }),
        hostedIncident,
        feedItem("blocker_attention", {
          kind: "issue", id: randomUUID(), companyId, title: "BRF-9", identifier: "BRF-9", status: "blocked",
          href: "/BRF/issues/BRF-9", metadata: {},
        }, { whyNow: "Agent-written: please email bob@example.com", detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 2, images: [] } }),
        feedItem("blocker_attention", {
          kind: "issue", id: descriptorIssueId, companyId, title: "BRF-10", identifier: "BRF-10", status: "blocked",
          href: "/BRF/issues/BRF-10", metadata: {},
        }, { whyNow: "Agent-written descriptor text", detail: { kind: "blocker", blockingIssue: null, images: [] } }),
        feedItem("failed_run", {
          kind: "run", id: "run-nameless", companyId, title: "run failed", identifier: null, status: "failed",
          href: "/BRF/agents/x/runs/run-nameless", metadata: { errorCode: "adapter_failed" },
        }),
      ],
    } as unknown as AttentionFeed;

    const briefing = await briefingService(db, { attention: { list: async () => feed } })
      .get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    const byId = new Map(briefing.needsYou.map((item) => [item.id, item]));

    expect(byId.get("run-credit")).toMatchObject({
      title: "Riley couldn't finish its work",
      reason: "The AI account is out of credit. Add credit to the Anthropic account, then try again.",
      action: { kind: "retry_run", label: "Try again", agentId: workerId, runId: "run-credit" },
    });
    const raise = {
      kind: "raise_budget",
      label: "Raise limit",
      budget: {
        incidentId: "incident-hosted", policyId: "policy-hosted", metric: "hosted_billed_cents", scopeType: "agent",
        scopeId: workerId, limitCents: 5000, observedCents: 5010, suggestedCents: 10000,
      },
    };
    expect(byId.get("run-hosted")).toMatchObject({
      reason: "Riley reached its monthly hosted limit, so it stopped.",
      action: raise,
    });
    // No open spending incident to raise: link to the limits instead.
    expect(byId.get("run-budget")).toMatchObject({
      reason: "Riley reached its spending limit, so it stopped.",
      action: { kind: "open_settings", label: "Review limits", href: "/activity/costs" },
    });
    expect(byId.get("run-connect")).toMatchObject({
      reason: "A service Riley uses isn't connected. Reconnect it, then try again.",
      action: { kind: "open_settings", label: "Open settings", href: `/agents/${workerId}/tools` },
    });
    expect(byId.get("run-paused")).toMatchObject({
      reason: "Sam is paused, so it can't work.",
      action: { kind: "resume_agent", label: "Resume", agentId: pausedId },
    });
    expect(byId.get("run-timeout")).toMatchObject({
      reason: "Riley took too long and was stopped.",
      action: { kind: "retry_run", runId: "run-timeout" },
    });
    expect(byId.get("run-unknown")).toMatchObject({ reason: "Riley stopped with an error it couldn't recover from." });
    expect(byId.get("run-unknown")?.action).toBeUndefined();
    expect(JSON.stringify(byId.get("run-unknown"))).not.toContain("TypeError");
    expect(byId.get(errorAgentId)).toMatchObject({
      kind: "agent_error",
      reason: "Broken Agent hit an error and stopped.",
      action: { kind: "clear_agent_error", label: "Dismiss error", agentId: errorAgentId },
    });
    expect(byId.get("incident-hosted")).toMatchObject({
      kind: "budget_incident",
      title: "Riley reached its monthly hosted limit",
      reason: "Riley spent $50.10 of its $50 monthly hosted limit. Its hosted runs are on hold until you raise it.",
      action: raise,
    });
    expect(briefing.needsYou.find((item) => item.subtitle === "BRF-9")).toMatchObject({ reason: "Holds up 2 tasks until you step in." });
    expect(byId.get(descriptorIssueId)).toMatchObject({ reason: "This task is waiting on you to unblock it." });
    expect(JSON.stringify(briefing)).not.toContain("Agent-written");
    expect(byId.get("run-nameless")).toMatchObject({ title: "An agent couldn't finish its work" });
    expect(JSON.stringify(briefing)).not.toMatch(/run failed/);
    for (const item of briefing.needsYou) expect((item.reason ?? "").length).toBeLessThanOrEqual(140);
  });

  it("targets a real hosted incident's policy and metric, and resolving it raises that hosted limit", async () => {
    const { companyId, workerId } = await seedCompany("BRH");
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId, companyId, scopeType: "agent", scopeId: workerId, metric: "hosted_billed_cents",
      windowKind: "calendar_month_utc", amount: 5000,
    });
    const now = new Date();
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const incidentId = randomUUID();
    await db.insert(budgetIncidents).values({
      id: incidentId, companyId, policyId, scopeType: "agent", scopeId: workerId, metric: "hosted_billed_cents",
      windowKind: "calendar_month_utc", windowStart, windowEnd, thresholdType: "hard", amountLimit: 5000,
      amountObserved: 5000, status: "open",
    });

    const briefing = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    const item = briefing.needsYou.find((entry) => entry.id === incidentId);
    expect(item).toMatchObject({
      kind: "budget_incident",
      title: "Riley reached its monthly hosted limit",
      action: { kind: "raise_budget", budget: { policyId, metric: "hosted_billed_cents", scopeType: "agent", scopeId: workerId, limitCents: 5000, suggestedCents: 10000 } },
    });

    await budgetService(db).resolveIncident(companyId, incidentId, {
      action: "raise_budget_and_resume", amount: item!.action!.budget!.suggestedCents,
    }, "board-user");
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policyId));
    expect(policy).toMatchObject({ amount: 10000, metric: "hosted_billed_cents" });
    const [incident] = await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incidentId));
    expect(incident?.status).toBe("resolved");
    const after = await briefingService(db).get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    expect(after.needsYou.some((entry) => entry.id === incidentId)).toBe(false);
  });

  it("lists up-next and waiting tasks in progress, once each, and skips blocked tasks that need the person", async () => {
    const { companyId, workerId } = await seedCompany("BRQ");
    const liveTodoId = await insertIssue({ companyId, identifier: "BRQ-1", title: "Queued with a live run", status: "todo", assigneeAgentId: workerId });
    const upNextId = await insertIssue({ companyId, identifier: "BRQ-2", title: "Write the launch post", status: "todo", assigneeAgentId: workerId });
    await insertIssue({ companyId, identifier: "BRQ-3", title: "Nobody owns this", status: "todo" });
    const blockerId = await insertIssue({ companyId, identifier: "BRQ-4", title: "Pick the domain", status: "in_progress", assigneeAgentId: workerId });
    const doneBlockerId = await insertIssue({ companyId, identifier: "BRQ-5", title: "Old finished blocker", status: "done", completedAt: new Date() });
    const waitingId = await insertIssue({ companyId, identifier: "BRQ-6", title: "Publish the site", status: "blocked", assigneeAgentId: workerId });
    const needsPersonId = await insertIssue({ companyId, identifier: "BRQ-7", title: "Needs a decision", status: "blocked", assigneeAgentId: workerId });
    const noBlockerId = await insertIssue({ companyId, identifier: "BRQ-8", title: "Blocked without a link", status: "blocked" });
    await db.insert(issueRelations).values([
      { companyId, issueId: blockerId, relatedIssueId: waitingId, type: "blocks" },
      { companyId, issueId: doneBlockerId, relatedIssueId: noBlockerId, type: "blocks" },
    ]);
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId: workerId, status: "queued", scopeKind: "issue", issueId: liveTodoId });
    const feed = {
      items: [feedItem("blocker_attention", {
        kind: "issue", id: needsPersonId, companyId, title: "Needs a decision", identifier: "BRQ-7", status: "blocked",
        href: "/BRQ/issues/BRQ-7", metadata: {},
      })],
    } as unknown as AttentionFeed;

    const briefing = await briefingService(db, { attention: { list: async () => feed } })
      .get({ companyId, userId: "board-user", actor: boardActor(companyId) });

    expect(briefing.inProgress.map((item) => item.kind))
      .toEqual(["live_run", "active_task", "queued_task", "waiting_task", "waiting_task"]);
    expect(briefing.inProgress.map((item) => item.issueId).slice(0, 3)).toEqual([liveTodoId, blockerId, upNextId]);
    expect(new Set(briefing.inProgress.slice(3).map((item) => item.issueId))).toEqual(new Set([waitingId, noBlockerId]));
    expect(briefing.inProgress.find((item) => item.issueId === upNextId)).toMatchObject({ label: "Up next", subtitle: "BRQ-2 · Riley" });
    expect(briefing.inProgress.find((item) => item.issueId === waitingId)).toMatchObject({ label: "Waiting on Pick the domain" });
    expect(briefing.inProgress.find((item) => item.issueId === noBlockerId)).toMatchObject({ label: "Waiting" });
    expect(briefing.inProgress.some((item) => item.issueId === needsPersonId)).toBe(false);
    expect(briefing.needsYou.map((item) => item.issueId)).toEqual([needsPersonId]);
    expect(briefing.counts.inProgress).toBe(briefing.inProgress.length);
  });

  it("caps up-next and waiting lists while the header counts every task", async () => {
    const { companyId, workerId } = await seedCompany("BRK");
    for (let index = 0; index < 23; index += 1) {
      await insertIssue({ companyId, identifier: `BRK-${index + 1}`, title: `Todo ${index}`, status: "todo", assigneeAgentId: workerId });
    }
    for (let index = 0; index < 22; index += 1) {
      await insertIssue({ companyId, identifier: `BRK-${index + 100}`, title: `Blocked ${index}`, status: "blocked" });
    }
    const briefing = await briefingService(db, { attention: { list: async () => ({ items: [] }) as unknown as AttentionFeed } })
      .get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    expect(briefing.inProgress).toHaveLength(20);
    expect(briefing.counts.inProgress).toBe(45);
  });

  it("keeps a blocked task in progress when the Needs you row that covers it is past the shown cap", async () => {
    const { companyId } = await seedCompany("BRN");
    const blockedIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      blockedIds.push(await insertIssue({ companyId, identifier: `BRN-${index + 1}`, title: `Blocked ${index}`, status: "blocked" }));
    }
    // 21 blocker rows; the oldest one falls outside the 20 shown.
    const feed = {
      items: blockedIds.map((id, index) => feedItem("blocker_attention", {
        kind: "issue", id, companyId, title: `Blocked ${index}`, identifier: `BRN-${index + 1}`, status: "blocked",
        href: `/BRN/issues/BRN-${index + 1}`, metadata: {},
      }, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, 30 - index)).toISOString() })),
    } as unknown as AttentionFeed;
    const briefing = await briefingService(db, { attention: { list: async () => feed } })
      .get({ companyId, userId: "board-user", actor: boardActor(companyId) });
    expect(briefing.needsYou).toHaveLength(20);
    expect(briefing.inProgress.map((item) => item.issueId)).toEqual([blockedIds[20]]);
    expect(briefing.counts.inProgress).toBe(1);
  });

  it("serves the briefing to board users and rejects agents", async () => {
    const { companyId } = await seedCompany("BRR");
    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", briefingRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    }

    const res = await request(app(boardActor(companyId))).get(`/api/companies/${companyId}/briefing`).expect(200);
    expect(res.body).toMatchObject({
      needsYou: expect.any(Array),
      inProgress: [],
      doneRecently: [],
      counts: { inProgress: 0, doneRecently: 0 },
      generatedAt: expect.any(String),
    });
    await request(app({
      type: "agent",
      source: "agent_key",
      companyId,
      agentId: randomUUID(),
      runId: null,
    })).get(`/api/companies/${companyId}/briefing`).expect(403);
    await request(app({ ...boardActor(randomUUID()), source: "session" }))
      .get(`/api/companies/${companyId}/briefing`)
      .expect(403);
  });
});

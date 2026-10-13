import { randomUUID } from "node:crypto";
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

const DAY_MS = 24 * 60 * 60 * 1000;

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

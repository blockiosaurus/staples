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
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { AttentionFeed, AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { briefingRoutes } from "../routes/briefing.js";
import {
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
    await db.delete(inboxDismissals);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
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

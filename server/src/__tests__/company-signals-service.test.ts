import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  goals,
  issueDocuments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySignalsService } from "../services/company-signals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company signals tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const agentBase = { role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };

describeEmbeddedPostgres("company signals service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-signals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueWorkProducts);
    await db.delete(issueThreadInteractions);
    await db.delete(costEvents);
    await db.delete(approvals);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts per-company usage signals", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "A", issuePrefix: `T${companyA.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: companyB, name: "B", issuePrefix: `T${companyB.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);

    const liveAgent = randomUUID();
    await db.insert(agents).values([
      { id: liveAgent, companyId: companyA, name: "Live", ...agentBase },
      { id: randomUUID(), companyId: companyA, name: "Gone", status: "terminated", ...agentBase },
      {
        id: randomUUID(),
        companyId: companyA,
        name: "Assistant",
        metadata: { paperclipBuiltInAgent: { key: "assistant", featureKeys: [] } },
        ...agentBase,
      },
      { id: randomUUID(), companyId: companyB, name: "Other", ...agentBase },
    ]);

    const issueOpen = randomUUID();
    const issueOpen2 = randomUUID();
    const issueDone = randomUUID();
    const issueHidden = randomUUID();
    await db.insert(issues).values([
      { id: issueOpen, companyId: companyA, title: "one", status: "todo" },
      { id: issueOpen2, companyId: companyA, title: "two", status: "in_progress" },
      { id: issueDone, companyId: companyA, title: "three", status: "done" },
      { id: issueHidden, companyId: companyA, title: "hidden", status: "todo", hiddenAt: new Date() },
      { id: randomUUID(), companyId: companyB, title: "b", status: "todo" },
    ]);

    await db.insert(projects).values([
      { companyId: companyA, name: "Live project" },
      { companyId: companyA, name: "Archived project", archivedAt: new Date() },
    ]);
    await db.insert(goals).values({ companyId: companyA, title: "Goal" });
    await db.insert(routines).values([
      { companyId: companyA, title: "Active routine" },
      { companyId: companyA, title: "Archived routine", status: "archived" },
    ]);
    await db.insert(companySkills).values([
      { companyId: companyA, key: "paperclipai/paperclip/paperclip", slug: "paperclip", name: "Paperclip", markdown: "x" },
      { companyId: companyA, key: "acme/custom", slug: "custom", name: "Custom", markdown: "x" },
    ]);
    await db.insert(approvals).values({ companyId: companyA, type: "hire_agent", payload: {} });
    await db.insert(issueThreadInteractions).values([
      { companyId: companyA, issueId: issueOpen, kind: "ask_user_questions", payload: {} as never },
      { companyId: companyA, issueId: issueOpen, kind: "connection_intent", payload: {} as never },
      // On a hidden issue: must not count.
      { companyId: companyA, issueId: issueHidden, kind: "ask_user_questions", payload: {} as never },
    ]);

    // Artifacts: one agent-authored document + one paperclip artifact work product on visible issues.
    const documentId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId: companyA, title: "Doc", latestBody: "body", createdByAgentId: liveAgent });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueOpen, documentId, key: "notes" });

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 12));
    await db.insert(costEvents).values({
      companyId: companyA, agentId: liveAgent, provider: "anthropic", model: "x",
      costCents: 250, occurredAt: new Date(Math.max(monthStart.getTime(), Date.now() - 1000)),
    });

    const signals = await companySignalsService(db).get(companyA);
    expect(signals).toMatchObject({
      companyId: companyA, agents: 1, tasks: 3, openTasks: 2, projects: 1, goals: 1, routines: 1,
      artifacts: 1, extraSkills: 1, connections: 0, connectionRequests: 1, approvalsEver: 1,
      questionsEver: 1, budgetSet: false, monthSpendCents: 250,
    });
    expect(typeof signals.generatedAt).toBe("string");

    const other = await companySignalsService(db).get(companyB);
    expect(other).toMatchObject({ agents: 1, tasks: 1, artifacts: 0, monthSpendCents: 0 });
  });

  it("also counts paperclip artifact work products and rejects unknown companies", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, budgetMonthlyCents: 500 });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "i" });
    await db.insert(issueWorkProducts).values({ companyId, issueId, type: "artifact", provider: "paperclip", title: "wp", status: "active" });
    const signals = await companySignalsService(db).get(companyId);
    expect(signals).toMatchObject({ artifacts: 1, budgetSet: true });
    await expect(companySignalsService(db).get(randomUUID())).rejects.toThrow(/not found/i);
  });
});

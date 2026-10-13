import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, issues } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

/**
 * Through the real createApp wiring (app.ts): plans/apply hires through the
 * agent-hire route in-process, behind the real API middleware stack
 * (including boardMutationGuard). A local trusted board actor is used because
 * the test server has no interactive session; the session + Origin path is
 * covered against the same guard in plans-apply-routes.test.ts.
 */
(support.supported ? describe : describe.skip)("plans/apply through createApp", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => { server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" }); }, 120_000);
  afterAll(async () => { await server?.close(); });

  it("hires and creates tasks in one call, and a retry with the same key creates nothing", async () => {
    const nonce = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await server.db.insert(companies).values({ name: `App Plan ${nonce}`, issuePrefix: `AP${nonce.slice(0, 4)}`, requireBoardApprovalForNewAgents: false }).returning();
    const plan = {
      agents: [{ clientKey: "writer", name: "App Writer", role: "general", adapterType: "claude_local" }],
      tasks: [{ clientKey: "a", title: "First draft", assigneeClientKey: "writer" }],
    };
    const post = () => fetch(`${server.apiUrl}/api/companies/${company!.id}/plans/apply`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "app-test-key" }, body: JSON.stringify(plan),
    });
    const first = await post();
    const body = await first.json();
    expect(first.status, JSON.stringify(body)).toBe(201);
    const [writer] = await server.db.select().from(agents).where(eq(agents.id, body.agents.writer.id));
    expect(writer).toMatchObject({ companyId: company!.id, name: "App Writer" });
    const [task] = await server.db.select().from(issues).where(eq(issues.id, body.tasks.a.id));
    expect(task).toMatchObject({ assigneeAgentId: writer!.id, status: "todo" });
    const again = await post();
    expect(again.status).toBe(200);
    expect((await again.json()).agents).toEqual(body.agents);
    expect(await server.db.select().from(agents).where(eq(agents.companyId, company!.id))).toHaveLength(1);
  }, 120_000);
});

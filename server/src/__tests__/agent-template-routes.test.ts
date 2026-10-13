import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AgentTemplateDetail, AgentTemplateSummary } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { agentTemplateRoutes } from "../routes/agent-templates.js";
import { agentTemplatesService } from "../services/agent-templates.js";

type Actor = Express.Request["actor"];

const COMPANY_ID = randomUUID();
const OTHER_COMPANY_ID = randomUUID();
const templates = agentTemplatesService();

function boardActor(companyIds: string[] = [COMPANY_ID]): Actor {
  return {
    type: "board", source: "session", userId: "user-pat", companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "viewer", status: "active" })),
    isInstanceAdmin: false,
  } as unknown as Actor;
}

const agentActor = {
  type: "agent", source: "agent_key", agentId: randomUUID(), companyId: COMPANY_ID, keyId: randomUUID(), runId: null,
} as unknown as Actor;

function app(actor: Actor) {
  const context = vi.fn(async (companyId: string, userId: string | null) => ({
    companyName: `Company ${companyId.slice(0, 4)}`,
    personName: userId === "user-pat" ? "Pat Lee" : "someone else",
  }));
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use("/api", agentTemplateRoutes({} as Db, { templates, context }));
  server.use(errorHandler);
  return { server, context };
}

describe("agent template routes", () => {
  it("lists hireable templates for a board member, hiding previews", async () => {
    const { server } = app(boardActor());
    const response = await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const list = response.body as AgentTemplateSummary[];
    const slugs = list.map((entry) => entry.slug);
    expect(slugs).toContain("email-secretary");
    expect(slugs).toContain("bookkeeper");
    expect(slugs).not.toContain("social-media-manager");
    expect(list.find((entry) => entry.slug === "bookkeeper")?.readOnly).toBe(true);
    expect(list.find((entry) => entry.slug === "email-secretary")?.readOnly).toBe(false);
  });

  it("returns detail with the requesting person's and company's names resolved", async () => {
    const { server, context } = app(boardActor());
    const response = await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates/email-secretary`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const detail = response.body as AgentTemplateDetail;
    expect(context).toHaveBeenCalledWith(COMPANY_ID, "user-pat");
    expect(detail.description.length).toBeGreaterThan(0);
    const callMe = detail.setupQuestions.find((question) => question.id === "callMe");
    expect(callMe?.initialText).toBe("Pat Lee");
    expect(JSON.stringify(detail)).not.toContain("{{person.name}}");
    expect(JSON.stringify(detail)).not.toContain("{{company.name}}");
  });

  it("404s preview, unknown and malformed template slugs", async () => {
    const { server } = app(boardActor());
    for (const slug of ["social-media-manager", "no-such-template", "Bad..Slug"]) {
      const response = await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates/${slug}`);
      expect(response.status, slug).toBe(404);
    }
  });

  it("is board-only: agents get 403 on list and detail", async () => {
    const { server } = app(agentActor);
    expect((await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates`)).status).toBe(403);
    expect((await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates/email-secretary`)).status).toBe(403);
  });

  it("keeps companies apart: a person outside the company gets 403 and no context lookup", async () => {
    const { server, context } = app(boardActor([OTHER_COMPANY_ID]));
    expect((await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates`)).status).toBe(403);
    expect((await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates/email-secretary`)).status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });

  it("requires a signed-in actor", async () => {
    const { server } = app({ type: "none", source: "none" } as unknown as Actor);
    expect((await request(server).get(`/api/companies/${COMPANY_ID}/agent-templates`)).status).toBe(401);
  });
});

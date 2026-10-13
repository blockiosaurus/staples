import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSelfServePolicy, resetSelfServePolicy } from "../services/self-serve-policy.js";

/**
 * GET /api/skills/available and /api/skills/:name read the operator's own
 * `~/.claude/skills` folder. While self-serve companies are on, only instance
 * admins see it; other signed-in users get the bundled Paperclip skills only.
 */

vi.mock("../services/index.js", () => ({
  accessService: () => ({ isInstanceAdmin: vi.fn(), hasPermission: vi.fn(), canUser: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({}),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", accessRoutes({} as never, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

const member = { type: "board", userId: "user-1", companyIds: ["c1"], source: "session", isInstanceAdmin: false };
const admin = { type: "board", userId: "admin-1", companyIds: [], source: "session", isInstanceAdmin: true };

describe("operator skills folder under self-serve", () => {
  let claudeHome = "";

  beforeEach(async () => {
    claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-"));
    await fs.mkdir(path.join(claudeHome, "skills", "operator-private"), { recursive: true });
    await fs.writeFile(
      path.join(claudeHome, "skills", "operator-private", "SKILL.md"),
      "---\ndescription: OPERATOR_PRIVATE_SKILL\n---\nOPERATOR_PRIVATE_BODY\n",
      "utf8",
    );
    // An operator copy that shadows a bundled skill name.
    await fs.mkdir(path.join(claudeHome, "skills", "paperclip"), { recursive: true });
    await fs.writeFile(path.join(claudeHome, "skills", "paperclip", "SKILL.md"), "OPERATOR_SHADOW_COPY\n", "utf8");
    vi.stubEnv("CLAUDE_HOME", claudeHome);
  });

  afterEach(async () => {
    resetSelfServePolicy();
    vi.unstubAllEnvs();
    await fs.rm(claudeHome, { recursive: true, force: true });
  });

  it("lists and serves the operator folder when self-serve is off", async () => {
    const app = await createApp(member);
    const listed = await request(app).get("/api/skills/available");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain("operator-private");
    const skill = await request(app).get("/api/skills/operator-private");
    expect(skill.status).toBe(200);
    expect(skill.text).toContain("OPERATOR_PRIVATE_BODY");
  });

  it("serves only bundled skills to non-admins when self-serve is on", async () => {
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
    const app = await createApp(member);
    const listed = await request(app).get("/api/skills/available");
    expect(listed.status).toBe(200);
    const body = JSON.stringify(listed.body);
    expect(body).not.toContain("operator-private");
    expect(body).not.toContain("OPERATOR_PRIVATE_SKILL");
    expect(body).toContain("\"paperclip\"");
    expect((await request(app).get("/api/skills/operator-private")).status).toBe(404);
    const bundled = await request(app).get("/api/skills/paperclip");
    expect(bundled.status).toBe(200);
    expect(bundled.text).not.toContain("OPERATOR_SHADOW_COPY");
  });

  it("still shows the operator folder to instance admins when self-serve is on", async () => {
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
    const app = await createApp(admin);
    const listed = await request(app).get("/api/skills/available");
    expect(JSON.stringify(listed.body)).toContain("operator-private");
    expect((await request(app).get("/api/skills/operator-private")).status).toBe(200);
  });
});

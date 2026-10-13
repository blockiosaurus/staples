import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  issues,
  projects,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { fileResourceRoutes } from "../routes/file-resources.js";
import { accessService } from "../services/access.js";
import { projectService } from "../services/projects.js";
import { configureSelfServePolicy, resetSelfServePolicy } from "../services/self-serve-policy.js";
import { workspaceFileResourceService } from "../services/workspace-file-resources.js";

/**
 * The execution-workspace `cwd` attack: a self-serve owner points an active
 * local workspace at `/` and reads `proc/self/environ` (or any server file)
 * through the issue file browser. Refused when the root is written (PATCH and
 * the project-workspace service) and when it is read (root policy), and the
 * file browser never serves denied host locations for any company.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping self-serve workspace root DB tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("self-serve workspace roots (database)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let instanceRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-serve-roots-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ss-roots-home-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", `ss${randomUUID().replace(/-/g, "").slice(0, 10)}`);
    instanceRoot = path.join(home, "instances", process.env.PAPERCLIP_INSTANCE_ID!);
    await fs.mkdir(instanceRoot, { recursive: true });
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
  });

  afterEach(async () => {
    resetSelfServePolicy();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A company with an owner, a project, a claude_managed agent and an issue
   * whose active local execution workspace sits where the heartbeat puts it. */
  async function seed(selfServe: boolean) {
    const companyId = randomUUID();
    const ownerId = `owner-${companyId.slice(0, 8)}`;
    const goalId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Roots ${companyId.slice(0, 6)}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      selfServe,
      selfServeCreatedByUserId: selfServe ? ownerId : null,
    });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", ownerId, "owner", "active");
    await access.ensureRoleDefaultGrants(companyId, ownerId, "owner", ownerId);
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "company", status: "active" });
    await db.insert(projects).values({ id: projectId, companyId, goalId, name: "Project", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "claude_managed", adapterConfig: { model: "claude-opus-5-5" },
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, goalId, title: "Read a file", status: "todo", priority: "medium",
    });
    // Where the heartbeat realizes a workspace for a project with no folder:
    // the agent's home under the instance root.
    const managedRoot = path.join(instanceRoot, "workspaces", agentId);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "notes.txt"), "MANAGED_FILE", "utf8");
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "Issue workspace",
      status: "active",
      cwd: managedRoot,
      providerType: "local_fs",
      providerRef: null,
    });
    await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
    return { companyId, ownerId, projectId, agentId, issueId, executionWorkspaceId, managedRoot };
  }

  function createApp(actor: Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db));
    app.use("/api", fileResourceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function ownerActor(companyId: string, userId: string): Request["actor"] {
    return { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false } as Request["actor"];
  }

  async function writeOutsideFile() {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ss-roots-outside-")));
    await fs.writeFile(path.join(outside, "server-secret.txt"), "SERVER_SECRET", "utf8");
    return outside;
  }

  it("serves the self-serve company's managed workspace", async () => {
    const graph = await seed(true);
    const res = await request(createApp(ownerActor(graph.companyId, graph.ownerId)))
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "execution", path: "notes.txt" });
    expect(res.status).toBe(200);
    expect(res.body.content.data).toContain("MANAGED_FILE");
  });

  it("refuses the cwd/providerRef PATCH in a self-serve company", async () => {
    const graph = await seed(true);
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));
    for (const body of [{ cwd: "/" }, { providerRef: "/" }, { cwd: "/", providerRef: "/", status: "active" }]) {
      const res = await request(app).patch(`/api/execution-workspaces/${graph.executionWorkspaceId}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.code ?? res.body.details?.code).toBe("self_serve_host_execution_forbidden");
    }
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    expect(row!.cwd).toBe(graph.managedRoot);
    expect(row!.providerRef).toBeNull();

    // Unchanged values and non-root fields still save.
    const ok = await request(app)
      .patch(`/api/execution-workspaces/${graph.executionWorkspaceId}`)
      .send({ name: "Renamed", cwd: graph.managedRoot });
    expect(ok.status).toBe(200);
  });

  it("still lets an admin-created company change its workspace cwd", async () => {
    const graph = await seed(false);
    const outside = await writeOutsideFile();
    const res = await request(createApp(ownerActor(graph.companyId, graph.ownerId)))
      .patch(`/api/execution-workspaces/${graph.executionWorkspaceId}`)
      .send({ cwd: outside });
    expect(res.status).toBe(200);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses to read a self-serve root outside the managed folders, even if written straight to the database", async () => {
    const graph = await seed(true);
    const outside = await writeOutsideFile();
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));
    for (const root of [outside, "/", instanceRoot]) {
      await db.update(executionWorkspaces).set({ cwd: root }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
      for (const filePath of ["server-secret.txt", "proc/self/environ", "etc/hosts", "config.json"]) {
        const res = await request(app)
          .get(`/api/issues/${graph.issueId}/file-resources/content`)
          .query({ workspace: "execution", path: filePath });
        expect(res.status, `${root} ${filePath}`).not.toBe(200);
        expect(JSON.stringify(res.body)).not.toContain("SERVER_SECRET");
      }
      const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, { workspace: "execution", path: "server-secret.txt" });
      expect(resolved.denialReason).toBe("workspace_root_not_allowed");
      const listed = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/list`)
        .query({ workspace: "execution" });
      expect(JSON.stringify(listed.body)).not.toContain("server-secret.txt");
    }
    // Another self-serve company's managed folder is outside this company's.
    const other = await seed(true);
    await db.update(executionWorkspaces).set({ cwd: other.managedRoot }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    const cross = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "execution", path: "notes.txt" });
    expect(cross.status).not.toBe(200);
    // A symlink inside the managed folder that points out is not followed out.
    await db.update(executionWorkspaces).set({ cwd: path.join(graph.managedRoot, "escape") }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    await fs.symlink(outside, path.join(graph.managedRoot, "escape"));
    const viaLink = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "execution", path: "server-secret.txt" });
    expect(viaLink.status).not.toBe(200);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("never serves denied host locations, in any company", async () => {
    const graph = await seed(false);
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));
    await db.update(executionWorkspaces).set({ cwd: "/" }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    for (const filePath of ["proc/self/environ", "etc/hosts", "dev/null", "sys/kernel/hostname"]) {
      const res = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/content`)
        .query({ workspace: "execution", path: filePath });
      expect(res.status, filePath).not.toBe(200);
    }
    // /etc exists everywhere (a symlink to /private/etc on macOS): refused by policy.
    const etc = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "execution", path: "etc/hosts" });
    expect(etc.status).toBe(403);
    expect(etc.body.code ?? etc.body.details?.code).toBe("denied_host_path");

    // The instance's own config, secrets, database and data folders.
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "config.json"), "{\"secret\":\"CONFIG\"}", "utf8");
    await fs.writeFile(path.join(instanceRoot, "db", "PG_VERSION"), "17", "utf8");
    await fs.mkdir(path.join(instanceRoot, "data", "storage"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "data", "storage", "a.txt"), "STORED", "utf8");
    await fs.writeFile(path.join(instanceRoot, "ok.txt"), "fine", "utf8");
    await db.update(executionWorkspaces).set({ cwd: instanceRoot }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    for (const filePath of ["config.json", "db/PG_VERSION", "data/storage/a.txt"]) {
      const res = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/content`)
        .query({ workspace: "execution", path: filePath });
      expect(res.status, filePath).toBe(403);
    }
    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "execution" });
    expect(listed.status).toBe(200);
    const names = JSON.stringify(listed.body);
    expect(names).toContain("ok.txt");
    expect(names).not.toContain("config.json");
    expect(names).not.toContain("PG_VERSION");

    // A root that is itself a denied location is never local.
    await db.update(executionWorkspaces).set({ cwd: "/etc" }).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, { workspace: "execution", path: "hosts" });
    expect(resolved.denialReason).toBe("denied_host_path");
  });

  it("refuses a project workspace folder outside the managed folders at the service", async () => {
    const graph = await seed(true);
    const outside = await writeOutsideFile();
    const svc = projectService(db);
    await expect(svc.createWorkspace(graph.projectId, { cwd: outside } as never)).rejects.toMatchObject({ status: 403 });
    const [workspace] = await db.insert(projectWorkspaces).values({
      companyId: graph.companyId, projectId: graph.projectId, name: "Repo", sourceType: "git_repo",
      repoUrl: "https://example.com/repo.git", isPrimary: true,
    }).returning();
    await expect(svc.updateWorkspace(graph.projectId, workspace!.id, { cwd: "/" } as never)).rejects.toMatchObject({ status: 403 });
    // The managed checkout folder is fine.
    const managed = path.join(instanceRoot, "projects", graph.companyId, graph.projectId, "repo");
    await expect(svc.updateWorkspace(graph.projectId, workspace!.id, { cwd: managed } as never)).resolves.toMatchObject({ cwd: managed });
    await fs.rm(outside, { recursive: true, force: true });
  });
});

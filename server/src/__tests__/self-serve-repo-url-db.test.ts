import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
import { projectRoutes } from "../routes/projects.js";
import { accessService } from "../services/access.js";
import { ensureManagedProjectWorkspace } from "../services/heartbeat/workspaces.js";
import { projectService } from "../services/projects.js";
import {
  configureSelfServePolicy,
  registerSelfServeCompanyLookup,
  resetSelfServePolicy,
  selfServeRepoUrlViolation,
} from "../services/self-serve-policy.js";
import { createWorkspaceGitOperationScheduler } from "../services/workspace-git-operation-scheduler.js";
import { registerDeniedHostLocations } from "../services/workspace-file-resources.js";

const execFile = promisify(execFileCallback);

/**
 * The repoUrl attack: a self-serve owner sets a project or execution workspace
 * repoUrl to `file:///<instance>/projects/<victim>/...`; the server clones it
 * into the attacker's managed folder, which the file browser then serves.
 * Refused at every write path for self-serve companies, refused by the clone
 * itself (file and ext transports) on a self-serve instance, and git calls in
 * managed folders never run a planted core.fsmonitor.
 */

const REPO_URL_CODE = "self_serve_repo_url_not_allowed";

async function git(cwd: string, ...args: string[]) {
  return execFile("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

async function makeRepo(prefix: string, content = "VICTIM_SOURCE") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await git(dir, "init", "--quiet");
  await fs.writeFile(path.join(dir, "secret.txt"), content, "utf8");
  await git(dir, "add", ".");
  await git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

describe("repository URL rule", () => {
  it("allows only https:// to a non-private host", () => {
    expect(selfServeRepoUrlViolation("https://github.com/acme/repo.git")).toBeNull();
    for (const url of [
      "file:///etc/passwd",
      "/srv/repo",
      "ssh://git@github.com/acme/repo.git",
      "git://github.com/acme/repo.git",
      "http://github.com/acme/repo.git",
      "ext::sh -c touch% /tmp/pwned",
      "https://127.0.0.1/repo.git",
      "https://10.0.0.5/repo.git",
      "https://[::1]/repo.git",
      "https://169.254.169.254/repo.git",
      "https://localhost/repo.git",
    ]) {
      expect(selfServeRepoUrlViolation(url), url).not.toBeNull();
    }
  });
});

describe("git in managed workspace folders", () => {
  it("never runs a repository-local core.fsmonitor from the shared scan scheduler", async () => {
    const repo = await makeRepo("paperclip-fsmonitor-");
    const marker = path.join(repo, "..", `fsmonitor-ran-${path.basename(repo)}`);
    const hook = path.join(repo, ".git", "fsmonitor-hook.sh");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await git(repo, "config", "core.fsmonitor", hook);
    try {
      // Control: plain git status runs the planted program.
      await git(repo, "status", "--porcelain").catch(() => undefined);
      const controlRan = await fs.stat(marker).then(() => true, () => false);
      await fs.rm(marker, { force: true });

      const scheduler = createWorkspaceGitOperationScheduler();
      await scheduler.run({
        workspacePath: repo,
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        operation: "test.fsmonitor",
        cacheTtlMs: 0,
      });
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
      expect(controlRan).toBe(true);
    } finally {
      await fs.rm(marker, { force: true });
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping self-serve repo URL DB tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("self-serve repository URLs (database)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let instanceRoot = "";
  const cleanup = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-serve-repo-url-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ss-repo-home-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", `rp${randomUUID().replace(/-/g, "").slice(0, 10)}`);
    instanceRoot = path.join(home, "instances", process.env.PAPERCLIP_INSTANCE_ID!);
    await fs.mkdir(instanceRoot, { recursive: true });
    configureSelfServePolicy({ selfServeCompanies: true, deploymentMode: "authenticated", adapterTypes: ["claude_managed"] });
    registerSelfServeCompanyLookup(db);
  });

  afterEach(async () => {
    resetSelfServePolicy();
    registerSelfServeCompanyLookup(null);
    registerDeniedHostLocations([]);
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
    await Promise.all([...cleanup].map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanup.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(selfServe: boolean) {
    const companyId = randomUUID();
    const ownerId = `owner-${companyId.slice(0, 8)}`;
    const goalId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Repo ${companyId.slice(0, 6)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      selfServe,
      selfServeCreatedByUserId: selfServe ? ownerId : null,
    });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", ownerId, "owner", "active");
    await access.ensureRoleDefaultGrants(companyId, ownerId, "owner", ownerId);
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "company", status: "active" });
    await db.insert(projects).values({ id: projectId, companyId, goalId, name: "Project", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Repo", sourceType: "git_repo",
      repoUrl: "https://github.com/acme/repo.git", isPrimary: true,
    });
    await db.insert(agents).values({
      id: randomUUID(), companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "claude_managed", adapterConfig: { model: "claude-opus-5-5" }, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, projectId, goalId, title: "Clone", status: "todo", priority: "medium" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Issue workspace", status: "active", cwd: null,
      repoUrl: "https://github.com/acme/repo.git", providerType: "git_worktree", providerRef: null,
    });
    return { companyId, ownerId, projectId, projectWorkspaceId, executionWorkspaceId, issueId };
  }

  function createApp(actor: Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use("/api", fileResourceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function ownerActor(companyId: string, userId: string): Request["actor"] {
    return { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false } as Request["actor"];
  }

  function codeOf(body: { code?: string; details?: { code?: string } }) {
    return body.code ?? body.details?.code;
  }

  it("refuses a file:// (or private-host) repoUrl at every write path in a self-serve company", async () => {
    const graph = await seed(true);
    const victimUrl = pathToFileURL(path.join(instanceRoot, "projects", randomUUID(), "victim")).href;
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));

    // Project workspace create and update (route -> service).
    for (const repoUrl of [victimUrl, "https://127.0.0.1/repo.git", "http://github.com/acme/repo.git"]) {
      const created = await request(app).post(`/api/projects/${graph.projectId}/workspaces`).send({ repoUrl });
      expect(created.status, repoUrl).toBe(403);
      expect(codeOf(created.body), repoUrl).toBe(REPO_URL_CODE);
      const updated = await request(app)
        .patch(`/api/projects/${graph.projectId}/workspaces/${graph.projectWorkspaceId}`)
        .send({ repoUrl });
      expect(updated.status, repoUrl).toBe(403);
    }
    const refPatch = await request(app)
      .patch(`/api/projects/${graph.projectId}/workspaces/${graph.projectWorkspaceId}`)
      .send({ repoRef: "--upload-pack=touch /tmp/pwned" });
    expect(refPatch.status).toBe(403);

    // Project create, with a workspace or with repositoryUrls.
    const withWorkspace = await request(app)
      .post(`/api/companies/${graph.companyId}/projects`)
      .send({ name: "Steal", workspace: { repoUrl: victimUrl } });
    expect(withWorkspace.status).toBe(403);
    expect(codeOf(withWorkspace.body)).toBe(REPO_URL_CODE);
    const withUrls = await request(app)
      .post(`/api/companies/${graph.companyId}/projects`)
      .send({ name: "Steal 2", repositoryUrls: [victimUrl] });
    expect(withUrls.status).toBe(403);
    expect((await db.select().from(projects).where(eq(projects.companyId, graph.companyId)))).toHaveLength(1);

    // The service itself, whatever the caller.
    await expect(projectService(db).createWorkspace(graph.projectId, { repoUrl: victimUrl } as never))
      .rejects.toMatchObject({ status: 403 });
    await expect(projectService(db).updateWorkspace(graph.projectId, graph.projectWorkspaceId, { repoUrl: "/srv/victim" } as never))
      .rejects.toMatchObject({ status: 403 });

    // Execution-workspace PATCH (no URL validation in its schema).
    for (const body of [{ repoUrl: victimUrl }, { repoUrl: "/srv/victim" }, { repoUrl: "ext::sh -c id" }, { baseRef: "--orphan" }]) {
      const res = await request(app).patch(`/api/execution-workspaces/${graph.executionWorkspaceId}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(codeOf(res.body)).toBe(REPO_URL_CODE);
    }
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    expect(row!.repoUrl).toBe("https://github.com/acme/repo.git");
    const [workspace] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, graph.projectWorkspaceId));
    expect(workspace!.repoUrl).toBe("https://github.com/acme/repo.git");

    // https:// to a public host still saves.
    const ok = await request(app).post(`/api/projects/${graph.projectId}/workspaces`).send({ repoUrl: "https://github.com/acme/other.git" });
    expect(ok.status).toBe(201);
    const okPatch = await request(app)
      .patch(`/api/execution-workspaces/${graph.executionWorkspaceId}`)
      .send({ repoUrl: "https://github.com/acme/other.git" });
    expect(okPatch.status).toBe(200);
  });

  it("leaves admin-created companies free to store other repository URLs", async () => {
    const graph = await seed(false);
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));
    const res = await request(app)
      .post(`/api/projects/${graph.projectId}/workspaces`)
      .send({ repoUrl: "file:///srv/local-repo" });
    expect(res.status).toBe(201);
  });

  it("refuses the file transport in the managed clone itself, for every company, on a self-serve instance", async () => {
    const victim = await makeRepo("paperclip-victim-repo-");
    cleanup.add(victim);
    const selfServe = await seed(true);
    const admin = await seed(false);

    // Self-serve: refused by the clone floor before git runs.
    await expect(ensureManagedProjectWorkspace({
      companyId: selfServe.companyId, projectId: selfServe.projectId, repoUrl: pathToFileURL(victim).href,
    })).rejects.toMatchObject({ status: 403 });
    await expect(ensureManagedProjectWorkspace({
      companyId: selfServe.companyId, projectId: selfServe.projectId, repoUrl: "https://127.0.0.1/repo.git",
    })).rejects.toMatchObject({ status: 403 });

    // Admin-created company on a self-serve instance: git itself refuses file:// and a bare path.
    for (const repoUrl of [pathToFileURL(victim).href, victim]) {
      await expect(ensureManagedProjectWorkspace({
        companyId: admin.companyId, projectId: admin.projectId, repoUrl,
      }), repoUrl).rejects.toThrow(/transport 'file' not allowed|Failed to prepare managed checkout/);
    }
    const adminProjects = path.join(instanceRoot, "projects", admin.companyId);
    const cloned = await fs.readdir(adminProjects, { recursive: true }).catch(() => [] as string[]);
    expect(cloned.some((entry) => String(entry).endsWith("secret.txt"))).toBe(false);

    // A self-serve-free instance keeps local clones for trusted operators.
    resetSelfServePolicy();
    const local = await ensureManagedProjectWorkspace({
      companyId: admin.companyId, projectId: admin.projectId, repoUrl: pathToFileURL(victim).href,
    });
    expect(await fs.readFile(path.join(local.cwd, "secret.txt"), "utf8")).toBe("VICTIM_SOURCE");
  });

  it("never serves configured database, storage or log folders outside the instance root", async () => {
    const graph = await seed(false);
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ss-config-dirs-")));
    cleanup.add(outside);
    for (const name of ["pgdata", "storage", "logs"]) {
      await fs.mkdir(path.join(outside, name), { recursive: true });
      await fs.writeFile(path.join(outside, name, "file.txt"), `SECRET_${name}`, "utf8");
    }
    await fs.writeFile(path.join(outside, "ok.txt"), "fine", "utf8");
    registerDeniedHostLocations([path.join(outside, "pgdata"), path.join(outside, "storage"), path.join(outside, "logs")]);
    await db.update(executionWorkspaces).set({ cwd: outside, providerType: "local_fs", strategyType: "project_primary" })
      .where(eq(executionWorkspaces.id, graph.executionWorkspaceId));
    await db.update(issues).set({ executionWorkspaceId: graph.executionWorkspaceId }).where(eq(issues.id, graph.issueId));
    const app = createApp(ownerActor(graph.companyId, graph.ownerId));
    for (const name of ["pgdata", "storage", "logs"]) {
      const res = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/content`)
        .query({ workspace: "execution", path: `${name}/file.txt` });
      expect(res.status, name).toBe(403);
      expect(codeOf(res.body)).toBe("denied_host_path");
    }
    const ok = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "execution", path: "ok.txt" });
    expect(ok.status).toBe(200);
  });
});

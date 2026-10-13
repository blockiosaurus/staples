import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalogManifest,
  formatCatalogManifest,
  validateCatalog,
} from "./catalog-builder.js";

const tempDirs: string[] = [];
const catalogSkills = [
  {
    id: "paperclipai:bundled:software-development:github-pr-workflow",
    key: "paperclipai/bundled/software-development/github-pr-workflow",
    slug: "github-pr-workflow",
  },
  {
    id: "paperclipai:bundled:paperclip-operations:task-planning",
    key: "paperclipai/bundled/paperclip-operations/task-planning",
    slug: "task-planning",
  },
];

describe("teams catalog manifest", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("builds stable manifest entries from catalog team directories", async () => {
    const packageDir = await createCatalogPackage();
    await writeTeam(packageDir, "bundled", "software-development", "product-engineering", {
      frontmatter: [
        "name: Product Engineering",
        "description: Product engineering team for implementation and review work.",
        "schema: agentcompanies/v1",
        "key: paperclipai/bundled/software-development/product-engineering",
        "manager: agents/cto/AGENTS.md",
        "recommendedForCompanyTypes:",
        "  - software",
        "tags:",
        "  - engineering",
      ],
      files: {
        "agents/cto/AGENTS.md": [
          "---",
          "name: CTO",
          "slug: cto",
          "skills:",
          "  - github-pr-workflow",
          "---",
          "",
          "Lead engineering.",
        ].join("\n"),
        "projects/app/PROJECT.md": [
          "---",
          "name: App",
          "slug: app",
          "owner: cto",
          "---",
          "",
          "Build the app.",
        ].join("\n"),
        "projects/app/tasks/review/TASK.md": [
          "---",
          "name: Review",
          "slug: review",
          "assignee: cto",
          "project: app",
          "recurring: true",
          "---",
          "",
          "Review progress.",
        ].join("\n"),
      },
    });

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-06-03T00:00:00.000Z",
      catalogSkills,
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.teams).toHaveLength(1);
    expect(result.manifest.teams[0]).toMatchObject({
      id: "paperclipai:bundled:software-development:product-engineering",
      key: "paperclipai/bundled/software-development/product-engineering",
      kind: "bundled",
      category: "software-development",
      slug: "product-engineering",
      name: "Product Engineering",
      schema: "agentcompanies/v1",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      recommendedForCompanyTypes: ["software"],
      tags: ["engineering"],
      counts: {
        agents: 1,
        projects: 1,
        tasks: 0,
        routines: 1,
        localSkills: 0,
        catalogSkills: 1,
        externalSkillSources: 0,
      },
      rootAgentSlugs: ["cto"],
      agentSlugs: ["cto"],
      projectSlugs: ["app"],
    });
    expect(result.manifest.teams[0]!.requiredSkills).toEqual([
      expect.objectContaining({
        type: "catalog",
        ref: "github-pr-workflow",
        resolved: true,
        catalogSkillKey: "paperclipai/bundled/software-development/github-pr-workflow",
        agentSlugs: ["cto"],
      }),
    ]);
    expect(result.manifest.teams[0]!.files.map((file) => file.path)).toEqual([
      "TEAM.md",
      "agents/cto/AGENTS.md",
      "projects/app/PROJECT.md",
      "projects/app/tasks/review/TASK.md",
    ]);
    expect(result.manifest.teams[0]!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reports frontmatter, directory, uniqueness, reference, and skill errors together", async () => {
    const packageDir = await createCatalogPackage();
    await writeTeam(packageDir, "bundled", "Bad_Category", "duplicate", {
      frontmatter: [
        "name: Duplicate",
        "schema: agentcompanies/v1",
        "key: paperclipai/bundled/software-development/other",
        "manager: agents/missing/AGENTS.md",
        "recommendedForCompanyTypes: software",
      ],
      files: {
        "agents/lead/AGENTS.md": [
          "---",
          "name: Lead",
          "slug: lead",
          "reportsTo: missing-manager",
          "skills:",
          "  - missing-skill",
          "---",
          "",
          "Lead.",
        ].join("\n"),
        "tasks/bad/TASK.md": [
          "---",
          "name: Bad",
          "slug: bad",
          "assignee: missing-agent",
          "project: missing-project",
          "---",
          "",
          "Bad task.",
        ].join("\n"),
      },
    });
    await writeTeam(packageDir, "optional", "software-development", "duplicate", {
      frontmatter: [
        "name: Duplicate Optional",
        "description: Optional duplicate slug.",
        "schema: agentcompanies/v1",
        "manager: agents/lead/AGENTS.md",
      ],
      files: {
        "agents/lead/AGENTS.md": "---\nname: Lead\nslug: lead\n---\n\nLead.\n",
      },
    });
    await fs.mkdir(path.join(packageDir, "catalog", "bundled", "software-development", "missing-team"), {
      recursive: true,
    });
    await fs.mkdir(path.join(packageDir, "catalog", "misc"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "catalog", "misc", "TEAM.md"), "# Misplaced\n", "utf8");

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-06-03T00:00:00.000Z",
      catalogSkills,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog/misc/TEAM.md is not under catalog/<bundled|optional>/<category>/<slug>/TEAM.md"),
        expect.stringContaining("catalog/bundled/software-development/missing-team is missing TEAM.md"),
        expect.stringContaining("has invalid category"),
        expect.stringContaining("frontmatter must include description"),
        expect.stringContaining("key must be paperclipai/bundled/Bad_Category/duplicate"),
        expect.stringContaining("field recommendedForCompanyTypes must be an array of strings"),
        expect.stringContaining("manager must resolve to an AGENTS.md file"),
        expect.stringContaining("reportsTo references unknown agent slug"),
        expect.stringContaining("skill reference \"missing-skill\" does not resolve"),
        expect.stringContaining("assignee references unknown agent slug"),
        expect.stringContaining("project references unknown project slug"),
        expect.stringContaining("Duplicate catalog slug \"duplicate\""),
      ]),
    );
  });

  it("carries a Staples template sidecar and cron schedules into the manifest", async () => {
    const packageDir = await createCatalogPackage();
    const sidecar = { version: "1.0.0", tagline: "Keeps the inbox tidy", icon: "mail" };
    await writeTeam(packageDir, "optional", "staples", "inbox-helper", {
      frontmatter: [
        "name: Inbox helper",
        "description: Keeps the inbox tidy.",
        "schema: agentcompanies/v1",
        "manager: agents/helper/AGENTS.md",
      ],
      files: {
        "staples.template.json": JSON.stringify(sidecar),
        "agents/helper/AGENTS.md": "---\nname: Helper\nslug: helper\n---\n\nHelp.\n",
        "projects/inbox/PROJECT.md": "---\nname: Inbox\nslug: inbox\n---\n\nInbox.\n",
        "projects/inbox/tasks/sweep/TASK.md": [
          "---",
          "name: Morning sweep",
          "slug: sweep",
          "assignee: helper",
          "project: inbox",
          "recurring: true",
          "schedule: 0 9 * * 1-5",
          "timezone: person",
          "---",
          "",
          "Sweep.",
        ].join("\n"),
      },
    });

    const result = await buildCatalogManifest({ packageDir, generatedAt: "2026-06-03T00:00:00.000Z", catalogSkills });

    expect(result.errors).toEqual([]);
    expect(result.manifest.teams[0]).toMatchObject({
      key: "paperclipai/optional/staples/inbox-helper",
      staplesTemplate: sidecar,
      counts: { routines: 1 },
    });
  });

  it("rejects bad template sidecars and task schedules", async () => {
    const packageDir = await createCatalogPackage();
    await writeTeam(packageDir, "optional", "staples", "no-sidecar", {
      frontmatter: [
        "name: No sidecar",
        "description: Missing the sidecar.",
        "schema: agentcompanies/v1",
        "manager: agents/helper/AGENTS.md",
      ],
      files: {
        "agents/helper/AGENTS.md": "---\nname: Helper\nslug: helper\n---\n\nHelp.\n",
        "tasks/unscheduled/TASK.md": "---\nname: Unscheduled\nslug: unscheduled\nrecurring: true\n---\n\nX.\n",
        "tasks/bad-cron/TASK.md": "---\nname: Bad\nslug: bad-cron\nrecurring: true\nschedule: 61 * * * *\ntimezone: Mars/Olympus\n---\n\nX.\n",
      },
    });
    await writeTeam(packageDir, "optional", "content", "stray-sidecar", {
      frontmatter: [
        "name: Stray",
        "description: Sidecar outside staples.",
        "schema: agentcompanies/v1",
        "manager: agents/helper/AGENTS.md",
      ],
      files: {
        "staples.template.json": "{}",
        "agents/helper/AGENTS.md": "---\nname: Helper\nslug: helper\n---\n\nHelp.\n",
      },
    });
    await writeTeam(packageDir, "optional", "staples", "bad-schedule-map", {
      frontmatter: [
        "name: Bad schedule map",
        "description: scheduleByAnswer errors.",
        "schema: agentcompanies/v1",
        "manager: agents/helper/AGENTS.md",
      ],
      files: {
        "staples.template.json": JSON.stringify({
          scheduleByAnswer: {
            "one-off": { questionId: "day", cron: { monday: "0 9 * * 1" } },
            "missing-task": { questionId: "day", cron: { monday: "0 9 * * 1" } },
            weekly: { questionId: "day", cron: { monday: "0 9 * * 7" } },
          },
        }),
        "agents/helper/AGENTS.md": "---\nname: Helper\nslug: helper\n---\n\nHelp.\n",
        "tasks/one-off/TASK.md": "---\nname: One off\nslug: one-off\n---\n\nX.\n",
        "tasks/weekly/TASK.md": "---\nname: Weekly\nslug: weekly\nrecurring: true\nschedule: \"0 9 * * 1\"\n---\n\nX.\n",
      },
    });
    await writeTeam(packageDir, "optional", "staples", "broken-json", {
      frontmatter: [
        "name: Broken",
        "description: Broken sidecar JSON.",
        "schema: agentcompanies/v1",
        "manager: agents/helper/AGENTS.md",
      ],
      files: {
        "staples.template.json": "{not json",
        "agents/helper/AGENTS.md": "---\nname: Helper\nslug: helper\n---\n\nHelp.\n",
      },
    });

    const result = await buildCatalogManifest({ packageDir, generatedAt: "2026-06-03T00:00:00.000Z", catalogSkills });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no-sidecar is a Staples agent template and must include staples.template.json"),
        expect.stringContaining("tasks/unscheduled/TASK.md is recurring and must declare a cron schedule"),
        expect.stringContaining("schedule \"61 * * * *\" is not a valid 5-field cron expression"),
        expect.stringContaining("tasks/bad-cron/TASK.md timezone must be \"person\" or an IANA time zone"),
        expect.stringContaining("stray-sidecar/staples.template.json is only allowed under catalog/optional/staples"),
        expect.stringContaining("broken-json/staples.template.json is not valid JSON"),
        expect.stringContaining('scheduleByAnswer "one-off" points at a task that is not recurring'),
        expect.stringContaining('scheduleByAnswer "missing-task" does not match a task slug'),
        expect.stringContaining('scheduleByAnswer "weekly" option "monday" cron is not a valid 5-field cron expression'),
      ]),
    );
  });

  it("detects stale generated manifests", async () => {
    const packageDir = await createCatalogPackage();
    await writeTeam(packageDir, "bundled", "software-development", "review", {
      frontmatter: [
        "name: Review",
        "description: Review implementation work.",
        "schema: agentcompanies/v1",
        "manager: agents/reviewer/AGENTS.md",
      ],
      files: {
        "agents/reviewer/AGENTS.md": "---\nname: Reviewer\nslug: reviewer\n---\n\nReview.\n",
      },
    });
    await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      formatCatalogManifest({
        schemaVersion: 1,
        packageName: "@paperclipai/teams-catalog",
        packageVersion: "0.1.0",
        generatedAt: "2026-06-03T00:00:00.000Z",
        teams: [],
      }),
      "utf8",
    );

    const expected = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-06-03T00:00:00.000Z",
      catalogSkills,
    });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      formatCatalogManifest({ ...expected.manifest, teams: [] }),
      "utf8",
    );

    const result = await validateCatalog(packageDir);

    expect(result.errors).toContain(
      "generated/catalog.json is stale. Run pnpm --filter @paperclipai/teams-catalog build:manifest.",
    );
  });
});

async function createCatalogPackage() {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "teams-catalog-"));
  tempDirs.push(packageDir);
  await fs.mkdir(path.join(packageDir, "catalog", "bundled"), { recursive: true });
  await fs.mkdir(path.join(packageDir, "catalog", "optional"), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
    "utf8",
  );
  return packageDir;
}

async function writeTeam(
  packageDir: string,
  kind: "bundled" | "optional",
  category: string,
  slug: string,
  options: {
    frontmatter: string[];
    files?: Record<string, string>;
  },
) {
  const teamDir = path.join(packageDir, "catalog", kind, category, slug);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, "TEAM.md"),
    `---\n${options.frontmatter.join("\n")}\n---\n\nUse this team.\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const filePath = path.join(teamDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

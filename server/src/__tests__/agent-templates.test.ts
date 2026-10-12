import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogTeam } from "@paperclipai/shared";
import {
  agentTemplatesService,
  validateAgentTemplatePackage,
  type AgentTemplateCatalogSource,
} from "../services/agent-templates.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-templates", "test-helper");
const APP_SLUGS = new Set(["gmail", "agentmail", "slack"]);
const CATALOG_SKILL_SLUGS = new Set(["task-planning", "issue-triage"]);
const CTX = { companyName: "Acme Co", personName: "Dana", personTimezone: "Europe/Berlin" };
const ANSWERS = { focus: "  Refund requests  ", cadence: "daily", channels: ["email", "chat"] };

function readFixtureFiles(dir = FIXTURE_DIR): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files[path.relative(dir, absolute).split(path.sep).join("/")] = fs.readFileSync(absolute, "utf8");
    }
  };
  visit(dir);
  return files;
}

function editSidecar(files: Record<string, string>, edit: (sidecar: Record<string, any>) => void) {
  const sidecar = JSON.parse(files["staples.template.json"]!);
  edit(sidecar);
  return { ...files, "staples.template.json": JSON.stringify(sidecar) };
}

function teamFromFiles(slug: string, files: Record<string, string>): CatalogTeam {
  return {
    id: `paperclipai:optional:staples:${slug}`,
    key: `paperclipai/optional/staples/${slug}`,
    kind: "optional",
    category: "staples",
    slug,
    name: slug === "test-helper" ? "Test helper" : `Template ${slug}`,
    description: "Test template.",
    path: `catalog/optional/staples/${slug}`,
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: false,
    recommendedForCompanyTypes: [],
    tags: [],
    counts: { agents: 1, projects: 1, tasks: 1, routines: 2, localSkills: 1, catalogSkills: 1, externalSkillSources: 0 },
    rootAgentSlugs: ["helper"],
    agentSlugs: ["helper"],
    projectSlugs: ["operations"],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: Object.keys(files).sort().map((filePath) => ({
      path: filePath,
      kind: filePath === "TEAM.md" ? "team" : "other",
      sizeBytes: files[filePath]!.length,
      sha256: "0".repeat(64),
    })),
    trustLevel: "assets",
    compatibility: "compatible",
    contentHash: `sha256:${slug}`,
    staplesTemplate: JSON.parse(files["staples.template.json"]!),
  };
}

function fakeCatalog(templates: Record<string, Record<string, string>>): AgentTemplateCatalogSource {
  const teams = Object.entries(templates).map(([slug, files]) => ({ team: teamFromFiles(slug, files), files }));
  return {
    listTeams: async () => teams.map((entry) => entry.team),
    readFile: async (team, relativePath) => {
      const entry = teams.find((candidate) => candidate.team.id === team.id)!;
      return entry.files[relativePath]!;
    },
  };
}

function service(templates: Record<string, Record<string, string>> = { "test-helper": readFixtureFiles() }) {
  return agentTemplatesService({
    catalog: fakeCatalog(templates),
    appSlugs: APP_SLUGS,
    catalogSkillSlugs: CATALOG_SKILL_SLUGS,
  });
}

function validate(files: Record<string, string>) {
  return validateAgentTemplatePackage(files, APP_SLUGS, { catalogSkillSlugs: CATALOG_SKILL_SLUGS });
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error, `expected HTTP ${status}`).toMatchObject({ status });
  return error as { status: number; message: string; details?: unknown };
}

describe("validateAgentTemplatePackage", () => {
  it("accepts the fixture template", () => {
    expect(validate(readFixtureFiles())).toEqual([]);
  });

  it("rejects a question without a recommendation", () => {
    const single = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[1].options[0].recommended = false;
    });
    expect(validate(single)).toEqual([expect.stringContaining('question "cadence" needs a recommendation')]);

    const text = editSidecar(readFixtureFiles(), (sidecar) => {
      delete sidecar.setupQuestions[0].initialText;
    });
    expect(validate(text)).toEqual([expect.stringContaining('question "focus" needs a recommendation')]);
  });

  it("rejects unknown placeholders", () => {
    const files = readFixtureFiles();
    files["agents/helper/AGENTS.md"] += "\nAlso {{answers.missing}} and {{agent.secret}}.\n";
    expect(validate(files)).toEqual([
      expect.stringContaining("{{answers.missing}} does not match a setup question id"),
      expect.stringContaining("unknown placeholder {{agent.secret}}"),
    ]);
  });

  it("rejects an unknown app slug but accepts aggregator slugs", () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.requiredApps[0].anyOf.push("not-an-app");
    });
    expect(validate(files)).toEqual([expect.stringContaining('unknown app slug "not-an-app"')]);
  });

  it("rejects a bad cron schedule and a bad timezone", () => {
    const files = readFixtureFiles();
    const taskPath = "projects/operations/tasks/daily-check-in/TASK.md";
    files[taskPath] = files[taskPath]!
      .replace('"0 9 * * 1-5"', '"0 25 * * *"')
      .replace("timezone: person", "timezone: Mars/Olympus");
    expect(validate(files)).toEqual([
      expect.stringContaining(`${taskPath} schedule "0 25 * * *" is not a valid cron expression`),
      expect.stringContaining(`${taskPath} timezone must be "person" or an IANA time zone`),
    ]);
  });

  it("requires a schedule on recurring tasks", () => {
    const files = readFixtureFiles();
    const taskPath = "projects/operations/tasks/weekly-review/TASK.md";
    files[taskPath] = files[taskPath]!.replace('schedule: "0 16 * * 5"\n', "");
    expect(validate(files)).toEqual([expect.stringContaining(`${taskPath} is recurring and must declare a cron schedule`)]);
  });

  it("rejects an outward action whose capability is not a required app", () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.outwardActions.push({ capability: "payments", label: "Charge a card", toolPatterns: ["*charge*"] });
    });
    expect(validate(files)).toEqual([
      expect.stringContaining('outward action capability "payments" does not match a requiredApps capability'),
    ]);
  });

  it("requires tool patterns on outward actions and keeps read-only templates free of them", () => {
    const missing = editSidecar(readFixtureFiles(), (sidecar) => {
      delete sidecar.outwardActions[0].toolPatterns;
    });
    expect(validate(missing)).toEqual([expect.stringContaining("outwardActions.0.toolPatterns")]);
    for (const pattern of ["*", "**", "send email", "*send*;drop", "x".repeat(81)]) {
      const bad = editSidecar(readFixtureFiles(), (sidecar) => {
        sidecar.outwardActions[0].toolPatterns = [pattern];
      });
      expect(validate(bad), pattern).toEqual([expect.stringContaining("outwardActions.0.toolPatterns.0")]);
    }
    const readOnly = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.readOnly = true;
    });
    expect(validate(readOnly)).toEqual([expect.stringContaining("a readOnly template cannot declare outwardActions")]);
    const readOnlyClean = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.readOnly = true;
      sidecar.outwardActions = [];
    });
    expect(validate(readOnlyClean)).toEqual([]);
  });

  it("rejects a multi_select question with no recommended option", () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[2].options[0].recommended = false;
    });
    expect(validate(files)).toEqual([expect.stringContaining('question "channels" needs a recommendation')]);
  });

  it("rejects placeholders outside AGENTS.md/TASK.md bodies", () => {
    const files = readFixtureFiles();
    files["agents/helper/AGENTS.md"] = files["agents/helper/AGENTS.md"]!
      .replace("name: Inbox Helper", "name: Helper for {{company.name}}")
      .replace("title: Inbox Helper", "title: {{answers.focus}} lead")
      .replace("role: general", "role: \"{{person.name}}\"");
    files["TEAM.md"] += "\nBuilt for {{company.name}}.\n";
    files["skills/fixture-notes/SKILL.md"] += "\nNotes for {{person.name}}.\n";
    expect(validate(files)).toEqual([
      expect.stringContaining("TEAM.md body cannot contain placeholders"),
      expect.stringContaining("skills/fixture-notes/SKILL.md cannot contain placeholders"),
      expect.stringContaining("agents/helper/AGENTS.md name cannot contain placeholders"),
      expect.stringContaining("agents/helper/AGENTS.md title cannot contain placeholders"),
      expect.stringContaining("agents/helper/AGENTS.md role cannot contain placeholders"),
    ]);
  });

  it("validates scheduleByAnswer: recurring task, single_select question, a valid cron per option", () => {
    const ok = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.scheduleByAnswer = { "daily-check-in": { questionId: "cadence", cron: { daily: "0 9 * * 1-5", weekly: "0 9 * * 1" } } };
    });
    expect(validate(ok)).toEqual([]);

    const badTask = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.scheduleByAnswer = {
        "introduce-yourself": { questionId: "cadence", cron: { daily: "0 9 * * 1-5", weekly: "0 9 * * 1" } },
        "no-such-task": { questionId: "cadence", cron: { daily: "0 9 * * 1-5", weekly: "0 9 * * 1" } },
      };
    });
    expect(validate(badTask)).toEqual([
      expect.stringContaining('scheduleByAnswer "introduce-yourself" points at a task that is not recurring'),
      expect.stringContaining('scheduleByAnswer "no-such-task" does not match a TASK.md slug'),
    ]);

    const badQuestion = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.scheduleByAnswer = {
        "daily-check-in": { questionId: "focus", cron: { daily: "0 9 * * 1-5" } },
        "weekly-review": { questionId: "missing", cron: {} },
      };
    });
    expect(validate(badQuestion)).toEqual([
      expect.stringContaining('scheduleByAnswer question "focus" must be single_select'),
      expect.stringContaining('scheduleByAnswer question "missing" is not a setup question'),
    ]);

    const badCron = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.scheduleByAnswer = { "daily-check-in": { questionId: "cadence", cron: { daily: "0 25 * * *", other: "0 9 * * 1" } } };
    });
    expect(validate(badCron)).toEqual([
      expect.stringContaining('has no cron for option "weekly"'),
      expect.stringContaining('names unknown option "other"'),
      expect.stringContaining('option "daily" cron "0 25 * * *" is not valid'),
    ]);
  });

  it("rejects skills that are neither vendored nor in the skills catalog", () => {
    const files = readFixtureFiles();
    files["agents/helper/AGENTS.md"] = files["agents/helper/AGENTS.md"]!.replace("  - task-planning", "  - mystery-skill");
    expect(validate(files)).toEqual([expect.stringContaining('skill "mystery-skill" is neither vendored')]);
  });
});

describe("agentTemplatesService", () => {
  it("lists template cards", async () => {
    const list = await service().list();
    expect(list).toEqual([
      {
        ref: "staples/test-helper",
        slug: "test-helper",
        name: "Test helper",
        tagline: "Keeps an eye on the inbox",
        icon: "mail",
        marketplaceCategory: "communication",
        version: "1.2.0",
        needs: [
          { capability: "email", anyOf: ["gmail", "agentmail"], optional: false, why: "Reads and drafts email." },
          { capability: "social", anyOf: ["linkedin"], optional: true, why: "Posts updates." },
        ],
        asksBefore: ["Send an email"],
        routines: [
          { title: "Daily check-in", schedule: "0 9 * * 1-5", timezone: "person" },
          { title: "Weekly review", schedule: "0 16 * * 5", timezone: "America/New_York" },
        ],
        defaultBudgetMonthlyCents: 2000,
        readOnly: false,
      },
    ]);
  });

  it("returns detail with context placeholders resolved", async () => {
    const detail = await service().get("staples/test-helper", CTX);
    expect(detail.description).toContain("keeps an eye on the inbox");
    expect(detail.setupQuestions.map((question) => question.prompt)).toEqual([
      "What should the helper watch for at Acme Co?",
      "How often should it report to Dana?",
      "Where should summaries go?",
    ]);
  });

  it("renders with plain-text answer substitution", async () => {
    const rendered = await service().render("staples/test-helper", "1.2.0", ANSWERS, CTX);
    expect(rendered.ref).toBe("staples/test-helper");
    expect(rendered.version).toBe("1.2.0");
    expect(rendered.agent).toEqual({
      name: "Inbox Helper",
      role: "general",
      title: "Inbox Helper",
      instructionsMarkdown: [
        "You help Dana at Acme Co.",
        "",
        "Watch for: Refund requests",
        "Report: Every weekday",
        "Channels: Email, Team chat",
      ].join("\n"),
      skills: ["fixture-notes", "task-planning"],
    });
    expect(rendered.vendoredSkills).toEqual([
      { slug: "fixture-notes", files: { "SKILL.md": expect.stringContaining("Keep short notes") } },
    ]);
    expect(rendered.routines).toEqual([
      { title: "Daily check-in", description: "Summarise new Refund requests for Dana.", cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin" },
      { title: "Weekly review", description: "Review the week at Acme Co.", cronExpression: "0 16 * * 5", timezone: "America/New_York" },
    ]);
    expect(rendered.starterTasks).toEqual([
      { title: "Introduce yourself", description: "Say hello to Dana and confirm you will watch for Refund requests." },
    ]);
    expect(rendered.requiredApps.map((app) => app.capability)).toEqual(["email", "social"]);
    expect(rendered.outwardActions).toEqual([{ capability: "email", label: "Send an email", destructiveLabel: "Delete an email", toolPatterns: ["*send*"] }]);
    expect(rendered.readOnly).toBe(false);
    expect(rendered.defaultBudgetMonthlyCents).toBe(2000);
    expect(rendered.recommendedAdapterType).toBe("claude_local");
  });

  it("picks a recurring task's cron from the chosen answer, falling back to TASK.md", async () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[1].customAnswer = { enabled: true };
      sidecar.scheduleByAnswer = { "daily-check-in": { questionId: "cadence", cron: { daily: "0 7 * * 1-5", weekly: "30 8 * * 1" } } };
    });
    const svc = service({ "test-helper": files });
    const cronFor = async (cadence: string) =>
      (await svc.render("staples/test-helper", null, { ...ANSWERS, cadence }, CTX)).routines.map((routine) => routine.cronExpression);

    expect(await cronFor("daily")).toEqual(["0 7 * * 1-5", "0 16 * * 5"]);
    expect(await cronFor("weekly")).toEqual(["30 8 * * 1", "0 16 * * 5"]);
    // A custom answer has no entry, so the TASK.md schedule applies.
    expect(await cronFor("Every other day")).toEqual(["0 9 * * 1-5", "0 16 * * 5"]);
  });

  it("summaries and detail show schedules chosen by the recommended answers", async () => {
    const base = readFixtureFiles();
    const recommended = JSON.parse(base["staples.template.json"]!).setupQuestions[1].options.find((option: any) => option.recommended).id as string;
    const files = editSidecar(base, (sidecar) => {
      sidecar.scheduleByAnswer = { "daily-check-in": { questionId: "cadence", cron: { daily: "0 8 * * 1", weekly: "0 8 * * 1", [recommended]: "15 6 * * 2" } } };
    });
    const svc = service({ "test-helper": files });
    const [summary] = await svc.list({ includePreview: true });    expect(summary!.routines.map((routine) => routine.schedule)).toEqual(["15 6 * * 2", "0 16 * * 5"]);
    const detail = await svc.get("staples/test-helper", CTX);
    expect(detail.routines.map((routine) => routine.schedule)).toEqual(["15 6 * * 2", "0 16 * * 5"]);
    // Without a rule, the TASK.md default shows.
    const plain = await service().get("staples/test-helper", CTX);
    expect(plain.routines.map((routine) => routine.schedule)).toEqual(["0 9 * * 1-5", "0 16 * * 5"]);
  });

  it("inserts an answer containing a placeholder literally, without re-expanding it", async () => {
    const rendered = await service().render(
      "staples/test-helper",
      null,
      { ...ANSWERS, focus: "{{answers.cadence}} and {{company.name}}" },
      CTX,
    );
    expect(rendered.agent.instructionsMarkdown).toContain("Watch for: {{answers.cadence}} and {{company.name}}");
  });

  it("rejects missing required answers, unknown question ids and oversize answers with 422", async () => {
    const svc = service();
    const missing = await expectHttpError(svc.render("staples/test-helper", null, { cadence: "daily" }, CTX), 422);
    expect(missing.details).toEqual({ errors: ['Setup question "focus" is required.'] });

    const unknown = await expectHttpError(svc.render("staples/test-helper", null, { ...ANSWERS, nope: "x" }, CTX), 422);
    expect(unknown.details).toEqual({ errors: ['Unknown setup question "nope".'] });

    const badOption = await expectHttpError(svc.render("staples/test-helper", null, { ...ANSWERS, cadence: "hourly" }, CTX), 422);
    expect(badOption.details).toEqual({ errors: ['Answer to "cadence" is not one of its options.'] });

    await expectHttpError(svc.render("staples/test-helper", null, { ...ANSWERS, focus: "x".repeat(501) }, CTX), 422);
  });

  it("caps multi_select answers with a custom answer: dedupe, item count and joined length", async () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[2].customAnswer = { enabled: true, label: "Somewhere else" };
    });
    const svc = service({ "test-helper": files });

    const deduped = await svc.render("staples/test-helper", null, { ...ANSWERS, channels: ["email", " email ", "Fax"] }, CTX);
    expect(deduped.agent.instructionsMarkdown).toContain("Channels: Email, Fax");

    const tooMany = await expectHttpError(
      svc.render("staples/test-helper", null, { ...ANSWERS, channels: ["email", "chat", "fax", "pager"] }, CTX),
      422,
    );
    expect(tooMany.details).toEqual({ errors: ['Answer to "channels" has more than 3 choices.'] });

    const tooLong = await expectHttpError(
      svc.render("staples/test-helper", null, { ...ANSWERS, channels: ["email", "chat", "y".repeat(495)] }, CTX),
      422,
    );
    expect(tooLong.details).toEqual({ errors: ['Answer to "channels" is longer than 500 characters.'] });
  });

  it("treats prototype keys and non-string answers as 422, never a crash", async () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions.push({
        id: "constructor",
        prompt: "Anything else?",
        required: false,
        answerMode: "text",
        initialText: "Nothing",
      });
    });
    const svc = service({ "test-helper": files });

    // An unanswered question named "constructor" must not pick up Object.prototype.constructor.
    await expect(svc.render("staples/test-helper", null, ANSWERS, CTX)).resolves.toMatchObject({ version: "1.2.0" });

    const plain = service();
    const unknown = await expectHttpError(plain.render("staples/test-helper", null, { ...ANSWERS, constructor: "x" } as never, CTX), 422);
    expect(unknown.details).toEqual({ errors: ['Unknown setup question "constructor".'] });

    const badItems = await expectHttpError(
      plain.render("staples/test-helper", null, { ...ANSWERS, channels: [1, "email"] } as never, CTX),
      422,
    );
    expect(badItems.details).toEqual({ errors: ['Answer to "channels" must be a list of strings.'] });

    const badText = await expectHttpError(
      plain.render("staples/test-helper", null, { ...ANSWERS, focus: ["a"] }, CTX),
      422,
    );
    expect(badText.details).toEqual({ errors: ['Answer to "focus" must be a single text value.'] });

    const badNumber = await expectHttpError(
      plain.render("staples/test-helper", null, { ...ANSWERS, cadence: 5 } as never, CTX),
      422,
    );
    expect(badNumber.details).toEqual({ errors: ['Answer to "cadence" must be a single text value.'] });
  });

  it("accepts and caps a single_select custom answer", async () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[1].customAnswer = { enabled: true, label: "Other" };
    });
    const svc = service({ "test-helper": files });

    const custom = await svc.render("staples/test-helper", null, { ...ANSWERS, cadence: "  Every other Tuesday " }, CTX);
    expect(custom.agent.instructionsMarkdown).toContain("Report: Every other Tuesday");

    const tooLong = await expectHttpError(
      svc.render("staples/test-helper", null, { ...ANSWERS, cadence: "z".repeat(501) }, CTX),
      422,
    );
    expect(tooLong.details).toEqual({ errors: ['Answer to "cadence" is longer than 500 characters.'] });
  });

  it("honours textValidation min and max length on text answers", async () => {
    const files = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.setupQuestions[0].textValidation = { minLength: 5, maxLength: 20 };
    });
    const svc = service({ "test-helper": files });

    await expect(svc.render("staples/test-helper", null, { ...ANSWERS, focus: "Refunds" }, CTX)).resolves.toBeDefined();
    const short = await expectHttpError(svc.render("staples/test-helper", null, { ...ANSWERS, focus: "abc" }, CTX), 422);
    expect(short.details).toEqual({ errors: ['Answer to "focus" must be at least 5 characters.'] });
    const long = await expectHttpError(svc.render("staples/test-helper", null, { ...ANSWERS, focus: "a".repeat(21) }, CTX), 422);
    expect(long.details).toEqual({ errors: ['Answer to "focus" must be at most 20 characters.'] });
  });

  it("pins the version: a mismatch is a 409", async () => {
    await expectHttpError(service().render("staples/test-helper", "1.0.0", ANSWERS, CTX), 409);
  });

  it("hides preview templates from list and get", async () => {
    const preview = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.preview = true;
    });
    const svc = service({ "test-helper": readFixtureFiles(), "preview-helper": preview });

    expect((await svc.list()).map((summary) => summary.ref)).toEqual(["staples/test-helper"]);
    expect((await svc.list({ includePreview: true })).map((summary) => summary.ref).sort()).toEqual([
      "staples/preview-helper",
      "staples/test-helper",
    ]);
    await expectHttpError(svc.get("staples/preview-helper", CTX), 404);
    await expectHttpError(svc.render("staples/preview-helper", null, ANSWERS, CTX), 404);
  });

  it("404s for unknown refs and hides invalid templates", async () => {
    const invalid = editSidecar(readFixtureFiles(), (sidecar) => {
      sidecar.version = "not-semver";
    });
    const svc = service({ "test-helper": readFixtureFiles(), broken: invalid });
    expect((await svc.list()).map((summary) => summary.ref)).toEqual(["staples/test-helper"]);
    await expectHttpError(svc.get("staples/broken", CTX), 404);
    await expectHttpError(svc.get("staples/missing", CTX), 404);
    await expectHttpError(svc.get("test-helper", CTX), 404);
  });
});

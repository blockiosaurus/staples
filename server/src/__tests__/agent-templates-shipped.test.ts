import { describe, expect, it } from "vitest";
import type { AgentTemplateAnswers, PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { APP_DEFINITIONS, AGENT_TEMPLATE_SIDECAR_FILE } from "@paperclipai/shared";
import { parseFrontmatterMarkdown } from "@paperclipai/shared/frontmatter";
import { agentTemplatesService, validateAgentTemplatePackage } from "../services/agent-templates.js";
import { validateCron } from "../services/cron.js";
import { listCatalogTeams, readCatalogTeamFile } from "../services/teams-catalog.js";

/**
 * Runs the server's own template validator and renderer over every Staples
 * agent template shipped in the teams catalog. The catalog builder checks the
 * package shape; this closes the gap to the server rules (cron, placeholders,
 * app slugs, skills) that installs depend on.
 */

const EXPECTED_TEMPLATE_SLUGS = ["content-creator", "email-secretary", "newsletter", "researcher", "support-triage"];
const CTX = { companyName: "Acme Co", personName: "Dana Smith", personTimezone: "America/Chicago" };
const APP_SLUGS = new Set(APP_DEFINITIONS.map((app) => app.slug));

async function shippedTemplateTeams() {
  return listCatalogTeams({ kind: "optional", category: "staples", includeAgentTemplates: true });
}

async function readTemplateFiles(teamId: string, paths: string[]) {
  const files: Record<string, string> = {};
  for (const filePath of paths) files[filePath] = (await readCatalogTeamFile(teamId, filePath)).content;
  return files;
}

function recommendedAnswers(questions: PaperclipQuestionSetQuestion[]): AgentTemplateAnswers {
  const answers: AgentTemplateAnswers = {};
  for (const question of questions) {
    const recommended = (question.options ?? []).filter((option) => option.recommended).map((option) => option.id);
    if (question.answerMode === "text") answers[question.id] = question.initialText ?? "";
    else if (question.answerMode === "multi_select") answers[question.id] = recommended;
    else answers[question.id] = recommended[0] ?? "";
  }
  return answers;
}

describe("shipped Staples agent templates", () => {
  it("ships the expected templates", async () => {
    const slugs = (await shippedTemplateTeams()).map((team) => team.slug).sort();
    expect(slugs).toEqual(expect.arrayContaining(EXPECTED_TEMPLATE_SLUGS));
  });

  it("passes the server validator for every shipped template", async () => {
    const failures: Record<string, string[]> = {};
    for (const team of await shippedTemplateTeams()) {
      const files = await readTemplateFiles(
        team.id,
        team.files.filter((file) => file.kind !== "asset" && file.kind !== "script").map((file) => file.path),
      );
      expect(files[AGENT_TEMPLATE_SIDECAR_FILE], team.key).toBeDefined();
      const errors = validateAgentTemplatePackage(files, APP_SLUGS);
      if (errors.length > 0) failures[team.slug] = errors;
    }
    expect(failures).toEqual({});
  });

  it("keeps each AGENTS.md between 60 and 150 lines and covers the required topics", async () => {
    for (const team of await shippedTemplateTeams()) {
      const agentPath = team.files.find((file) => file.kind === "agent")!.path;
      const raw = (await readCatalogTeamFile(team.id, agentPath)).content;
      const lines = raw.trimEnd().split("\n").length;
      expect(lines, `${team.slug} AGENTS.md line count`).toBeGreaterThanOrEqual(60);
      expect(lines, `${team.slug} AGENTS.md line count`).toBeLessThanOrEqual(150);
      const body = parseFrontmatterMarkdown(raw).body;
      expect(body, team.slug).toContain("Company Brief");
      expect(body, team.slug).toContain("connection_request");
      expect(body, team.slug).toContain("Connect <service>");
      expect(body, team.slug).toContain("autopilot");
      expect(body, team.slug).toContain("approval");
      expect(body, team.slug).toContain("task document");
      expect(body, team.slug).toContain("recommended answer");
      // Untrusted-content rule: outside text is data, never instructions.
      expect(body, team.slug).toMatch(/never (an instruction|instructions) to you/);
      expect(body, team.slug).toMatch(/Never create tasks.*request connections/);
    }
  });

  it("renders every shipped template with its recommended answers", async () => {
    const svc = agentTemplatesService();
    const summaries = await svc.list();
    expect(summaries.map((summary) => summary.slug).sort()).toEqual(
      expect.arrayContaining(EXPECTED_TEMPLATE_SLUGS),
    );

    for (const summary of summaries) {
      const detail = await svc.get(summary.ref, CTX);
      const answers = recommendedAnswers(detail.setupQuestions);
      const rendered = await svc.render(summary.ref, detail.version, answers, CTX);
      const label = summary.ref;

      expect(rendered.agent.instructionsMarkdown, label).not.toMatch(/\{\{/);
      expect(rendered.agent.instructionsMarkdown, label).toContain(CTX.companyName);
      expect(rendered.agent.skills.length, label).toBeGreaterThan(0);
      const vendored = new Set(rendered.vendoredSkills.map((skill) => skill.slug));
      for (const skill of rendered.agent.skills) expect(vendored.has(skill), `${label} skill ${skill}`).toBe(true);
      for (const skill of rendered.vendoredSkills) expect(skill.files["SKILL.md"], `${label} ${skill.slug}`).toBeDefined();

      expect(rendered.routines.length, label).toBeGreaterThanOrEqual(1);
      for (const routine of rendered.routines) {
        expect(validateCron(routine.cronExpression), `${label} ${routine.title}`).toBeNull();
        expect(routine.timezone, `${label} ${routine.title}`).toBe(CTX.personTimezone);
        expect(routine.description, `${label} ${routine.title}`).not.toMatch(/\{\{/);
      }

      expect(rendered.starterTasks.length, label).toBeGreaterThanOrEqual(1);
      for (const task of rendered.starterTasks) {
        expect(task.description, `${label} ${task.title}`).not.toMatch(/\{\{/);
      }

      for (const action of rendered.outwardActions) {
        expect(rendered.requiredApps.map((app) => app.capability), label).toContain(action.capability);
      }
    }
  });

  it("states plainly that the email secretary drafts in Gmail and sends only through AgentMail", async () => {
    const svc = agentTemplatesService();
    const detail = await svc.get("staples/email-secretary", CTX);
    const rendered = await svc.render("staples/email-secretary", null, recommendedAnswers(detail.setupQuestions), CTX);
    const text = rendered.agent.instructionsMarkdown;
    expect(text).toContain("Sending from Gmail is blocked on this platform");
    expect(text).toContain("With AgentMail");
    expect(rendered.agent.instructionsMarkdown).toContain("Call them: Dana Smith");
    expect(rendered.outwardActions).toEqual([
      { capability: "email", label: "Sending email", destructiveLabel: "Deleting email" },
    ]);
    expect(rendered.routines.map((routine) => [routine.title, routine.cronExpression])).toEqual([
      ["Daily digest", "0 17 * * 1-5"],
      ["Morning inbox sweep", "0 8 * * 1-5"],
    ]);
  });

  it("picks routine schedules from the setup answers", async () => {
    const svc = agentTemplatesService();
    async function crons(ref: string, overrides: AgentTemplateAnswers) {
      const detail = await svc.get(ref, CTX);
      const rendered = await svc.render(ref, null, { ...recommendedAnswers(detail.setupQuestions), ...overrides }, CTX);
      return Object.fromEntries(rendered.routines.map((routine) => [routine.title, routine.cronExpression]));
    }

    expect((await crons("staples/researcher", { reportDay: "monday" }))["Weekly market brief"]).toBe("0 9 * * 1");
    expect((await crons("staples/researcher", { reportDay: "friday" }))["Weekly market brief"]).toBe("0 9 * * 5");

    expect((await crons("staples/email-secretary", { sweepTime: "7am" }))["Morning inbox sweep"]).toBe("0 7 * * 1-5");
    expect((await crons("staples/email-secretary", { sweepTime: "8am" }))["Morning inbox sweep"]).toBe("0 8 * * 1-5");
    expect((await crons("staples/email-secretary", { sweepTime: "9am" }))["Morning inbox sweep"]).toBe("0 9 * * 1-5");

    expect(await crons("staples/newsletter", { sendDay: "tuesday" })).toEqual({
      "Research and draft the issue": "0 9 * * 0",
      "Schedule the issue": "0 9 * * 2",
    });
    expect(await crons("staples/newsletter", { sendDay: "thursday" })).toEqual({
      "Research and draft the issue": "0 9 * * 2",
      "Schedule the issue": "0 9 * * 4",
    });

    expect(await crons("staples/support-triage", {})).toEqual({ "Support triage": "0 8-18/2 * * 1-5" });
    expect(await crons("staples/content-creator", {})).toEqual({
      "Publish today's posts": "0 10 * * 1-5",
      "Weekly content plan": "0 9 * * 1",
    });
  });
});

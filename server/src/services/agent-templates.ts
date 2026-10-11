import type {
  AgentTemplateAnswers,
  AgentTemplateDetail,
  AgentTemplateSidecar,
  AgentTemplateSummary,
  CatalogTeam,
  PaperclipQuestionSetQuestion,
  RenderedAgentTemplate,
} from "@paperclipai/shared";
import {
  AGENT_TEMPLATE_ANSWER_MAX_CHARS,
  AGENT_TEMPLATE_CATALOG_CATEGORY,
  AGENT_TEMPLATE_REF_PREFIX,
  AGENT_TEMPLATE_SIDECAR_FILE,
  AGGREGATOR_APP_SLUGS,
  APP_DEFINITIONS,
  agentTemplateSidecarSchema,
} from "@paperclipai/shared";
import { asBoolean, asString, asStringArray, parseFrontmatterMarkdown } from "@paperclipai/shared/frontmatter";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validateCron } from "./cron.js";
import { listCatalogSkillsOrEmpty } from "./skills-catalog.js";
import { listCatalogTeams, readCatalogTeamFile } from "./teams-catalog.js";

/**
 * Staples agent templates: single-agent agentcompanies/v1 packages in the
 * teams catalog at `catalog/optional/staples/<slug>/`, described by a
 * `staples.template.json` sidecar. This service lists, describes and renders
 * them; installing happens only through the Assistant's plans.
 */

/** Where template packages come from. Defaults to the shipped teams catalog. */
export interface AgentTemplateCatalogSource {
  /** Catalog entries in the Staples template category. */
  listTeams(): Promise<CatalogTeam[]>;
  /** Text content of one file listed in `team.files`. */
  readFile(team: CatalogTeam, relativePath: string): Promise<string>;
}

export interface AgentTemplatesServiceDeps {
  catalog?: AgentTemplateCatalogSource;
  /** Known app-definition slugs (defaults to `APP_DEFINITIONS`). */
  appSlugs?: Set<string>;
  /** Known skills-catalog slugs (defaults to the shipped skills catalog). */
  catalogSkillSlugs?: Set<string>;
}

export interface AgentTemplateContext {
  companyName: string;
  personName: string;
}

export interface AgentTemplateRenderContext extends AgentTemplateContext {
  personTimezone: string;
}

export interface ValidateAgentTemplatePackageOptions {
  /** Known skills-catalog slugs. Defaults to the shipped skills catalog. */
  catalogSkillSlugs?: Set<string>;
}

const TEAM_FILE = "TEAM.md";
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const CONTEXT_PLACEHOLDERS = new Set(["company.name", "person.name"]);
const ANSWER_PLACEHOLDER = /^answers\.([A-Za-z][A-Za-z0-9_]*)$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Catalog file kinds that never hold template text. */
const NON_TEXT_FILE_KINDS = new Set(["asset", "script"]);

interface TemplateDoc {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

interface LoadedTemplate {
  ref: string;
  slug: string;
  team: CatalogTeam;
  sidecar: AgentTemplateSidecar;
  files: Record<string, string>;
  teamBody: string;
  agent: TemplateDoc;
  tasks: TemplateDoc[];
}

// ---------------------------------------------------------------------------
// Package parsing helpers
// ---------------------------------------------------------------------------

function parseDoc(path: string, raw: string): TemplateDoc {
  const parsed = parseFrontmatterMarkdown(raw);
  return { path, frontmatter: parsed.frontmatter, body: parsed.body, hasFrontmatter: parsed.hasFrontmatter };
}

function docsNamed(files: Record<string, string>, fileName: string): TemplateDoc[] {
  return Object.keys(files)
    .filter((path) => path === fileName || path.endsWith(`/${fileName}`))
    .sort()
    .map((path) => parseDoc(path, files[path]!));
}

function slugFromDocPath(path: string) {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2]! : path;
}

function taskTitle(task: TemplateDoc) {
  return asString(task.frontmatter.name) ?? asString(task.frontmatter.title) ?? asString(task.frontmatter.slug)
    ?? slugFromDocPath(task.path);
}

function hasPlaceholder(text: string) {
  return /\{\{[^{}]*\}\}/.test(text);
}

function isRecurring(task: TemplateDoc) {
  return asBoolean(task.frontmatter.recurring) ?? false;
}

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function vendoredSkillSlugs(files: Record<string, string>) {
  const slugs = new Set<string>();
  for (const path of Object.keys(files)) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (match) slugs.add(match[1]!);
  }
  return slugs;
}

function formatZodPath(path: PropertyKey[]) {
  return path.length > 0 ? path.map(String).join(".") : "(root)";
}

function defaultAppSlugs() {
  return new Set(APP_DEFINITIONS.map((app) => app.slug));
}

function defaultCatalogSkillSlugs() {
  return new Set(listCatalogSkillsOrEmpty().map((skill) => skill.slug));
}

function collectPlaceholderErrors(
  label: string,
  text: string,
  allowAnswers: boolean,
  questionIds: Set<string>,
  errors: string[],
) {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const inner = match[1]!.trim();
    if (CONTEXT_PLACEHOLDERS.has(inner)) continue;
    const answer = ANSWER_PLACEHOLDER.exec(inner);
    if (answer && allowAnswers) {
      if (!questionIds.has(answer[1]!)) {
        errors.push(`${label} placeholder {{${inner}}} does not match a setup question id.`);
      }
      continue;
    }
    const allowed = allowAnswers
      ? "{{answers.<questionId>}}, {{company.name}} or {{person.name}}"
      : "{{company.name}} or {{person.name}}";
    errors.push(`${label} has unknown placeholder {{${inner}}}; use ${allowed}.`);
  }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a whole template package. `files` maps package-relative paths
 * (TEAM.md, staples.template.json, agents/<slug>/AGENTS.md, ...) to text.
 * Returns error messages; an empty array means the package is valid.
 */
export function validateAgentTemplatePackage(
  files: Record<string, string>,
  appSlugs: Set<string>,
  options: ValidateAgentTemplatePackageOptions = {},
): string[] {
  const errors: string[] = [];

  const teamRaw = files[TEAM_FILE];
  if (teamRaw === undefined) {
    errors.push(`${TEAM_FILE} is missing.`);
  } else {
    const teamDoc = parseFrontmatterMarkdown(teamRaw);
    if (!teamDoc.hasFrontmatter) errors.push(`${TEAM_FILE} must start with YAML frontmatter.`);
    if (hasPlaceholder(teamDoc.body)) {
      errors.push(`${TEAM_FILE} body cannot contain placeholders; it is shown to people as written.`);
    }
  }

  // Vendored skills are imported verbatim, so placeholders would never be filled.
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.startsWith("skills/") && hasPlaceholder(content)) {
      errors.push(`${filePath} cannot contain placeholders; vendored skill files are not rendered.`);
    }
  }

  let sidecar: AgentTemplateSidecar | null = null;
  const sidecarRaw = files[AGENT_TEMPLATE_SIDECAR_FILE];
  if (sidecarRaw === undefined) {
    errors.push(`${AGENT_TEMPLATE_SIDECAR_FILE} is missing.`);
  } else {
    let json: unknown = null;
    try {
      json = JSON.parse(sidecarRaw);
    } catch (error) {
      errors.push(`${AGENT_TEMPLATE_SIDECAR_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (json !== null) {
      const parsed = agentTemplateSidecarSchema.safeParse(json);
      if (parsed.success) {
        sidecar = parsed.data as AgentTemplateSidecar;
      } else {
        for (const issue of parsed.error.issues) {
          errors.push(`${AGENT_TEMPLATE_SIDECAR_FILE} ${formatZodPath(issue.path)}: ${issue.message}`);
        }
        // Keep checking cross-file rules against whatever structure is present.
        sidecar = json as AgentTemplateSidecar;
      }
    }
  }

  const questions = Array.isArray(sidecar?.setupQuestions) ? sidecar!.setupQuestions : [];
  const questionIds = new Set(questions.map((question) => question?.id).filter((id): id is string => typeof id === "string"));
  const requiredApps = Array.isArray(sidecar?.requiredApps) ? sidecar!.requiredApps : [];

  // Context placeholders only, inside the setup questions themselves.
  for (const question of questions) {
    if (!question || typeof question !== "object") continue;
    const texts = [
      question.prompt,
      question.header,
      question.helpText,
      question.initialText,
      question.customAnswer?.label,
      question.customAnswer?.placeholder,
      ...(Array.isArray(question.options) ? question.options : []).flatMap((option) => [option?.label, option?.description]),
    ];
    for (const text of texts) {
      if (typeof text === "string") {
        collectPlaceholderErrors(`${AGENT_TEMPLATE_SIDECAR_FILE} question "${question.id}"`, text, false, questionIds, errors);
      }
    }
  }

  // Required apps resolve to known services.
  const knownAppSlugs = new Set<string>([...appSlugs, ...AGGREGATOR_APP_SLUGS]);
  for (const app of requiredApps) {
    for (const slug of Array.isArray(app?.anyOf) ? app.anyOf : []) {
      if (!knownAppSlugs.has(slug)) {
        errors.push(`${AGENT_TEMPLATE_SIDECAR_FILE} requiredApps "${app.capability}" names unknown app slug "${slug}".`);
      }
    }
  }

  // Agent
  const agents = docsNamed(files, "AGENTS.md");
  if (agents.length !== 1) {
    errors.push(`A template must contain exactly one AGENTS.md (found ${agents.length}).`);
  }
  const vendored = vendoredSkillSlugs(files);
  let catalogSkillSlugs = options.catalogSkillSlugs;
  for (const agent of agents) {
    if (!agent.hasFrontmatter) errors.push(`${agent.path} must start with YAML frontmatter.`);
    if (!asString(agent.frontmatter.name)) errors.push(`${agent.path} frontmatter must include name.`);
    collectPlaceholderErrors(agent.path, agent.body, true, questionIds, errors);
    for (const field of ["name", "title", "role"] as const) {
      const value = asString(agent.frontmatter[field]);
      if (value && hasPlaceholder(value)) {
        errors.push(`${agent.path} ${field} cannot contain placeholders; use them in the body.`);
      }
    }
    const skillsValue = agent.frontmatter.skills;
    const skills = skillsValue === undefined ? [] : asStringArray(skillsValue);
    if (!skills) {
      errors.push(`${agent.path} frontmatter field skills must be an array of strings.`);
      continue;
    }
    for (const skill of skills) {
      if (vendored.has(skill)) continue;
      catalogSkillSlugs ??= defaultCatalogSkillSlugs();
      if (!catalogSkillSlugs.has(skill)) {
        errors.push(`${agent.path} skill "${skill}" is neither vendored under skills/${skill}/SKILL.md nor a skills-catalog slug.`);
      }
    }
  }

  // Tasks
  for (const task of docsNamed(files, "TASK.md")) {
    if (!task.hasFrontmatter) errors.push(`${task.path} must start with YAML frontmatter.`);
    collectPlaceholderErrors(task.path, task.body, true, questionIds, errors);
    if (hasPlaceholder(taskTitle(task))) {
      errors.push(`${task.path} name cannot contain placeholders; use them in the body.`);
    }
    const recurring = isRecurring(task);
    const schedule = task.frontmatter.schedule;
    if (schedule === undefined || schedule === null) {
      if (recurring) errors.push(`${task.path} is recurring and must declare a cron schedule.`);
    } else if (typeof schedule !== "string") {
      errors.push(`${task.path} schedule must be a 5-field cron string.`);
    } else {
      const cronError = validateCron(schedule);
      if (cronError) errors.push(`${task.path} schedule "${schedule}" is not a valid cron expression: ${cronError}`);
      if (!recurring) errors.push(`${task.path} declares a schedule but is not recurring: true.`);
    }
    const timezone = task.frontmatter.timezone;
    if (timezone !== undefined && timezone !== null) {
      if (typeof timezone !== "string" || (timezone !== "person" && !isValidTimezone(timezone))) {
        errors.push(`${task.path} timezone must be "person" or an IANA time zone.`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function cleanText(value: string) {
  return value.replace(CONTROL_CHARACTERS, "").trim();
}

/**
 * Single-pass substitution: inserted values are never re-scanned, so an answer
 * containing `{{answers.x}}` lands literally. Unknown placeholders are left
 * as written (the validator rejects them before a template ships).
 */
function substitute(text: string, values: Map<string, string>) {
  return text.replace(PLACEHOLDER_PATTERN, (whole, inner: string) => {
    const value = values.get(inner.trim());
    return value === undefined ? whole : value;
  });
}

function contextValues(ctx: AgentTemplateContext) {
  return new Map<string, string>([
    ["company.name", cleanText(ctx.companyName)],
    ["person.name", cleanText(ctx.personName)],
  ]);
}

function resolveQuestionContext(question: PaperclipQuestionSetQuestion, values: Map<string, string>): PaperclipQuestionSetQuestion {
  const sub = (text: string | undefined) => (text === undefined ? undefined : substitute(text, values));
  return {
    ...question,
    prompt: substitute(question.prompt, values),
    ...(question.header !== undefined ? { header: sub(question.header) } : {}),
    ...(question.helpText !== undefined ? { helpText: sub(question.helpText) } : {}),
    ...(question.initialText !== undefined ? { initialText: sub(question.initialText) } : {}),
    ...(question.options
      ? {
          options: question.options.map((option) => ({
            ...option,
            label: substitute(option.label, values),
            ...(option.description !== undefined ? { description: sub(option.description) } : {}),
          })),
        }
      : {}),
    ...(question.customAnswer
      ? {
          customAnswer: {
            ...question.customAnswer,
            ...(question.customAnswer.label !== undefined ? { label: sub(question.customAnswer.label) } : {}),
            ...(question.customAnswer.placeholder !== undefined ? { placeholder: sub(question.customAnswer.placeholder) } : {}),
          },
        }
      : {}),
  };
}

function resolveAnswers(questions: PaperclipQuestionSetQuestion[], answers: AgentTemplateAnswers) {
  const errors: string[] = [];
  const failed = new Set<string>();
  const values = new Map<string, string>();
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answerRecord: Record<string, unknown> =
    answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};

  for (const id of Object.keys(answerRecord)) {
    if (!byId.has(id)) errors.push(`Unknown setup question "${id}".`);
  }

  const fail = (question: PaperclipQuestionSetQuestion, message: string) => {
    failed.add(question.id);
    errors.push(message);
  };

  const freeText = (question: PaperclipQuestionSetQuestion, raw: string): string | null => {
    const text = cleanText(raw);
    if (text.length > AGENT_TEMPLATE_ANSWER_MAX_CHARS) {
      fail(question, `Answer to "${question.id}" is longer than ${AGENT_TEMPLATE_ANSWER_MAX_CHARS} characters.`);
      return null;
    }
    return text;
  };

  const choice = (question: PaperclipQuestionSetQuestion, raw: string): string | null => {
    const option = question.options?.find((entry) => entry.id === raw);
    if (option) return option.label;
    if (question.customAnswer?.enabled) return freeText(question, raw);
    fail(question, `Answer to "${question.id}" is not one of its options.`);
    return null;
  };

  for (const question of questions) {
    const raw = Object.hasOwn(answerRecord, question.id) ? answerRecord[question.id] : undefined;
    let value = "";
    if (raw !== undefined && raw !== null) {
      if (question.answerMode === "multi_select") {
        const rawItems = Array.isArray(raw) ? raw : [raw];
        if (rawItems.some((item) => typeof item !== "string")) {
          fail(question, `Answer to "${question.id}" must be a list of strings.`);
        } else {
          const items = Array.from(new Set((rawItems as string[]).map((item) => cleanText(item)).filter(Boolean)));
          const maxItems = (question.options?.length ?? 0) + (question.customAnswer?.enabled ? 1 : 0);
          if (items.length > maxItems) {
            fail(question, `Answer to "${question.id}" has more than ${maxItems} choices.`);
          } else {
            const labels = Array.from(new Set(
              items.map((item) => choice(question, item)).filter((label): label is string => label !== null && label !== ""),
            ));
            value = labels.join(", ");
            if (value.length > AGENT_TEMPLATE_ANSWER_MAX_CHARS) {
              fail(question, `Answer to "${question.id}" is longer than ${AGENT_TEMPLATE_ANSWER_MAX_CHARS} characters.`);
            }
          }
        }
      } else if (typeof raw !== "string") {
        fail(question, `Answer to "${question.id}" must be a single text value.`);
      } else if (question.answerMode === "single_select") {
        const trimmed = cleanText(raw);
        value = trimmed ? (choice(question, trimmed) ?? "") : "";
      } else {
        value = freeText(question, raw) ?? "";
        const limits = question.textValidation;
        if (value && limits?.minLength !== undefined && value.length < limits.minLength) {
          fail(question, `Answer to "${question.id}" must be at least ${limits.minLength} characters.`);
        }
        if (value && limits?.maxLength !== undefined && value.length > limits.maxLength) {
          fail(question, `Answer to "${question.id}" must be at most ${limits.maxLength} characters.`);
        }
      }
    }
    if (failed.has(question.id)) value = "";
    else if (question.required && value === "") fail(question, `Setup question "${question.id}" is required.`);
    values.set(`answers.${question.id}`, value);
  }

  return { values, errors };
}

function parseTemplateRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(AGENT_TEMPLATE_REF_PREFIX)) return null;
  const slug = trimmed.slice(AGENT_TEMPLATE_REF_PREFIX.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

function summarize(template: LoadedTemplate): AgentTemplateSummary {
  const { sidecar } = template;
  return {
    ref: template.ref,
    slug: template.slug,
    name: template.team.name,
    tagline: sidecar.tagline,
    icon: sidecar.icon,
    marketplaceCategory: sidecar.marketplaceCategory,
    version: sidecar.version,
    needs: sidecar.requiredApps.map((app) => ({
      capability: app.capability,
      anyOf: [...app.anyOf],
      optional: app.optional === true,
      why: app.why,
    })),
    asksBefore: sidecar.outwardActions.map((action) => action.label),
    routines: template.tasks.filter(isRecurring).map((task) => ({
      title: taskTitle(task),
      schedule: asString(task.frontmatter.schedule) ?? "",
      timezone: asString(task.frontmatter.timezone) ?? "UTC",
    })),
    defaultBudgetMonthlyCents: sidecar.defaultBudgetMonthlyCents ?? null,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const defaultCatalogSource: AgentTemplateCatalogSource = {
  listTeams: () =>
    listCatalogTeams({ kind: "optional", category: AGENT_TEMPLATE_CATALOG_CATEGORY, includeAgentTemplates: true }),
  readFile: async (team, relativePath) => (await readCatalogTeamFile(team.id, relativePath)).content,
};

export function agentTemplatesService(deps: AgentTemplatesServiceDeps = {}) {
  const catalog = deps.catalog ?? defaultCatalogSource;
  const cache = new Map<string, LoadedTemplate | null>();

  async function loadTemplate(team: CatalogTeam): Promise<LoadedTemplate | null> {
    const cacheKey = `${team.id}@${team.contentHash}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    const files: Record<string, string> = {};
    for (const file of team.files) {
      if (NON_TEXT_FILE_KINDS.has(file.kind)) continue;
      files[file.path] = await catalog.readFile(team, file.path);
    }
    const errors = validateAgentTemplatePackage(files, deps.appSlugs ?? defaultAppSlugs(), {
      catalogSkillSlugs: deps.catalogSkillSlugs,
    });
    if (errors.length > 0) {
      logger.warn({ template: team.key, errors }, "agent template failed validation; hiding it");
      cache.set(cacheKey, null);
      return null;
    }

    const sidecar = agentTemplateSidecarSchema.parse(JSON.parse(files[AGENT_TEMPLATE_SIDECAR_FILE]!)) as AgentTemplateSidecar;
    const loaded: LoadedTemplate = {
      ref: `${AGENT_TEMPLATE_REF_PREFIX}${team.slug}`,
      slug: team.slug,
      team,
      sidecar,
      files,
      teamBody: parseFrontmatterMarkdown(files[TEAM_FILE]!).body,
      agent: docsNamed(files, "AGENTS.md")[0]!,
      tasks: docsNamed(files, "TASK.md"),
    };
    cache.set(cacheKey, loaded);
    return loaded;
  }

  async function templateTeams() {
    return (await catalog.listTeams()).filter(
      (team) => team.category === AGENT_TEMPLATE_CATALOG_CATEGORY && team.staplesTemplate !== undefined,
    );
  }

  /** Visible (non-preview) template by ref, or 404. */
  async function getVisible(ref: string): Promise<LoadedTemplate> {
    const slug = parseTemplateRef(ref);
    const team = slug ? (await templateTeams()).find((entry) => entry.slug === slug) : undefined;
    const loaded = team ? await loadTemplate(team) : null;
    if (!loaded || loaded.sidecar.preview === true) throw notFound("Agent template not found");
    return loaded;
  }

  return {
    async list(opts: { includePreview?: boolean } = {}): Promise<AgentTemplateSummary[]> {
      const out: AgentTemplateSummary[] = [];
      for (const team of await templateTeams()) {
        const loaded = await loadTemplate(team);
        if (!loaded) continue;
        if (loaded.sidecar.preview === true && !opts.includePreview) continue;
        out.push(summarize(loaded));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref));
    },

    async get(ref: string, ctx: AgentTemplateContext): Promise<AgentTemplateDetail> {
      const loaded = await getVisible(ref);
      const values = contextValues(ctx);
      return {
        ...summarize(loaded),
        description: loaded.teamBody,
        setupQuestions: loaded.sidecar.setupQuestions.map((question) => resolveQuestionContext(question, values)),
      };
    },

    async render(
      ref: string,
      version: string | null,
      answers: AgentTemplateAnswers,
      ctx: AgentTemplateRenderContext,
    ): Promise<RenderedAgentTemplate> {
      const loaded = await getVisible(ref);
      const { sidecar } = loaded;
      if (version !== null && version !== sidecar.version) {
        throw conflict(
          `Agent template ${loaded.ref} is now version ${sidecar.version}, not ${version}. Review the template again before installing.`,
          { ref: loaded.ref, requestedVersion: version, currentVersion: sidecar.version },
        );
      }

      const resolved = resolveAnswers(sidecar.setupQuestions, answers ?? {});
      if (resolved.errors.length > 0) {
        throw unprocessable("Invalid agent template answers", { errors: resolved.errors });
      }
      const values = contextValues(ctx);
      for (const [key, value] of resolved.values) values.set(key, value);

      const agentSlug = asString(loaded.agent.frontmatter.slug) ?? slugFromDocPath(loaded.agent.path);
      const vendoredSkills = [...vendoredSkillSlugs(loaded.files)].sort().map((slug) => {
        const prefix = `skills/${slug}/`;
        const files: Record<string, string> = {};
        for (const [path, content] of Object.entries(loaded.files)) {
          if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
        }
        return { slug, files };
      });

      return {
        ref: loaded.ref,
        version: sidecar.version,
        agent: {
          name: asString(loaded.agent.frontmatter.name) ?? agentSlug,
          role: asString(loaded.agent.frontmatter.role) ?? "general",
          title: asString(loaded.agent.frontmatter.title) ?? asString(loaded.agent.frontmatter.name) ?? agentSlug,
          instructionsMarkdown: substitute(loaded.agent.body, values),
          skills: asStringArray(loaded.agent.frontmatter.skills) ?? [],
        },
        vendoredSkills,
        routines: loaded.tasks.filter(isRecurring).map((task) => {
          const timezone = asString(task.frontmatter.timezone) ?? "UTC";
          return {
            title: taskTitle(task),
            description: substitute(task.body, values),
            cronExpression: asString(task.frontmatter.schedule)!,
            timezone: timezone === "person" ? ctx.personTimezone : timezone,
          };
        }),
        starterTasks: loaded.tasks.filter((task) => !isRecurring(task)).map((task) => ({
          title: taskTitle(task),
          description: substitute(task.body, values),
        })),
        requiredApps: sidecar.requiredApps.map((app) => ({ ...app, anyOf: [...app.anyOf] })),
        outwardActions: sidecar.outwardActions.map((action) => ({ ...action })),
        defaultBudgetMonthlyCents: sidecar.defaultBudgetMonthlyCents ?? null,
        recommendedAdapterType: sidecar.recommendedAdapterType ?? null,
      };
    },
  };
}

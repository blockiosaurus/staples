import type { PaperclipQuestionSetQuestion } from "./issue.js";

/**
 * Staples agent templates: single-agent agentcompanies/v1 packages shipped in
 * the teams catalog under `catalog/optional/staples/<slug>/`, with a typed
 * `staples.template.json` sidecar next to TEAM.md. They are installed only
 * through the Assistant's plans.
 */

export const AGENT_TEMPLATE_CATEGORIES = [
  "communication",
  "content",
  "operations",
  "engineering",
  "finance",
  "research",
] as const;

export type AgentTemplateCategory = (typeof AGENT_TEMPLATE_CATEGORIES)[number];

/** Catalog category directory that holds Staples agent templates. */
export const AGENT_TEMPLATE_CATALOG_CATEGORY = "staples";
/** Sidecar file name, next to TEAM.md. */
export const AGENT_TEMPLATE_SIDECAR_FILE = "staples.template.json";
/** Ref prefix: a template ref is `staples/<slug>`. */
export const AGENT_TEMPLATE_REF_PREFIX = "staples/";
/** Maximum length of one person-typed setup answer, after trimming. */
export const AGENT_TEMPLATE_ANSWER_MAX_CHARS = 500;

export interface AgentTemplateRequiredApp {
  capability: string;
  anyOf: string[];
  why: string;
  optional?: boolean;
}

export interface AgentTemplateOutwardAction {
  /** Keyed by a `requiredApps[].capability`. */
  capability: string;
  label: string;
  destructiveLabel?: string;
}

export interface AgentTemplateSidecar {
  /** semver */
  version: string;
  /** At most 80 characters. */
  tagline: string;
  /** lucide icon name */
  icon: string;
  marketplaceCategory: AgentTemplateCategory;
  requiredApps: AgentTemplateRequiredApp[];
  setupQuestions: PaperclipQuestionSetQuestion[];
  outwardActions: AgentTemplateOutwardAction[];
  recommendedAdapterType?: string;
  defaultBudgetMonthlyCents?: number;
  preview?: boolean;
}

/** Card data. */
export interface AgentTemplateSummary {
  /** "staples/<slug>" */
  ref: string;
  slug: string;
  name: string;
  tagline: string;
  icon: string;
  marketplaceCategory: AgentTemplateCategory;
  version: string;
  needs: { capability: string; anyOf: string[]; optional: boolean; why: string }[];
  /** outwardActions labels */
  asksBefore: string[];
  /** `timezone` is "person" or an IANA zone, as written in TASK.md. */
  routines: { title: string; schedule: string; timezone: string }[];
  defaultBudgetMonthlyCents: number | null;
}

export interface AgentTemplateDetail extends AgentTemplateSummary {
  /** TEAM.md body (markdown) */
  description: string;
  /** Context placeholders (`{{company.name}}`, `{{person.name}}`) resolved. */
  setupQuestions: PaperclipQuestionSetQuestion[];
}

export interface RenderedAgentTemplate {
  ref: string;
  version: string;
  agent: {
    name: string;
    role: string;
    title: string;
    instructionsMarkdown: string;
    /** Skill slugs as written in AGENTS.md frontmatter. */
    skills: string[];
  };
  /** `files` keys are relative to the skill directory (e.g. "SKILL.md"). */
  vendoredSkills: { slug: string; files: Record<string, string> }[];
  routines: { title: string; description: string; cronExpression: string; timezone: string }[];
  starterTasks: { title: string; description: string }[];
  requiredApps: AgentTemplateRequiredApp[];
  outwardActions: AgentTemplateOutwardAction[];
  defaultBudgetMonthlyCents: number | null;
  recommendedAdapterType: string | null;
}

export type AgentTemplateAnswers = Record<string, string | string[]>;

import { z } from "zod";
import { missingQuestionRecommendations } from "../question-set.js";
import { AGENT_TEMPLATE_CATEGORIES } from "../types/agent-template.js";
import { paperclipQuestionSchema } from "./issue.js";

/**
 * Aggregator-backed services (no app-definition JSON of their own) that a
 * template may name in `requiredApps[].anyOf`. Connection routing resolves
 * them through Composio/Arcade (see `connection-routing.ts`).
 */
export const AGGREGATOR_APP_SLUGS = [
  "linkedin",
  "x",
  "reddit",
  "youtube",
  "instagram",
  "facebook",
  "tiktok",
] as const;

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_-]*$/;
/**
 * Tool-name globs for an outward action: letters, digits, `_`, `-`, `.`, `:`
 * and `*` (any run of characters). Matched case-insensitively against the
 * whole tool name. At least one non-`*` character, so a pattern never
 * matches every tool by accident.
 */
export const AGENT_TEMPLATE_TOOL_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_.:*-]{1,80}$/;
/** Question ids are used in `{{answers.<id>}}` placeholders. */
export const AGENT_TEMPLATE_QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export const agentTemplateRequiredAppSchema = z
  .object({
    capability: z.string().regex(CAPABILITY_PATTERN, "capability must be a lowercase identifier"),
    anyOf: z.array(z.string().regex(SLUG_PATTERN, "app slugs must be lowercase URL slugs")).min(1).max(20),
    why: z.string().trim().min(1).max(300),
    optional: z.boolean().optional(),
  })
  .strict();

export const agentTemplateOutwardActionSchema = z
  .object({
    capability: z.string().regex(CAPABILITY_PATTERN, "capability must be a lowercase identifier"),
    label: z.string().trim().min(1).max(200),
    destructiveLabel: z.string().trim().min(1).max(200).optional(),
    /**
     * Globs over tool names that perform this outward action (send, publish,
     * deploy...). Install seeds an "ask first" rule for write-risk tools of
     * the agent matching any of them; other writes (drafts, labels) are not
     * gated by the template.
     */
    toolPatterns: z
      .array(z.string().regex(AGENT_TEMPLATE_TOOL_PATTERN, "tool patterns use letters, digits, _ - . : and * only"))
      .min(1)
      .max(20),
  })
  .strict();

/**
 * Every setup question carries a recommendation: single_select marks exactly
 * one option recommended, multi_select at least one, text questions set
 * `initialText`. Returns the ids of questions that break the rule.
 */
export function agentTemplateQuestionsMissingRecommendations(
  questions: z.infer<typeof paperclipQuestionSchema>[],
): string[] {
  const missing = new Set(
    missingQuestionRecommendations({
      questions: [],
      questionSet: { schema: "paperclip.question_set.v1", questions },
    }),
  );
  for (const question of questions) {
    if (question.answerMode === "text" && !question.initialText?.trim()) missing.add(question.id);
  }
  return questions.map((question) => question.id).filter((id) => missing.has(id));
}

export const agentTemplateSidecarSchema = z
  .object({
    version: z.string().regex(SEMVER_PATTERN, "version must be semver (e.g. 1.0.0)"),
    tagline: z.string().trim().min(1).max(80),
    icon: z.string().regex(SLUG_PATTERN, "icon must be a lucide icon name (kebab-case)"),
    marketplaceCategory: z.enum(AGENT_TEMPLATE_CATEGORIES),
    requiredApps: z.array(agentTemplateRequiredAppSchema).max(20),
    setupQuestions: z.array(paperclipQuestionSchema).max(32),
    outwardActions: z.array(agentTemplateOutwardActionSchema).max(20),
    recommendedAdapterType: z.string().trim().min(1).max(100).optional(),
    defaultBudgetMonthlyCents: z.number().int().min(0).optional(),
    preview: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    scheduleByAnswer: z
      .record(
        z.string().regex(SLUG_PATTERN, "task slugs must be lowercase URL slugs"),
        z
          .object({
            questionId: z.string().min(1).max(160),
            cron: z.record(z.string().min(1).max(160), z.string().trim().min(1).max(200)),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const questionIds = value.setupQuestions.map((question) => question.id);
    questionIds.forEach((id, index) => {
      if (!AGENT_TEMPLATE_QUESTION_ID_PATTERN.test(id)) {
        ctx.addIssue({
          code: "custom",
          message: `question id "${id}" must be a letter followed by letters, digits or underscores`,
          path: ["setupQuestions", index, "id"],
        });
      }
    });
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({ code: "custom", message: "question ids must be unique", path: ["setupQuestions"] });
    }
    for (const id of agentTemplateQuestionsMissingRecommendations(value.setupQuestions)) {
      ctx.addIssue({
        code: "custom",
        message: `question "${id}" needs a recommendation (single choice: exactly one recommended option; multiple choice: at least one; text: initialText)`,
        path: ["setupQuestions", questionIds.indexOf(id)],
      });
    }
    const capabilities = value.requiredApps.map((app) => app.capability);
    if (new Set(capabilities).size !== capabilities.length) {
      ctx.addIssue({ code: "custom", message: "requiredApps capabilities must be unique", path: ["requiredApps"] });
    }
    value.outwardActions.forEach((action, index) => {
      if (!capabilities.includes(action.capability)) {
        ctx.addIssue({
          code: "custom",
          message: `outward action capability "${action.capability}" does not match a requiredApps capability`,
          path: ["outwardActions", index, "capability"],
        });
      }
    });
    for (const [taskSlug, rule] of Object.entries(value.scheduleByAnswer ?? {})) {
      const path = ["scheduleByAnswer", taskSlug];
      const question = value.setupQuestions.find((entry) => entry.id === rule.questionId);
      if (!question) {
        ctx.addIssue({ code: "custom", message: `scheduleByAnswer question "${rule.questionId}" is not a setup question`, path });
        continue;
      }
      if (question.answerMode !== "single_select") {
        ctx.addIssue({ code: "custom", message: `scheduleByAnswer question "${rule.questionId}" must be single_select`, path });
        continue;
      }
      const optionIds = (question.options ?? []).map((option) => option.id);
      for (const optionId of optionIds) {
        if (!Object.hasOwn(rule.cron, optionId)) {
          ctx.addIssue({ code: "custom", message: `scheduleByAnswer for "${taskSlug}" has no cron for option "${optionId}"`, path: [...path, "cron"] });
        }
      }
      for (const optionId of Object.keys(rule.cron)) {
        if (!optionIds.includes(optionId)) {
          ctx.addIssue({ code: "custom", message: `scheduleByAnswer for "${taskSlug}" names unknown option "${optionId}"`, path: [...path, "cron", optionId] });
        }
      }
    }
    if (value.readOnly === true && value.outwardActions.length > 0) {
      ctx.addIssue({ code: "custom", message: "a readOnly template cannot declare outwardActions", path: ["outwardActions"] });
    }
    const outwardCapabilities = value.outwardActions.map((action) => action.capability);
    if (new Set(outwardCapabilities).size !== outwardCapabilities.length) {
      ctx.addIssue({ code: "custom", message: "outwardActions capabilities must be unique", path: ["outwardActions"] });
    }
  });

export const agentTemplateAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())]),
);

export type AgentTemplateSidecarInput = z.infer<typeof agentTemplateSidecarSchema>;

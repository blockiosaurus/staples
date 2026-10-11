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

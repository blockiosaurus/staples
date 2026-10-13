import type { AskUserQuestionsPayload, PaperclipQuestionSetPayload } from "./types/issue.js";

/** Agent-facing rejection for a question that carries no recommended answer. */
export const QUESTION_RECOMMENDATION_REQUIRED_MESSAGE =
  "Each question with options needs a recommended answer: mark exactly one option recommended: true (single choice), or at least one (multiple choice). Text questions are exempt; set initialText to suggest an answer.";

function syntheticOptionId(existing: readonly string[], preferred: string): string {
  const ids = new Set(existing);
  let candidate = preferred;
  for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${preferred}_${suffix}`;
  return candidate;
}

/** Project a complete canonical form into the legacy storage/answer contract. */
export function questionSetToAskUserQuestionsPayload(
  questionSet: PaperclipQuestionSetPayload,
): AskUserQuestionsPayload {
  return {
    version: 1,
    ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
    ...(questionSet.submitLabel ? { submitLabel: questionSet.submitLabel.slice(0, 120) } : {}),
    questionSet,
    questions: questionSet.questions.map((question) => {
      const options = (question.options ?? []).map(({ id, label, description, recommended }) => ({
        id, label,
        ...(description !== undefined ? { description } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
      }));
      const freeTextOption = question.answerMode === "text"
        ? {
            id: "paperclip_text_answer",
            label: question.header || "Type an answer",
            ...(question.textValidation?.inputType
              ? { description: `Expected ${question.textValidation.inputType} input` } : {}),
            freeText: true as const,
          }
        : question.customAnswer?.enabled
          ? {
              id: syntheticOptionId(options.map((option) => option.id), "paperclip_custom_answer"),
              label: question.customAnswer.label || "Other",
              ...(question.customAnswer.placeholder !== undefined
                ? { description: question.customAnswer.placeholder } : {}),
              freeText: true as const,
            }
          : null;
      return {
        id: question.id,
        prompt: question.prompt,
        ...((question.helpText || question.header) ? { helpText: question.helpText ?? question.header } : {}),
        selectionMode: question.answerMode === "multi_select" ? "multi" : "single",
        required: question.required,
        allowOther: freeTextOption !== null,
        options: freeTextOption ? [...options, freeTextOption] : options,
      };
    }),
  };
}

/**
 * Present a stored payload as a canonical question set. A retained exact
 * presentation wins; legacy questions-only payloads are converted, keeping
 * `recommended` so the form can pre-select it.
 */
export function askUserQuestionsPayloadToQuestionSet(
  payload: Pick<AskUserQuestionsPayload, "questions" | "questionSet" | "submitLabel">,
  context: { title?: string | null } = {},
): PaperclipQuestionSetPayload {
  if (payload.questionSet) return payload.questionSet;
  return {
    schema: "paperclip.question_set.v1",
    ...(context.title ? { title: context.title } : {}),
    ...(payload.submitLabel ? { submitLabel: payload.submitLabel } : {}),
    questions: payload.questions.map((question) => {
      const customOption = question.options.find((option) => option.freeText === true);
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode: question.selectionMode === "multi" ? "multi_select" as const : "single_select" as const,
        options: question.options
          .filter((option) => option.freeText !== true)
          .map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            ...(option.recommended !== undefined ? { recommended: option.recommended } : {}),
          })),
        ...(customOption
          ? {
              customAnswer: {
                enabled: true as const,
                label: customOption.label,
                ...(customOption.description ? { placeholder: customOption.description } : {}),
              },
            }
          : {}),
      };
    }),
  };
}

/**
 * The single rule every question-creation path enforces: a single-choice
 * question marks exactly one option recommended, a multiple-choice question at
 * least one. Text questions may prefill `initialText` but are not required to.
 * The canonical question set is checked when present (it is what people see);
 * otherwise legacy questions are checked, ignoring free-text options. Returns
 * the ids of questions that break the rule.
 */
export function missingQuestionRecommendations(
  payload: Pick<AskUserQuestionsPayload, "questions" | "questionSet">,
): string[] {
  const questions = payload.questionSet
    ? payload.questionSet.questions.map((question) => ({
        id: question.id,
        mode: question.answerMode,
        options: question.options ?? [],
      }))
    : payload.questions.map((question) => ({
        id: question.id,
        mode: question.selectionMode === "multi" ? "multi_select" as const : "single_select" as const,
        options: question.options.filter((option) => option.freeText !== true),
      }));
  return questions
    .filter((question) => {
      if (question.mode === "text" || question.options.length === 0) return false;
      const recommended = question.options.filter((option) => option.recommended === true).length;
      return question.mode === "single_select" ? recommended !== 1 : recommended === 0;
    })
    .map((question) => question.id);
}

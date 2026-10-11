import { describe, expect, it } from "vitest";
import {
  askUserQuestionsPayloadToQuestionSet,
  missingQuestionRecommendations,
  QUESTION_RECOMMENDATION_REQUIRED_MESSAGE,
  questionSetToAskUserQuestionsPayload,
} from "./question-set.js";
import { askUserQuestionsPayloadSchema, createIssueThreadInteractionSchema } from "./validators/issue.js";
import type { AskUserQuestionsPayload, PaperclipQuestionSetPayload } from "./types/issue.js";

function questionSet(questions: PaperclipQuestionSetPayload["questions"]): PaperclipQuestionSetPayload {
  return { schema: "paperclip.question_set.v1", questions };
}

const single = (recommended: Array<boolean | undefined>) => ({
  id: "q",
  prompt: "Pick",
  required: true,
  answerMode: "single_select" as const,
  options: recommended.map((flag, index) => ({
    id: `o${index}`,
    label: `Option ${index}`,
    ...(flag === undefined ? {} : { recommended: flag }),
  })),
});

describe("question recommendations", () => {
  it("states the agent-facing rule", () => {
    expect(QUESTION_RECOMMENDATION_REQUIRED_MESSAGE).toBe(
      "Each question with options needs a recommended answer: mark exactly one option recommended: true (single choice), or at least one (multiple choice). Text questions are exempt; set initialText to suggest an answer.",
    );
  });

  it("accepts exactly one recommended single-select option", () => {
    const payload = questionSetToAskUserQuestionsPayload(questionSet([single([true, undefined])]));
    expect(missingQuestionRecommendations(payload)).toEqual([]);
  });

  it("rejects single-select questions with zero or several recommendations", () => {
    expect(missingQuestionRecommendations(questionSetToAskUserQuestionsPayload(questionSet([single([undefined, false])]))))
      .toEqual(["q"]);
    expect(missingQuestionRecommendations(questionSetToAskUserQuestionsPayload(questionSet([single([true, true])]))))
      .toEqual(["q"]);
  });

  it("requires at least one recommendation for multi-select", () => {
    const multi = (flags: Array<boolean | undefined>) => ({ ...single(flags), answerMode: "multi_select" as const });
    expect(missingQuestionRecommendations(questionSetToAskUserQuestionsPayload(questionSet([multi([undefined, undefined])]))))
      .toEqual(["q"]);
    expect(missingQuestionRecommendations(questionSetToAskUserQuestionsPayload(questionSet([multi([true, true])]))))
      .toEqual([]);
  });

  it("does not require initialText for text questions", () => {
    const payload = questionSetToAskUserQuestionsPayload(questionSet([
      { id: "t", prompt: "Say", required: true, answerMode: "text" },
    ]));
    expect(missingQuestionRecommendations(payload)).toEqual([]);
  });

  it("applies the same rule to legacy questions-only payloads, ignoring free-text options", () => {
    const legacy: AskUserQuestionsPayload = {
      version: 1,
      questions: [
        { id: "a", prompt: "A", selectionMode: "single", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
        { id: "b", prompt: "B", selectionMode: "multi", options: [{ id: "x", label: "X", recommended: true }] },
        { id: "c", prompt: "C", selectionMode: "single", options: [{ id: "free", label: "Describe", freeText: true }] },
        { id: "d", prompt: "D", selectionMode: "single", options: [
          { id: "x", label: "X", recommended: true },
          { id: "free", label: "Other", freeText: true },
        ] },
      ],
    };
    expect(missingQuestionRecommendations(legacy)).toEqual(["a"]);
  });

  it("checks the canonical question set when both representations are present", () => {
    const payload = {
      ...questionSetToAskUserQuestionsPayload(questionSet([single([undefined, undefined])])),
    };
    payload.questions = payload.questions.map((question) => ({
      ...question,
      options: question.options.map((option, index) => ({ ...option, recommended: index === 0 })),
    }));
    expect(missingQuestionRecommendations(payload)).toEqual(["q"]);
  });
});

describe("question set projection keeps recommended", () => {
  it("projects recommended into legacy options and the create schema keeps it", () => {
    const set = questionSet([single([undefined, true])]);
    const projected = questionSetToAskUserQuestionsPayload(set);
    expect(projected.questions[0]!.options.map((option) => option.recommended)).toEqual([undefined, true]);
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "ask_user_questions",
      payload: { version: 1, questionSet: set },
    });
    if (parsed.kind !== "ask_user_questions") throw new Error("unexpected kind");
    expect(parsed.payload.questions[0]!.options[1]).toMatchObject({ id: "o1", recommended: true });
    expect(askUserQuestionsPayloadSchema.parse(parsed.payload).questions[0]!.options[1]!.recommended).toBe(true);
  });

  it("round-trips recommended from legacy questions back to a question set", () => {
    const legacy: AskUserQuestionsPayload = {
      version: 1,
      submitLabel: "Go",
      questions: [{
        id: "a",
        prompt: "A",
        required: true,
        selectionMode: "multi",
        options: [
          { id: "x", label: "X", recommended: true },
          { id: "y", label: "Y" },
          { id: "free", label: "Other", description: "Type it", freeText: true },
        ],
      }],
    };
    const set = askUserQuestionsPayloadToQuestionSet(legacy, { title: "Title" });
    expect(set).toEqual({
      schema: "paperclip.question_set.v1",
      title: "Title",
      submitLabel: "Go",
      questions: [{
        id: "a",
        prompt: "A",
        required: true,
        answerMode: "multi_select",
        options: [
          { id: "x", label: "X", recommended: true },
          { id: "y", label: "Y" },
        ],
        customAnswer: { enabled: true, label: "Other", placeholder: "Type it" },
      }],
    });
    expect(questionSetToAskUserQuestionsPayload(set).questions[0]!.options[0]!.recommended).toBe(true);
  });

  it("returns a stored question set unchanged", () => {
    const set = questionSet([single([true, undefined])]);
    const payload = questionSetToAskUserQuestionsPayload(set);
    expect(askUserQuestionsPayloadToQuestionSet(payload)).toBe(set);
  });
});

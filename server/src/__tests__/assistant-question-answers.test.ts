import { describe, expect, it } from "vitest";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { buildQuestionResponseDeliveryEnvelope, formatQuestionResponseSummary } from "../services/question-response-delivery.js";

describe("Assistant question answers reach the continuation wake", () => {
  it("renders the person's answers to an Assistant-authored card", () => {
    const data = createIssueThreadInteractionSchema.parse({
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", addresseeUserId: "person-1",
      payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", questions: [{
        id: "q1", prompt: "Assign this to Riley?", required: true, answerMode: "single_select",
        options: [{ id: "yes", label: "Yes, Riley", recommended: true }, { id: "no", label: "Someone else" }],
      }] } },
    });
    const envelope = buildQuestionResponseDeliveryEnvelope({
      id: "int-1", status: "answered", title: null, sourceRunId: "run-1", payload: (data as { payload: never }).payload,
      result: { version: 1, answers: [{ questionId: "q1", optionIds: ["yes"] }] },
    } as never);
    expect(formatQuestionResponseSummary(envelope)).toBe("Resolved questions and answers:\n- Assign this to Riley?: Yes, Riley");
  });
});

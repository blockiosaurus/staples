// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipQuestionResponse, PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { QuestionForm } from "./QuestionForm";

vi.mock("./TaskChatRichInput", () => ({
  TaskChatRichInput: ({ value, onChange }: { value: string; onChange(value: string): void }) =>
    <textarea aria-label="Answer" value={value} onChange={event => onChange(event.target.value)} />,
}));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

const questionSet: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [
  { id: "draft", prompt: "Edit the draft", required: true, answerMode: "text", initialText: "  Draft\n漢字\n" },
] };

describe("QuestionForm initial text", () => {
  let container: HTMLDivElement;
  let root: Root;
  const submit = vi.fn();
  beforeEach(() => { localStorage.clear(); submit.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
  const input = () => container.querySelector("textarea")!;
  async function render(set = questionSet, initialResponse?: PaperclipQuestionResponse) {
    await act(async () => root.render(<QuestionForm id="edit" questionSet={set} initialResponse={initialResponse} draftKey="question-initial-text" onSubmit={submit} />));
  }
  async function edit(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function remount(set = questionSet) { await act(async () => root.unmount()); root = createRoot(container); await render(set); }
  it("shows exact editable text without sending until the operator submits", async () => {
    await render();
    expect(input().value).toBe("  Draft\n漢字\n");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: { draft: { text: "  Draft\n漢字\n" } } });
  });
  it("preserves edits through a refreshed request and reload instead of reapplying a default", async () => {
    await render(); await edit("Operator edit\n");
    const refreshed = { ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText: "New provider default" }] };
    await render(refreshed); expect(input().value).toBe("Operator edit\n");
    await remount(refreshed); expect(input().value).toBe("Operator edit\n");
    expect(submit).not.toHaveBeenCalled();
  });
  it("retains an explicitly cleared draft and required validation across reload", async () => {
    await render(); await edit(""); await remount();
    expect(input().value).toBe("");
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
  it("isolates pending requests with the same field ids and restores each edited draft when switching back", async () => {
    async function showRequest(id: string, initialText: string) {
      const set = { ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText }] };
      await act(async () => root.render(
        <QuestionForm id={id} questionSet={set} draftKey={`question:${id}`} onSubmit={submit} />,
      ));
    }
    const storedText = (id: string) => JSON.parse(localStorage.getItem(`question:${id}`)!).answers.draft.text;

    await showRequest("request-a", "Provider draft A");
    await edit("Operator edit A");
    await showRequest("request-b", "Provider draft B");
    expect(input().value).toBe("Provider draft B");
    expect(storedText("request-a")).toBe("Operator edit A");
    expect(storedText("request-b")).toBe("Provider draft B");
    await edit("Operator edit B");

    await showRequest("request-a", "Refreshed provider draft A");
    expect(input().value).toBe("Operator edit A");
    await showRequest("request-b", "Refreshed provider draft B");
    expect(input().value).toBe("Operator edit B");
    expect(storedText("request-a")).toBe("Operator edit A");
    expect(storedText("request-b")).toBe("Operator edit B");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: { draft: { text: "Operator edit B" } } });
  });

  it("prefers an existing response and keeps text constraints on defaults", async () => {
    await render(questionSet, { schema: "paperclip.question_response.v1", answers: { draft: { text: "Existing answer" } } });
    expect(input().value).toBe("Existing answer");
    await act(async () => root.unmount()); localStorage.clear(); root = createRoot(container);
    await render({ ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText: "bad", textValidation: { minLength: 5 } }] });
    expect(input().value).toBe("bad");
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("QuestionForm recommendations", () => {
  let container: HTMLDivElement;
  let root: Root;
  const submit = vi.fn();
  beforeEach(() => { localStorage.clear(); submit.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
  const recommendedSet: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [
    { id: "scope", prompt: "Scope?", required: true, answerMode: "single_select", options: [
      { id: "small", label: "Small" }, { id: "large", label: "Large", recommended: true },
    ] },
    { id: "tools", prompt: "Tools?", required: true, answerMode: "multi_select", options: [
      { id: "a", label: "A", recommended: true }, { id: "b", label: "B" }, { id: "c", label: "C", recommended: true },
    ] },
    { id: "notes", prompt: "Notes?", required: false, answerMode: "text", initialText: "Ship it" },
  ] };
  async function render(set = recommendedSet, draftKey = "question-recommended") {
    await act(async () => root.render(<QuestionForm id="rec" questionSet={set} draftKey={draftKey} onSubmit={submit} />));
  }
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent?.trim() === label);
  const option = (questionId: string, optionId: string) => container.querySelector<HTMLButtonElement>(`#rec-${questionId}-${optionId}`)!;

  it("pre-selects recommended options when the form initializes", async () => {
    await render();
    expect(option("scope", "large").getAttribute("aria-checked")).toBe("true");
    expect(option("scope", "small").getAttribute("aria-checked")).toBe("false");
    await act(async () => button("Next")!.click());
    expect(option("tools", "a").getAttribute("aria-checked")).toBe("true");
    expect(option("tools", "b").getAttribute("aria-checked")).toBe("false");
    expect(option("tools", "c").getAttribute("aria-checked")).toBe("true");
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts every recommendation in one click", async () => {
    await render();
    await act(async () => option("scope", "small").click());
    await act(async () => button("Accept all recommendations")!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: {
      scope: { selectedOptionIds: ["large"] },
      tools: { selectedOptionIds: ["a", "c"] },
      notes: { text: "Ship it" },
    } });
  });

  it("keeps a saved draft over recommended pre-selection", async () => {
    localStorage.setItem("question-recommended", JSON.stringify({
      page: 0, answers: { scope: { selectedOptionIds: ["small"] } }, customActive: {},
    }));
    await render();
    expect(option("scope", "small").getAttribute("aria-checked")).toBe("true");
    expect(option("scope", "large").getAttribute("aria-checked")).toBe("false");
  });

  it("disables accept-all when a required question has no recommendation", async () => {
    const set: PaperclipQuestionSet = { ...recommendedSet, questions: [
      recommendedSet.questions[0]!,
      { id: "why", prompt: "Why?", required: true, answerMode: "text" },
    ] };
    await render(set, "question-missing-recommendation");
    const accept = button("Accept all recommendations")!;
    expect(accept.disabled).toBe(true);
    expect(accept.closest("[title]")?.getAttribute("title")).toBe("Some questions have no recommendation");
  });

  it("hides accept-all when no question carries a recommendation", async () => {
    await render({ schema: "paperclip.question_set.v1", questions: [
      { id: "q", prompt: "Q?", required: true, answerMode: "single_select", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    ] }, "question-none");
    expect(button("Accept all recommendations")).toBeUndefined();
  });
});

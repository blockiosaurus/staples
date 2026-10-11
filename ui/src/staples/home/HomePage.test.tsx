// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing, BriefingItem } from "@paperclipai/shared";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { ASK_UNAVAILABLE_NOTICE, BRIEFING_REFETCH_INTERVAL_MS, HomePage } from "./HomePage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getBriefing: vi.fn(),
  respond: vi.fn(),
  accept: vi.fn(),
  askAssistant: vi.fn(),
}));

vi.mock("@/api/briefing", () => ({ briefingApi: { get: mocks.getBriefing } }));
vi.mock("@/api/issues", () => ({
  issuesApi: { respondToInteraction: mocks.respond, acceptInteraction: mocks.accept },
}));
vi.mock("@/staples/assistant/AssistantProvider", () => ({ useAskAssistant: () => mocks.askAssistant }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Acme" },
  }),
}));
vi.mock("@/lib/router", () => ({
  useActiveCompanyPrefix: () => "PAP",
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={`/PAP${to}`} {...props}>
      {children}
    </a>
  ),
}));

const NOW = new Date().toISOString();

function item(overrides: Partial<BriefingItem> & Pick<BriefingItem, "kind" | "id" | "title">): BriefingItem {
  return { href: `/issues/PAP-1`, createdAt: NOW, ...overrides };
}

const QUESTION = item({
  kind: "question",
  id: "interaction-q",
  title: "Which team should own onboarding?",
  subtitle: "PAP-12 · Riley",
  href: "/issues/PAP-12",
  issueId: "issue-12",
  recommendation: {
    label: "Developers",
    inline: true,
    answers: [
      { questionId: "q1", optionIds: ["opt-dev"] },
      { questionId: "q2", text: "Ship on Friday" },
    ],
  },
});
const CONFIRMATION = item({
  kind: "confirmation",
  id: "interaction-c",
  title: "Publish the launch post?",
  href: "/issues/PAP-13",
  issueId: "issue-13",
  recommendation: { label: "Accept", inline: true, accept: true },
});
const APPROVAL = item({
  kind: "approval",
  id: "approval-1",
  title: "Hire a designer",
  href: "/approvals/approval-1",
});

function fixture(overrides: Partial<Briefing> = {}): Briefing {
  const needsYou = overrides.needsYou ?? [QUESTION, CONFIRMATION, APPROVAL];
  const inProgress = overrides.inProgress ?? [
    item({ kind: "live_run", id: "run-1", title: "Draft the onboarding guide", subtitle: "Riley" }),
    item({ kind: "active_task", id: "issue-20", title: "Fix the signup form", href: "/issues/PAP-20" }),
  ];
  const doneRecently = overrides.doneRecently ?? [
    item({ kind: "done_task", id: "issue-30", title: "Write the pricing page", href: "/issues/PAP-30" }),
  ];
  return {
    needsYou,
    inProgress,
    doneRecently,
    counts: { needsYou: needsYou.length, inProgress: inProgress.length, doneRecently: doneRecently.length },
    generatedAt: NOW,
    ...overrides,
  };
}

function Crumbs() {
  const { breadcrumbs } = useBreadcrumbs();
  return <span data-testid="crumbs">{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</span>;
}

describe("HomePage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function settle() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BreadcrumbProvider companyName="Acme">
            <Crumbs />
            <HomePage />
          </BreadcrumbProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  const section = (title: string) => container.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
  const buttonIn = (scope: ParentNode | null, label: string) =>
    [...(scope?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) ?? null;

  async function click(element: HTMLElement | null) {
    expect(element).not.toBeNull();
    await act(async () => {
      element!.click();
    });
    await settle();
  }

  it("renders the header summary and the three sections from the briefing", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();

    expect(mocks.getBriefing).toHaveBeenCalledWith("company-1");
    expect(container.querySelector("h1")?.textContent).toBe("Acme");
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe(
      "3 things need you · 2 in progress",
    );
    expect(container.querySelector('[data-testid="crumbs"]')?.textContent).toBe("Home");

    const needs = section("Needs you")!;
    expect(needs.querySelectorAll('[data-testid="briefing-row"]')).toHaveLength(3);
    expect(row("interaction-q")?.textContent).toContain("Recommended: Developers");
    expect(row("interaction-q")?.textContent).toContain("PAP-12 · Riley");
    expect(row("interaction-q")?.querySelector('a[href="/PAP/issues/PAP-12"]')).not.toBeNull();
    // Inline accept only where the recommendation allows it; approvals only open or ask.
    expect(buttonIn(row("interaction-q"), "Accept recommendations")).not.toBeNull();
    expect(buttonIn(row("interaction-c"), "Accept recommendation")).not.toBeNull();
    expect(buttonIn(row("approval-1"), "Accept recommendation")).toBeNull();
    expect(row("approval-1")?.textContent).toContain("Open");
    expect(buttonIn(row("approval-1"), "Ask Assistant")).not.toBeNull();

    const progress = section("In progress")!;
    expect(progress.querySelectorAll('[data-testid="briefing-compact-row"]')).toHaveLength(2);
    expect(row("run-1")?.querySelector('[aria-label="Running now"]')).not.toBeNull();
    expect(section("Done recently")?.textContent).toContain("Write the pricing page");
    expect(container.querySelector('textarea[aria-label="Ask the Assistant"]')).not.toBeNull();
  });

  it("shows a templated agent's roll-up under Done recently, linking to the agent", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({
      doneRecently: [
        item({ kind: "agent_actions", id: "agent-7", title: "Sam sent 3 emails", subtitle: "Last 24 hours", href: "/agents/agent-7" }),
        item({ kind: "done_task", id: "issue-30", title: "Write the pricing page", href: "/issues/PAP-30" }),
      ],
    }));
    await render();
    const rollup = row("agent-7")!;
    expect(rollup.textContent).toContain("Sam sent 3 emails");
    expect(rollup.textContent).toContain("Last 24 hours");
    expect(rollup.textContent).toContain("Agent actions");
    expect(rollup.querySelector('a[href="/PAP/agents/agent-7"]')).not.toBeNull();
  });

  it("polls every 30 seconds", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.briefing("company-1") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((query?.observers[0]?.options as any)?.refetchInterval).toBe(BRIEFING_REFETCH_INTERVAL_MS);
    expect(BRIEFING_REFETCH_INTERVAL_MS).toBe(30_000);
  });

  it("shows the empty states and hides Done recently when nothing finished", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [], inProgress: [], doneRecently: [] }));
    await render();
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe(
      "Nothing needs you · Nothing in progress",
    );
    expect(section("Needs you")?.textContent).toContain("Nothing needs you right now.");
    expect(section("In progress")?.textContent).toContain("Nothing running.");
    expect(section("Done recently")).toBeNull();
  });

  it("accepts a question's recommendation with its answers and removes the row", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    let resolveRespond: (value: unknown) => void = () => {};
    mocks.respond.mockReturnValue(new Promise((resolve) => { resolveRespond = resolve; }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await render();

    await click(buttonIn(row("interaction-q"), "Accept recommendations"));
    expect(mocks.respond).toHaveBeenCalledWith("issue-12", "interaction-q", {
      answers: [
        { questionId: "q1", optionIds: ["opt-dev"] },
        { questionId: "q2", optionIds: [], otherText: "Ship on Friday" },
      ],
    });
    // Optimistic: gone before the server answers, and the summary follows.
    expect(row("interaction-q")).toBeNull();
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe(
      "2 things need you · 2 in progress",
    );

    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [CONFIRMATION, APPROVAL] }));
    await act(async () => resolveRespond({}));
    await settle();
    expect(row("interaction-q")).toBeNull();
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(queryKeys.briefing("company-1")),
        JSON.stringify(queryKeys.attention("company-1")),
        JSON.stringify(queryKeys.issues.interactions("issue-12")),
      ]),
    );
  });

  it("labels the button by how many answers it accepts", async () => {
    const single = { ...QUESTION, id: "interaction-single", recommendation: { label: "Developers", inline: true, answers: [{ questionId: "q1", optionIds: ["opt-dev"] }] } };
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [single, QUESTION] }));
    await render();
    expect(buttonIn(row("interaction-single"), "Accept recommendation")).not.toBeNull();
    expect(buttonIn(row("interaction-q"), "Accept recommendations")).not.toBeNull();
  });

  it("keys optimistic removal by kind and id so same-id items of another kind stay", async () => {
    const twin = item({ kind: "approval", id: "interaction-c", title: "Same id, different source", href: "/approvals/interaction-c" });
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [CONFIRMATION, twin] }));
    mocks.accept.mockReturnValue(new Promise(() => {}));
    await render();
    const confirmationRow = [...container.querySelectorAll<HTMLElement>('[data-item-id="interaction-c"]')]
      .find((element) => element.textContent?.includes("Publish the launch post?"))!;
    await click(buttonIn(confirmationRow, "Accept recommendation"));
    const remaining = [...container.querySelectorAll('[data-item-id="interaction-c"]')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.textContent).toContain("Same id, different source");
  });

  it("accepts a confirmation through the accept endpoint", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.accept.mockResolvedValue({});
    await render();
    await click(buttonIn(row("interaction-c"), "Accept recommendation"));
    expect(mocks.accept).toHaveBeenCalledWith("issue-13", "interaction-c");
    expect(mocks.respond).not.toHaveBeenCalled();
    expect(row("interaction-c")).toBeNull();
  });

  it("restores the row with the error when accepting fails", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.respond.mockRejectedValue(new ApiError("The question was already answered.", 409, null));
    await render();

    await click(buttonIn(row("interaction-q"), "Accept recommendations"));
    expect(row("interaction-q")).not.toBeNull();
    expect(row("interaction-q")?.querySelector('[role="alert"]')?.textContent).toContain(
      "The question was already answered.",
    );
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe(
      "3 things need you · 2 in progress",
    );
  });

  it("asks the Assistant about an item with its title and full link", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();
    await click(buttonIn(row("approval-1"), "Ask Assistant"));
    expect(mocks.askAssistant).toHaveBeenCalledWith({
      text: "Help me decide: Hire a designer",
      context: { label: "Hire a designer", href: "/PAP/approvals/approval-1" },
    });
  });

  async function typeInComposer(value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask the Assistant"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return textarea;
  }

  it("keeps the composer text and says so when the Assistant can't take it", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.askAssistant.mockReturnValue(false);
    await render();
    const textarea = await typeInComposer("What should I focus on today?");
    await click(buttonIn(container, "Send"));
    expect(mocks.askAssistant).toHaveBeenCalledWith({ text: "What should I focus on today?", send: true });
    expect(textarea.value).toBe("What should I focus on today?");
    expect(section("Ask the Assistant")?.querySelector('[role="alert"]')?.textContent).toBe(ASK_UNAVAILABLE_NOTICE);

    mocks.askAssistant.mockReturnValue(true);
    await click(buttonIn(container, "Send"));
    expect(textarea.value).toBe("");
    expect(section("Ask the Assistant")?.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the cached briefing and offers a retry when a background refresh fails", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();
    expect(container.querySelector('[data-testid="briefing-refresh-error"]')).toBeNull();
    mocks.getBriefing.mockRejectedValue(new Error("Server unavailable"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.briefing("company-1") });
    });
    await settle();
    const notice = container.querySelector<HTMLElement>('[data-testid="briefing-refresh-error"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("Couldn't refresh — showing what we had.");
    expect(section("Needs you")?.querySelectorAll('[data-testid="briefing-row"]')).toHaveLength(3);

    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [] }));
    await click(buttonIn(notice, "Retry"));
    expect(container.querySelector('[data-testid="briefing-refresh-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toContain("Nothing needs you");
  });

  it("sends the composer text to the Assistant", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.askAssistant.mockReturnValue(true);
    await render();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask the Assistant"]')!;
    const send = buttonIn(container, "Send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "  What should I focus on today?  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(send);
    expect(mocks.askAssistant).toHaveBeenCalledWith({ text: "What should I focus on today?", send: true });
    expect(textarea.value).toBe("");
  });

  it("shows a retryable error when the briefing fails to load", async () => {
    mocks.getBriefing.mockRejectedValue(new Error("Server unavailable"));
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Your briefing couldn't be loaded.");
    expect(alert?.textContent).toContain("Server unavailable");
    mocks.getBriefing.mockResolvedValue(fixture());
    await click(buttonIn(alert, "Retry"));
    expect(section("Needs you")).not.toBeNull();
  });
});

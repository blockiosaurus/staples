// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing, BriefingItem } from "@paperclipai/shared";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import {
  ASK_UNAVAILABLE_NOTICE,
  BRIEFING_HIDDEN_REFETCH_INTERVAL_MS,
  BRIEFING_REFETCH_INTERVAL_MS,
  briefingRefetchInterval,
  HomePage,
} from "./HomePage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getBriefing: vi.fn(),
  respond: vi.fn(),
  accept: vi.fn(),
  askAssistant: vi.fn(),
  retryFailedRun: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  resolveIncident: vi.fn(),
  listArtifacts: vi.fn(),
}));
vi.mock("@/api/artifacts", () => ({ artifactsApi: { list: mocks.listArtifacts } }));

vi.mock("@/api/agents", () => ({
  agentsApi: { retryFailedRun: mocks.retryFailedRun, resume: mocks.resume, clearError: mocks.clearError },
}));
vi.mock("@/api/budgets", () => ({ budgetsApi: { resolveIncident: mocks.resolveIncident } }));

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
    spend: { monthSpendCents: 1200, companyBudgetCents: 9000, hosted: null },
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

    expect(mocks.getBriefing).toHaveBeenCalledWith("company-1", expect.any(AbortSignal));
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

  it("shows this month's spend against the company budget, linking to Costs", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();
    const spend = container.querySelector<HTMLAnchorElement>('[data-testid="briefing-spend"]')!;
    expect(spend.textContent).toBe("$12 of $90 this month");
    expect(spend.getAttribute("href")).toBe("/PAP/activity/costs");
  });

  it("says no limit is set when the company has no budgets", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ spend: { monthSpendCents: 1250, companyBudgetCents: null, hosted: null } }));
    await render();
    const spend = container.querySelector<HTMLAnchorElement>('[data-testid="briefing-spend"]')!;
    expect(spend.textContent).toBe("$12.50 this month · no limit set");
    expect(spend.getAttribute("href")).toBe("/PAP/activity/costs");
  });

  it("shows the hosted limit's use when there is one", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ spend: { monthSpendCents: 1200, companyBudgetCents: null, hosted: { capCents: 5000, spentCents: 800 } } }));
    await render();
    expect(container.querySelector('[data-testid="briefing-spend"]')?.textContent).toBe("$12 this month · $8 of $50 hosted limit");
  });

  it("shows no spend line when the person may not read costs", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ spend: null }));
    await render();
    expect(container.querySelector('[data-testid="briefing-spend"]')).toBeNull();
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

  function artifact(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      source: "document",
      mediaKind: "text",
      title: `Plan ${id}`,
      previewText: `Preview of ${id}`,
      contentType: "text/markdown",
      contentPath: null,
      openPath: null,
      downloadPath: null,
      issue: { id: "i", identifier: "PAP-1", title: "Task" },
      project: null,
      createdByAgent: null,
      updatedAt: NOW,
      href: `/issues/PAP-1#document-${id}`,
      ...overrides,
    };
  }

  it("shows what we've made with previews and a link to all of it", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.listArtifacts.mockResolvedValue({
      artifacts: [artifact("a"), artifact("b", { mediaKind: "image", contentPath: "/img.png" }), artifact("v", { mediaKind: "video", contentPath: "/clip.mp4" })],
      nextCursor: null,
    });
    await render();
    expect(mocks.listArtifacts).toHaveBeenCalledWith("company-1", { limit: 6 });
    const made = section("What we've made")!;
    expect(made.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(3);
    expect(made.querySelector("video")).not.toBeNull();
    expect(made.textContent).toContain("Preview of a");
    expect(made.querySelector("img")?.getAttribute("src")).toBe("/img.png");
    expect(made.querySelector("iframe, script")).toBeNull();
    expect(made.querySelector('a[href="/PAP/artifacts"]')?.textContent).toBe("See all");
    expect(made.querySelector('a[href="/PAP/issues/PAP-1#document-a"]')).not.toBeNull();
    // After Done recently.
    expect(section("Done recently")!.compareDocumentPosition(made) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides what we've made when there are no artifacts", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    mocks.listArtifacts.mockResolvedValue({ artifacts: [], nextCursor: null });
    await render();
    expect(section("What we've made")).toBeNull();
  });

  it("polls every 30 seconds while visible and every 5 minutes while hidden", async () => {
    mocks.getBriefing.mockResolvedValue(fixture());
    await render();
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.briefing("company-1") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((query?.observers[0]?.options as any)?.refetchInterval).toBe(briefingRefetchInterval);
    expect(BRIEFING_REFETCH_INTERVAL_MS).toBe(30_000);
    expect(BRIEFING_HIDDEN_REFETCH_INTERVAL_MS).toBe(300_000);
    expect(briefingRefetchInterval()).toBe(30_000);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      expect(briefingRefetchInterval()).toBe(300_000);
    } finally {
      visibility.mockRestore();
    }
  });

  it("shows the empty states and hides Done recently when nothing finished", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [], inProgress: [], doneRecently: [] }));
    await render();
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe(
      "Nothing needs you · Nothing in progress",
    );
    expect(section("Needs you")?.textContent).toContain("Nothing needs you right now.");
    expect(section("In progress")?.textContent).toContain("Nothing in progress.");
    expect(section("Done recently")).toBeNull();
  });

  it("keeps refreshing slowly while the document is hidden, so Home never sits on a stale empty state", async () => {
    // Hidden documents (a background tab, an embedded browser pane) close the
    // live-updates socket and pause plain intervals; Home still polls there,
    // but only every five minutes.
    mocks.getBriefing.mockResolvedValue(fixture({ inProgress: [] }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    // Only the poll interval is faked; React and the query client keep real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await render();
      expect(mocks.getBriefing).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toContain("Nothing in progress");

      mocks.getBriefing.mockResolvedValue(fixture());
      // Not at the visible rate.
      await act(async () => { vi.advanceTimersByTime(BRIEFING_REFETCH_INTERVAL_MS); });
      await settle();
      expect(mocks.getBriefing).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(BRIEFING_HIDDEN_REFETCH_INTERVAL_MS - BRIEFING_REFETCH_INTERVAL_MS); });
      await settle();
      expect(mocks.getBriefing).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe("3 things need you · 2 in progress");
      expect(section("In progress")?.querySelectorAll('[data-testid="briefing-compact-row"]')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
  });

  it("labels up-next and waiting work in progress and counts it in the header", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({
      needsYou: [],
      inProgress: [
        item({ kind: "queued_task", id: "issue-40", title: "Write the launch post", subtitle: "PAP-40 · Riley", label: "Up next" }),
        item({ kind: "waiting_task", id: "issue-41", title: "Publish the site", subtitle: "PAP-41", label: "Waiting on Pick the domain" }),
      ],
    }));
    await render();
    expect(container.querySelector('[data-testid="briefing-summary"]')?.textContent).toBe("Nothing needs you · 2 in progress");
    expect(row("issue-40")?.textContent).toContain("Up next · PAP-40 · Riley");
    expect(row("issue-41")?.textContent).toContain("Waiting on Pick the domain · PAP-41");
    expect(section("In progress")?.textContent).not.toContain("Nothing in progress");
  });

  const FAILED_RUN = item({
    kind: "failed_run",
    id: "run-9",
    title: "Riley couldn't finish its work",
    href: "/agents/agent-1/runs/run-9",
    reason: "Riley took too long and was stopped.",
    action: { kind: "retry_run", label: "Try again", agentId: "agent-1", runId: "run-9" },
  });
  const PAUSED_RUN = item({
    kind: "failed_run",
    id: "run-10",
    title: "Sam couldn't finish its work",
    href: "/agents/agent-2/runs/run-10",
    reason: "Sam is paused, so it can't work.",
    action: { kind: "resume_agent", label: "Resume", agentId: "agent-2" },
  });
  const AGENT_ERROR = item({
    kind: "agent_error",
    id: "agent-3",
    title: "Broken Agent",
    href: "/agents/agent-3",
    reason: "Broken Agent hit an error and stopped.",
    action: { kind: "clear_agent_error", label: "Dismiss error", agentId: "agent-3" },
  });
  const HOSTED_LIMIT = item({
    kind: "budget_incident",
    id: "incident-1",
    title: "Riley reached its monthly hosted limit",
    href: "/costs",
    reason: "Riley spent $50.10 of its $50 monthly hosted limit. Its hosted runs are on hold until you raise it.",
    action: {
      kind: "raise_budget",
      label: "Raise limit",
      budget: {
        incidentId: "incident-1", policyId: "policy-1", metric: "hosted_billed_cents", scopeType: "agent",
        scopeId: "agent-1", limitCents: 5000, observedCents: 5010, suggestedCents: 10000,
      },
    },
  });
  const NOT_CONNECTED = item({
    kind: "failed_run",
    id: "run-11",
    title: "Riley couldn't finish its work",
    href: "/agents/agent-1/runs/run-11",
    reason: "A service Riley uses isn't connected. Reconnect it, then try again.",
    action: { kind: "open_settings", label: "Open settings", href: "/agents/agent-1/tools" },
  });
  const UNKNOWN = item({
    kind: "failed_run",
    id: "run-12",
    title: "Riley couldn't finish its work",
    href: "/agents/agent-1/runs/run-12",
    reason: "Riley stopped with an error it couldn't recover from.",
  });

  it("shows each fix's plain reason and runs the matching API", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [FAILED_RUN, PAUSED_RUN, AGENT_ERROR] }));
    mocks.retryFailedRun.mockResolvedValue({ runId: "run-13", issueId: null });
    mocks.resume.mockResolvedValue({});
    mocks.clearError.mockResolvedValue({});
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await render();

    expect(row("run-9")?.querySelector('[data-testid="briefing-reason"]')?.textContent).toBe("Riley took too long and was stopped.");
    await click(buttonIn(row("run-9"), "Try again"));
    expect(mocks.retryFailedRun).toHaveBeenCalledWith("agent-1", "run-9", "company-1");
    expect(row("run-9")).toBeNull();

    await click(buttonIn(row("run-10"), "Resume"));
    expect(mocks.resume).toHaveBeenCalledWith("agent-2", "company-1");
    expect(row("run-10")).toBeNull();

    await click(buttonIn(row("agent-3"), "Dismiss error"));
    expect(mocks.clearError).toHaveBeenCalledWith("agent-3", "company-1");
    expect(row("agent-3")).toBeNull();

    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(expect.arrayContaining([
      JSON.stringify(queryKeys.briefing("company-1")),
      JSON.stringify(queryKeys.attention("company-1")),
      JSON.stringify(queryKeys.agents.list("company-1")),
    ]));
  });

  it("raises a hosted limit from an inline form defaulting to twice the limit", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [HOSTED_LIMIT] }));
    mocks.resolveIncident.mockResolvedValue({});
    await render();

    await click(buttonIn(row("incident-1"), "Raise limit"));
    const form = row("incident-1")!.querySelector<HTMLFormElement>('form[aria-label="Raise limit"]')!;
    expect(form).not.toBeNull();
    const input = form.querySelector<HTMLInputElement>('input[aria-label="New limit in dollars"]')!;
    expect(input.value).toBe("100");
    expect(form.textContent).toContain("New monthly hosted limit (USD)");
    // Cancel on the left, the primary action on the right, in one row.
    const footer = buttonIn(form, "Cancel")!.parentElement!;
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Cancel", "Raise limit"]);
    expect(footer.className).toContain("justify-between");

    // At or under what's spent: refused inline.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "50");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("more than the $50.10 already spent");
    expect((buttonIn(form, "Raise limit") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "120");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonIn(form, "Raise limit"));
    expect(mocks.resolveIncident).toHaveBeenCalledWith("company-1", "incident-1", {
      action: "raise_budget_and_resume",
      amount: 12000,
    });
    expect(row("incident-1")).toBeNull();
  });

  it("closes the raise form on Cancel without calling the API", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [HOSTED_LIMIT] }));
    await render();
    await click(buttonIn(row("incident-1"), "Raise limit"));
    await click(buttonIn(row("incident-1"), "Cancel"));
    expect(row("incident-1")?.querySelector("form")).toBeNull();
    expect(mocks.resolveIncident).not.toHaveBeenCalled();
  });

  it("keeps the row and points to the Assistant when a fix fails", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [FAILED_RUN] }));
    mocks.retryFailedRun.mockRejectedValue(new Error("The previous retry has already stopped."));
    await render();
    await click(buttonIn(row("run-9"), "Try again"));
    expect(row("run-9")).not.toBeNull();
    expect(row("run-9")?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't try again: The previous retry has already stopped. Ask the Assistant for help.",
    );
    await click(buttonIn(row("run-9"), "Ask Assistant"));
    expect(mocks.askAssistant).toHaveBeenCalledWith({
      text: "Help me fix this: Riley couldn't finish its work. Riley took too long and was stopped.",
      context: { label: "Riley couldn't finish its work", href: "/PAP/agents/agent-1/runs/run-9" },
    });
  });

  it("tracks the fix spinner per row, so two fixes can run at once", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [FAILED_RUN, PAUSED_RUN] }));
    let finishRetry: (value: unknown) => void = () => {};
    mocks.retryFailedRun.mockReturnValue(new Promise((resolve) => { finishRetry = resolve; }));
    mocks.resume.mockReturnValue(new Promise(() => {}));
    await render();
    await click(buttonIn(row("run-9"), "Try again"));
    await click(buttonIn(row("run-10"), "Resume"));
    expect((buttonIn(row("run-9"), "Try again") as HTMLButtonElement).disabled).toBe(true);
    expect((buttonIn(row("run-10"), "Resume") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishRetry({ runId: "run-13", issueId: null }));
    await settle();
    expect(row("run-9")).toBeNull();
    expect((buttonIn(row("run-10"), "Resume") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains known raise failures in plain words", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [HOSTED_LIMIT] }));
    mocks.resolveIncident.mockRejectedValue(new ApiError(
      "Resolve unpriced usage or explicitly allow it in the budget policy before resuming", 422, null,
    ));
    await render();
    await click(buttonIn(row("incident-1"), "Raise limit"));
    await click(buttonIn(row("incident-1")!.querySelector("form"), "Raise limit"));
    const alert = [...row("incident-1")!.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" ");
    expect(alert).toContain("Couldn't raise limit: Some recent usage has no price yet. Check it on the Costs page, then try again.");
    expect(alert).not.toContain("unpriced");
  });

  it("links settings fixes and leaves unknown failures to the Assistant", async () => {
    mocks.getBriefing.mockResolvedValue(fixture({ needsYou: [NOT_CONNECTED, UNKNOWN] }));
    await render();
    const settings = [...(row("run-11")?.querySelectorAll("a") ?? [])].find((link) => link.textContent === "Open settings");
    expect(settings?.getAttribute("href")).toBe("/PAP/agents/agent-1/tools");
    expect(row("run-12")?.textContent).toContain("Riley stopped with an error it couldn't recover from.");
    const buttons = [...(row("run-12")?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["Ask Assistant"]);
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

// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { TaskChatInteractionCard } from "./task-chat/TaskChatInteractionCard";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import type { RequestConfirmationInteraction } from "../lib/issue-thread-interactions";
import { pendingRequestConfirmationInteraction } from "../fixtures/issueThreadInteractionFixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const ACTION_PATH = `/api/approvals/${APPROVAL_ID}/approve`;
const CLAIM_PATH = `/api/issues/${pendingRequestConfirmationInteraction.issueId}/interactions/interaction-proposed-action/claim-proposed-action`;
const claimed = () => json(200, { id: "interaction-proposed-action", status: "pending" });

function proposal(overrides: Partial<RequestConfirmationInteraction> = {}, staleCheck = false): RequestConfirmationInteraction {
  return {
    ...pendingRequestConfirmationInteraction,
    id: "interaction-proposed-action",
    status: "pending",
    continuationPolicy: "wake_assignee",
    addresseeUserId: "person-1",
    result: null,
    payload: {
      version: 1,
      prompt: "Approve hiring the Writer agent",
      acceptLabel: "Confirm",
      rejectLabel: "Cancel",
      detailsMarkdown: `**POST** \`${ACTION_PATH}\``,
      proposedAction: {
        version: 1,
        method: "POST",
        path: ACTION_PATH,
        body: { decisionNote: "Looks good" },
        summary: "Approve hiring the Writer agent",
        category: "approval",
        hash: HASH,
        ...(staleCheck ? { staleCheck: { path: `/api/approvals/${APPROVAL_ID}`, field: "updatedAt" as const, expected: "2026-10-10T10:00:00.000Z" } } : {}),
      },
    },
    ...overrides,
  } as RequestConfirmationInteraction;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function render(props: Partial<ComponentProps<typeof IssueThreadInteractionCard>>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeProvider>
            <IssueThreadInteractionCard interaction={proposal()} currentUserId="person-1" {...props} />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(host: HTMLElement, label: string) {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

async function click(target: HTMLElement | undefined) {
  expect(target).toBeTruthy();
  await act(async () => { target!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("ProposedActionCard", () => {
  it("shows the exact request, body expanded, ahead of the summary", async () => {
    const host = await render({ onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
    expect(host.querySelector('[data-testid="proposed-action-card"]')).toBeTruthy();
    expect(host.textContent).toContain("Approve hiring the Writer agent");
    expect(host.textContent).toContain("Approval");
    const requestBlock = host.querySelector('[data-testid="proposed-action-request"]')!;
    expect(requestBlock.textContent).toContain("Request");
    expect(requestBlock.textContent).toContain("POST");
    expect(requestBlock.textContent).toContain(ACTION_PATH);
    // The body is visible without any click, in a scrollable block.
    const body = requestBlock.querySelector("pre")!;
    expect(body.textContent).toContain('"decisionNote": "Looks good"');
    expect(body.className).toContain("overflow-auto");
    // The request comes before the Assistant's summary.
    const text = host.textContent!;
    expect(text.indexOf(ACTION_PATH)).toBeLessThan(text.indexOf("Approve hiring the Writer agent"));
    expect(button(host, "Confirm")).toBeTruthy();
    expect(button(host, "Cancel")).toBeTruthy();
  });

  it("claims, then executes the exact call with the person's session, then reports executed", async () => {
    fetchMock.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(json(200, { id: APPROVAL_ID, status: "approved" }));
    const accept = vi.fn(async () => undefined);
    const host = await render({ onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(CLAIM_PATH);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ hash: HASH }) });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(ACTION_PATH);
    expect(init).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ decisionNote: "Looks good" }) });
    expect(accept).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "interaction-proposed-action" }), undefined, undefined, undefined,
      { status: "executed", httpStatus: 200, message: "HTTP 200", hash: HASH },
    );
  });

  it("does not execute when the server refuses the claim", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: "This proposed action is already running" }));
    const accept = vi.fn(async () => undefined);
    const host = await render({ onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(CLAIM_PATH);
    expect(accept).not.toHaveBeenCalled();
    expect(host.textContent).toContain("already running");
  });

  it("only the addressee can confirm; others see who it is waiting for", async () => {
    const host = await render({ currentUserId: "someone-else", userLabelMap: new Map([["person-1", "Pat"]]), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
    expect(button(host, "Confirm")).toBeUndefined();
    expect(button(host, "Cancel")).toBeUndefined();
    expect(host.textContent).toContain("Waiting for Pat to confirm");
  });

  it("reports a failed call with its status and message", async () => {
    fetchMock.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(json(403, { error: "Only owners can approve hires" }));
    const accept = vi.fn(async () => undefined);
    const host = await render({ onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(accept).toHaveBeenCalledWith(
      expect.anything(), undefined, undefined, undefined,
      { status: "failed", httpStatus: 403, message: "Only owners can approve hires", hash: HASH },
    );
    expect(host.textContent).toContain("Only owners can approve hires");
  });

  it("requires a second Confirm when the target changed since the proposal", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: APPROVAL_ID, updatedAt: "2026-10-10T11:00:00.000Z" }));
    const accept = vi.fn(async () => undefined);
    const host = await render({ interaction: proposal({}, true), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/approvals/${APPROVAL_ID}`);
    expect(host.textContent).toContain("Changed since the Assistant proposed this");
    expect(accept).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(json(200, { ok: true }));
    await click(button(host, "Confirm anyway"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`/api/approvals/${APPROVAL_ID}`, CLAIM_PATH, ACTION_PATH]);
    expect(accept).toHaveBeenCalledWith(expect.anything(), undefined, undefined, undefined, expect.objectContaining({ status: "executed", hash: HASH }));
  });

  it("goes straight through when the stale check still matches", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { id: APPROVAL_ID, updatedAt: "2026-10-10T10:00:00.000Z" }))
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(json(200, {}));
    const accept = vi.fn(async () => undefined);
    const host = await render({ interaction: proposal({}, true), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`/api/approvals/${APPROVAL_ID}`, CLAIM_PATH, ACTION_PATH]);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while the call runs", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(claimed()).mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const host = await render({ onAcceptInteraction: vi.fn(async () => undefined), onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(button(host, "Running…")?.disabled).toBe(true);
    expect(button(host, "Cancel")?.disabled).toBe(true);
    await act(async () => { finish(json(200, {})); });
  });

  it("Cancel rejects without calling the API", async () => {
    const reject = vi.fn(async () => undefined);
    const host = await render({ onAcceptInteraction: vi.fn(), onRejectInteraction: reject });
    await click(button(host, "Cancel"));
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "interaction-proposed-action" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the recorded outcome once resolved", async () => {
    const executed = await render({
      interaction: proposal({ status: "accepted", result: { version: 1, outcome: "accepted", proposedAction: { status: "failed", httpStatus: 409, message: "Already decided" } } }),
    });
    expect(executed.textContent).toContain("Failed");
    expect(executed.textContent).toContain("409");
    expect(executed.textContent).toContain("Already decided");
    expect(button(executed, "Confirm")).toBeUndefined();
  });

  it("renders the governed card in the task chat (conversation) surface too", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient();
    const interaction = proposal();
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ThemeProvider>
              <TaskChatInteractionCard item={{ id: interaction.id, kind: "interaction", interaction }} currentUserId="person-1" onAcceptInteraction={vi.fn()} onRejectInteraction={vi.fn()} />
            </ThemeProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector('[data-testid="proposed-action-card"]')).toBeTruthy();
    expect(button(container, "Confirm")).toBeTruthy();
  });
});

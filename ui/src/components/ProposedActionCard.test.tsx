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

  it("shows server-built approval context above the request, labelled as from the approval", async () => {
    const base = proposal();
    const interaction = {
      ...base,
      payload: { ...base.payload, proposedAction: { ...base.payload.proposedAction!, context: {
        source: "approval", approvalType: "hire_agent", requestedBy: "Hiring Manager", agentName: "Shell Runner",
        agentRole: "engineer", adapterType: "hermes_local", adapterConfigCommandFields: ["hermesCommand", "env"],
      } } },
    } as RequestConfirmationInteraction;
    const host = await render({ interaction, onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
    const block = host.querySelector('[data-testid="proposed-action-context"]')!;
    expect(block).toBeTruthy();
    expect(block.textContent).toContain("From the approval");
    expect(block.textContent).toContain("Hire agent");
    expect(block.textContent).toContain("Hiring Manager");
    expect(block.textContent).toContain("Shell Runner");
    expect(block.textContent).toContain("hermes_local");
    expect(block.textContent).toContain("hermesCommand");
    expect(block.textContent).toContain("env");
    const requestBlock = host.querySelector('[data-testid="proposed-action-request"]')!;
    expect(block.compareDocumentPosition(requestBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no approval context block without server context", async () => {
    const host = await render({ onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
    expect(host.querySelector('[data-testid="proposed-action-context"]')).toBeNull();
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
    fetchMock.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(json(200, { id: APPROVAL_ID, updatedAt: "2026-10-10T11:00:00.000Z" }));
    const accept = vi.fn(async () => undefined);
    const host = await render({ interaction: proposal({}, true), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    // Claim first (server re-validation), then the stale read; nothing executed yet.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CLAIM_PATH, `/api/approvals/${APPROVAL_ID}`]);
    expect(host.textContent).toContain("Changed since the Assistant proposed this");
    expect(accept).not.toHaveBeenCalled();

    // The claim is still held, so the second Confirm executes directly.
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click(button(host, "Confirm anyway"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CLAIM_PATH, `/api/approvals/${APPROVAL_ID}`, ACTION_PATH]);
    expect(accept).toHaveBeenCalledWith(expect.anything(), undefined, undefined, undefined, expect.objectContaining({ status: "executed", hash: HASH }));
  });

  it("goes straight through when the stale check still matches", async () => {
    fetchMock
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(json(200, { id: APPROVAL_ID, updatedAt: "2026-10-10T10:00:00.000Z" }))
      .mockResolvedValueOnce(json(200, {}));
    const accept = vi.fn(async () => undefined);
    const host = await render({ interaction: proposal({}, true), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
    await click(button(host, "Confirm"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CLAIM_PATH, `/api/approvals/${APPROVAL_ID}`, ACTION_PATH]);
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

  describe("company brief proposals", () => {
    const COMPANY = "22222222-2222-4222-8222-222222222222";
    const BRIEF_PATH = `/api/companies/${COMPANY}/brief`;
    function briefProposal(body: Record<string, unknown>) {
      const base = proposal();
      return {
        ...base,
        payload: { ...base.payload, acceptLabel: "Update brief", prompt: "Add the glossary",
          proposedAction: { ...base.payload.proposedAction!, method: "PUT", path: BRIEF_PATH, body, summary: "Add the glossary", category: "brief" } },
      } as RequestConfirmationInteraction;
    }
    function serveCurrentBrief(current: unknown) {
      fetchMock.mockImplementation(async (url: string) => (url === BRIEF_PATH ? json(200, current) : json(404, { error: "unexpected" })));
    }

    it("previews the new brief and the line changes against the current one, above the request", async () => {
      serveCurrentBrief({ body: "# Mission\nMake staples.\nOld line", revisionId: "r1", revisionNumber: 1, updatedAt: "2026-10-10T00:00:00.000Z" });
      const host = await render({ interaction: briefProposal({ body: "# Mission\nMake staples.\n\n## Glossary\nTPS = report", baseRevisionId: "r1" }), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const preview = host.querySelector('[data-testid="proposed-brief-preview"]')!;
      expect(preview).toBeTruthy();
      expect(preview.querySelector("h2")?.textContent).toBe("Glossary");
      const changes = host.querySelector('[data-testid="proposed-brief-changes"]')!;
      expect(changes.textContent).toContain("+ TPS = report");
      expect(changes.textContent).toContain("- Old line");
      expect(changes.textContent).not.toContain("+ Make staples.");
      const text = host.textContent!;
      expect(text.indexOf("TPS = report")).toBeLessThan(text.indexOf(BRIEF_PATH));
      expect(button(host, "Update brief")).toBeTruthy();
      expect(host.textContent).toContain("Company brief");
    });

    it("labels a first brief as new", async () => {
      serveCurrentBrief(null);
      const host = await render({ interaction: briefProposal({ body: "# Mission" }), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector('[data-testid="proposed-brief-preview"]')?.textContent).toContain("New brief");
      expect(host.querySelector('[data-testid="proposed-brief-changes"]')).toBeNull();
    });
  });
  describe("plan proposals", () => {
    const COMPANY = "22222222-2222-4222-8222-222222222222";
    const PLAN_PATH = `/api/companies/${COMPANY}/plans/apply`;
    const RILEY = "33333333-3333-4333-8333-333333333333";
    const plan = {
      brief: { body: "# Mission\n\n## Glossary\nTPS = report", baseRevisionId: null },
      goal: { title: "Publish weekly", description: "One article a week." },
      project: { name: "Weekly articles" },
      agents: [{ clientKey: "writer", name: "Writer", role: "general", title: "Staff writer", adapterType: "claude_local", budgetMonthlyCents: 2500 }],
      tasks: [
        { clientKey: "first", title: "Publish the first article", assigneeClientKey: "writer", blockedByClientKeys: ["style", "outline"] },
        { clientKey: "style", title: "Write a style guide", assigneeClientKey: "writer", blockedByClientKeys: [] },
        { clientKey: "outline", title: "Outline it", assigneeAgentId: RILEY, blockedByClientKeys: [] },
        { clientKey: "ideas", title: "Collect ideas", blockedByClientKeys: [] },
      ],
    };
    function planProposal() {
      const base = proposal();
      return {
        ...base,
        payload: { ...base.payload, acceptLabel: "Create plan", prompt: "Set up a writer",
          proposedAction: { ...base.payload.proposedAction!, method: "POST", path: PLAN_PATH, body: plan, summary: "Set up a writer", category: "plan" } },
      } as RequestConfirmationInteraction;
    }

    it("previews brief (collapsed), goal, project, agents and ordered tasks above the request, and confirms with Create plan", async () => {
      fetchMock.mockImplementation(async (url: string) => (url === `/api/companies/${COMPANY}/agents`
        ? json(200, [{ id: RILEY, name: "Riley", role: "engineer" }])
        : json(404, { error: "unexpected" })));
      const host = await render({ interaction: planProposal(), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const preview = host.querySelector('[data-testid="proposed-plan-preview"]')!;
      expect(preview).toBeTruthy();
      const brief = preview.querySelector('details[data-testid="proposed-plan-brief"]') as HTMLDetailsElement;
      expect(brief).toBeTruthy();
      expect(brief.open).toBe(false);
      expect(brief.querySelector("h2")?.textContent).toBe("Glossary");
      expect(preview.textContent).toContain("Publish weekly");
      expect(preview.textContent).toContain("Weekly articles");
      const agentsText = preview.querySelector('[data-testid="proposed-plan-agents"]')?.textContent ?? "";
      expect(agentsText).toContain("Writer — general (claude_local)");
      expect(agentsText).toContain("Staff writer");
      expect(agentsText).toContain("$25.00/month");
      const items = Array.from(preview.querySelectorAll('[data-testid="proposed-plan-tasks"] > li')).map((li) => li.textContent ?? "");
      expect(items).toHaveLength(4);
      // Ordered so blockers come first.
      expect(items.findIndex((t) => t.includes("Write a style guide"))).toBeLessThan(items.findIndex((t) => t.includes("Publish the first article")));
      const first = items.find((t) => t.includes("Publish the first article"))!;
      expect(first).toContain("after: Write a style guide, Outline it");
      expect(first).toContain("Writer (new)");
      expect(items.find((t) => t.includes("Outline it"))).toContain("Riley");
      expect(items.find((t) => t.includes("Collect ideas"))).toContain("Unassigned");
      const text = host.textContent!;
      expect(text.indexOf("Collect ideas")).toBeLessThan(text.indexOf(PLAN_PATH));
      expect(host.textContent).toContain("Plan");
      expect(button(host, "Create plan")).toBeTruthy();
    });

    it("lists \"Uses your <provider> connection\" only for hires the server says inherit one", async () => {
      fetchMock.mockImplementation(async (url: string) => (url === `/api/companies/${COMPANY}/agents`
        ? json(200, []) : json(404, { error: "unexpected" })));
      const withConnection = planProposal();
      withConnection.payload.proposedAction!.planHireConnections = [{ clientKey: "writer", provider: "anthropic" }];
      const host = await render({ interaction: withConnection, onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector('[data-testid="proposed-plan-agents"]')?.textContent).toContain("Uses your Claude connection");
    });

    it("says nothing about a connection when the proposal carries none", async () => {
      fetchMock.mockImplementation(async (url: string) => (url === `/api/companies/${COMPANY}/agents`
        ? json(200, []) : json(404, { error: "unexpected" })));
      const host = await render({ interaction: planProposal(), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector('[data-testid="proposed-plan-agent-connection"]')).toBeNull();
    });

    it("labels new-agent assignees as waiting for hire approval when the company requires it", async () => {
      fetchMock.mockImplementation(async (url: string) => (url === `/api/companies/${COMPANY}`
        ? json(200, { id: COMPANY, name: "Acme", requireBoardApprovalForNewAgents: true })
        : url === `/api/companies/${COMPANY}/agents` ? json(200, []) : json(404, { error: "unexpected" })));
      const host = await render({ interaction: planProposal(), onAcceptInteraction: vi.fn(), onRejectInteraction: vi.fn() });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const first = Array.from(host.querySelectorAll('[data-testid="proposed-plan-tasks"] > li')).map((li) => li.textContent ?? "")
        .find((t) => t.includes("Publish the first article"))!;
      expect(first).toContain("Writer (new, after hire approval)");
    });

    it("runs the plan with the interaction id as its idempotency key and reports a summary", async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/claim-proposed-action")) return claimed();
        if (url === PLAN_PATH && init?.method === "POST") {
          return json(201, { agents: { writer: { id: "a1", status: "idle", approvalId: null } }, tasks: { first: {}, style: {}, outline: {}, ideas: {} }, pendingAssignments: [], brief: null, goal: { id: "g" }, project: { id: "p" } });
        }
        return json(200, []);
      });
      const accept = vi.fn(async () => undefined);
      const host = await render({ interaction: planProposal(), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
      await click(button(host, "Create plan"));
      const call = fetchMock.mock.calls.find(([url, init]) => url === PLAN_PATH && (init as RequestInit)?.method === "POST")!;
      expect(new Headers((call[1] as RequestInit).headers).get("Idempotency-Key")).toBe("interaction-proposed-action");
      expect(accept).toHaveBeenCalledWith(expect.anything(), undefined, undefined, undefined,
        { status: "executed", httpStatus: 201, message: "Plan created: 1 agent, 4 tasks.", hash: HASH });
    });

    it("relays a partial failure's message to the Assistant", async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/claim-proposed-action")) return claimed();
        if (url === PLAN_PATH && init?.method === "POST") {
          return json(422, { error: "Hiring Writer failed:\n  Adapter unavailable.\r\nHired so far: Editor (idle, a1).", code: "plan_partially_applied", partial: { agents: { editor: { id: "a1" } } } });
        }
        return json(200, []);
      });
      const accept = vi.fn(async () => undefined);
      const host = await render({ interaction: planProposal(), onAcceptInteraction: accept, onRejectInteraction: vi.fn() });
      await click(button(host, "Create plan"));
      expect(accept).toHaveBeenCalledWith(expect.anything(), undefined, undefined, undefined,
        expect.objectContaining({ status: "failed", httpStatus: 422, message: "Hiring Writer failed: Adapter unavailable. Hired so far: Editor (idle, a1)." }));
    });
  });
});

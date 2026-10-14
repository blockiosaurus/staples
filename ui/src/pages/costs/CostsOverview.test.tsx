// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostsOverview } from "./CostsOverview";

const briefingGet = vi.hoisted(() => vi.fn());
const agentsList = vi.hoisted(() => vi.fn());
const budgetOverview = vi.hoisted(() => vi.fn());
const upsertPolicy = vi.hoisted(() => vi.fn());
const resolveIncident = vi.hoisted(() => vi.fn());

vi.mock("@/api/briefing", () => ({ briefingApi: { get: briefingGet } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: agentsList } }));
vi.mock("@/api/budgets", () => ({
  budgetsApi: { overview: budgetOverview, upsertPolicy, resolveIncident },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-10T12:00:00Z");

describe("CostsOverview", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    agentsList.mockResolvedValue([]);
    budgetOverview.mockResolvedValue({ policies: [], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicy.mockResolvedValue({});
    resolveIncident.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderOverview(spend: unknown) {
    briefingGet.mockResolvedValue({ spend });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <CostsOverview companyId="company-1" now={NOW} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  }

  async function raiseTo(value: string) {
    await act(async () => { button("Raise limit")!.click(); });
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("shows the meter against the company budget and the projection", async () => {
    await renderOverview({ monthSpendCents: 1200, companyBudgetCents: 6000, hosted: null });
    expect(container.textContent).toContain("$12 of $60 this month");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("20");
    expect(container.textContent).toContain("About $37 by month end at this pace");
  });

  it("falls back to the hosted cap, then to no limit", async () => {
    await renderOverview({ monthSpendCents: 500, companyBudgetCents: null, hosted: { capCents: 2000, spentCents: 500 } });
    expect(container.textContent).toContain("$5 of $20 this month");
    act(() => root.unmount());
    root = createRoot(container);
    await renderOverview({ monthSpendCents: 500, companyBudgetCents: null, hosted: null });
    expect(container.textContent).toContain("$5 this month · no limit set");
    expect(button("Set a limit")).toBeDefined();
  });

  it("lists agents by spend with a paused badge", async () => {
    agentsList.mockResolvedValue([
      { id: "a2", name: "Researcher", spentMonthlyCents: 300, status: "paused", pauseReason: "budget" },
      { id: "a1", name: "Writer", spentMonthlyCents: 800, status: "active", pauseReason: null },
    ]);
    await renderOverview({ monthSpendCents: 1100, companyBudgetCents: 6000, hosted: null });
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Writer");
    expect(items[1].textContent).toContain("Researcher");
    expect(items[0].textContent).not.toContain("Paused by limit");
    expect(items[1].textContent).toContain("Paused by limit");
  });

  it("raise limit submits a policy when there is no incident", async () => {
    await renderOverview({ monthSpendCents: 1200, companyBudgetCents: 6000, hosted: null });
    await raiseTo("90");
    expect(upsertPolicy).toHaveBeenCalledWith("company-1", {
      scopeType: "company", scopeId: "company-1", metric: "billed_cents", windowKind: "calendar_month_utc", amount: 9000,
    });
    expect(resolveIncident).not.toHaveBeenCalled();
  });

  it("raise limit resolves an open incident instead", async () => {
    budgetOverview.mockResolvedValue({ policies: [], activeIncidents: [{ id: "inc-1", scopeType: "company" }], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    await renderOverview({ monthSpendCents: 1200, companyBudgetCents: 6000, hosted: null });
    await raiseTo("90");
    expect(resolveIncident).toHaveBeenCalledWith("company-1", "inc-1", { action: "raise_budget_and_resume", amount: 9000 });
    expect(upsertPolicy).not.toHaveBeenCalled();
  });
});

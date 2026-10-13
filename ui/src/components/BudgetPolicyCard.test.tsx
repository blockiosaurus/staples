// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function summary(overrides: Partial<BudgetPolicySummary>): BudgetPolicySummary {
  return {
    policyId: "p1", companyId: "c1", scopeType: "agent", scopeId: "a1", scopeName: "Riley", metric: "billed_cents",
    windowKind: "calendar_month_utc", amount: 2000, observedAmount: 500, unpricedEventCount: 0, pendingRunCount: 0,
    remainingAmount: 1500, utilizationPercent: 25, warnPercent: 80, hardStopEnabled: true, unpricedUsagePolicy: "block",
    notifyEnabled: true, isActive: true, status: "ok", paused: false, pauseReason: null,
    windowStart: new Date(), windowEnd: new Date(), ...overrides,
  };
}

describe("BudgetPolicyCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("labels a hosted limit for an agent and for the company", () => {
    act(() => root.render(<BudgetPolicyCard summary={summary({ metric: "hosted_billed_cents" })} />));
    expect(container.textContent).toContain("agent · hosted limit");
    act(() => root.render(<BudgetPolicyCard summary={summary({ metric: "hosted_billed_cents", scopeType: "company", scopeId: "c1" })} />));
    expect(container.textContent).toContain("company · hosted limit");
  });

  it("labels a plain budget by its scope only", () => {
    act(() => root.render(<BudgetPolicyCard summary={summary({})} />));
    expect(container.textContent).not.toContain("hosted limit");
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingRedirect } from "./OnboardingRedirect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; issuePrefix: string }>,
  selectedCompany: null as null | { id: string; issuePrefix: string },
  loading: false,
}));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => state }));

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

describe("OnboardingRedirect", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.companies = [];
    state.selectedCompany = null;
    state.loading = false;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function visit(path: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="onboarding" element={<OnboardingRedirect />} />
            <Route path=":companyPrefix/onboarding" element={<OnboardingRedirect />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    return container.querySelector("[data-testid=where]")?.textContent ?? null;
  }

  it("sends /onboarding to /start when there are no companies", async () => {
    expect(await visit("/onboarding")).toBe("/start");
  });

  it("sends /onboarding to the selected company's Assistant", async () => {
    state.companies = [{ id: "a", issuePrefix: "AAA" }, { id: "b", issuePrefix: "BBB" }];
    state.selectedCompany = state.companies[1]!;
    expect(await visit("/onboarding")).toBe("/BBB/assistant");
  });

  it("sends /:prefix/onboarding to that company's Assistant", async () => {
    state.companies = [{ id: "a", issuePrefix: "AAA" }, { id: "b", issuePrefix: "BBB" }];
    expect(await visit("/aaa/onboarding")).toBe("/AAA/assistant");
  });

  it("falls back to /start for an unknown prefix with no companies", async () => {
    expect(await visit("/ZZZ/onboarding")).toBe("/start");
  });

  it("waits for companies to load before deciding", async () => {
    state.loading = true;
    expect(await visit("/onboarding")).toBeNull();
  });
});

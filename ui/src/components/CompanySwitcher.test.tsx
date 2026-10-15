// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySwitcher } from "./CompanySwitcher";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  company: {
    companies: [] as Array<Record<string, unknown>>,
    selectedCompany: null as Record<string, unknown> | null,
    setSelectedCompanyId: () => {},
    companyListUnavailable: false,
    retryCompanies: () => {},
  },
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => mocks.company }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

describe("CompanySwitcher logo", () => {
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

  it("shows the company logo before the name when one is set", async () => {
    const withLogo = { id: "c1", name: "Lantern", status: "active", logoUrl: "/api/assets/a1/content" };
    mocks.company.companies = [withLogo];
    mocks.company.selectedCompany = withLogo;
    await act(async () => root.render(<CompanySwitcher />));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/assets/a1/content");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.nextElementSibling?.textContent).toBe("Lantern");
    expect(container.querySelector("span.rounded-full")).not.toBeNull();
  });

  it("renders no image without a logo", async () => {
    const noLogo = { id: "c1", name: "Lantern", status: "active", logoUrl: null };
    mocks.company.companies = [noLogo];
    mocks.company.selectedCompany = noLogo;
    await act(async () => root.render(<CompanySwitcher />));
    expect(container.querySelector("img")).toBeNull();
  });
});

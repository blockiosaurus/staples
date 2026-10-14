// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TermsPage } from "./TermsPage";
import { PrivacyPage } from "./PrivacyPage";

// The router's Link wrapper reads the active company prefix from context.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }),
}));

function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  flushSync(() => createRoot(container).render(<MemoryRouter>{node}</MemoryRouter>));
  return container;
}

describe("legal pages", () => {
  it("terms page names the product and is marked as a draft", () => {
    const container = render(<TermsPage />);
    expect(container.querySelector("h1")?.textContent).toBe("Terms of service");
    expect(container.textContent).toContain("Staples");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Draft");
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
  });

  it("privacy page links back to terms and sign-in", () => {
    const container = render(<PrivacyPage />);
    expect(container.querySelector("h1")?.textContent).toBe("Privacy policy");
    expect(container.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(container.querySelector('a[href="/auth"]')).not.toBeNull();
  });
});

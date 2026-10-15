// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartCompanyPage } from "./StartCompanyPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  setSelectedCompanyId: vi.fn(),
  navigateTopLevel: vi.fn(),
  company: { companies: [] as unknown[], selectedCompany: null as unknown, loading: false },
  cloud: null as null | { cloudBaseUrl: string | null },
  canCreate: { canCreate: true, loaded: true },
}));

vi.mock("@/api/companies", () => ({ companiesApi: { create: mocks.create } }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: mocks.navigateTopLevel }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} data-testid="back-link" {...props}>{children}</a>,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ ...mocks.company, setSelectedCompanyId: mocks.setSelectedCompanyId }),
}));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => mocks.cloud }));
vi.mock("@/hooks/useCanCreateCompany", () => ({ useCanCreateCompany: () => mocks.canCreate }));

const ACME = { id: "c1", issuePrefix: "ACM", name: "Acme" };

describe("StartCompanyPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.create.mockReset();
    mocks.navigate.mockReset();
    mocks.setSelectedCompanyId.mockReset();
    mocks.navigateTopLevel.mockReset();
    mocks.company = { companies: [], selectedCompany: null, loading: false };
    mocks.cloud = null;
    mocks.canCreate = { canCreate: true, loaded: true };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <StartCompanyPage />
        </QueryClientProvider>,
      );
    });
  }
  async function typeDescription(value: string) {
    const area = container.querySelector("#start-company-description") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function openNameField() {
    const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Have a name already?")!;
    await act(async () => toggle.click());
  }
  async function type(value: string) {
    const input = container.querySelector("#start-company-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("disables Create until the description has text", async () => {
    await render();
    expect(container.textContent).toContain("What business do you want to start?");
    expect(container.querySelector("input[type=text]")).toBeNull();
    const area = container.querySelector("#start-company-description")!;
    expect(area.getAttribute("aria-labelledby")).toBe("start-title");
    expect(area.getAttribute("aria-describedby")).toBe("start-description-help");
    expect(container.querySelector("#start-title")?.textContent).toBe("What business do you want to start?");
    expect(container.querySelector("#start-description-help")).not.toBeNull();
    const button = container.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await typeDescription("   ");
    expect(button.disabled).toBe(true);
    await typeDescription("A candle shop");
    expect(button.disabled).toBe(false);
  });

  it("creates from a description with a derived name", async () => {
    mocks.create.mockResolvedValue({ id: "c9", issuePrefix: "NEW", name: "Lantern" });
    await render();
    await typeDescription("  A candle shop in Austin called Lantern ");
    await submit();
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Lantern",
      description: "A candle shop in Austin called Lantern",
      kickoff: true,
    });
    expect(mocks.setSelectedCompanyId).toHaveBeenCalledWith("c9");
    expect(mocks.navigate).toHaveBeenCalledWith("/NEW/assistant", {
      replace: true,
      state: { firstMessage: "A candle shop in Austin called Lantern" },
    });
  });

  it("caps the description at 2000 characters", async () => {
    await render();
    expect(container.querySelector("textarea")?.getAttribute("maxlength")).toBe("2000");
  });

  it("lets the person give a name", async () => {
    mocks.create.mockResolvedValue({ id: "c9", issuePrefix: "NEW", name: "Newco" });
    await render();
    await openNameField();
    await type("  Newco ");
    await typeDescription("A candle shop in Austin");
    await submit();
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Newco",
      description: "A candle shop in Austin",
      kickoff: true,
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/NEW/assistant", {
      replace: true,
      state: { firstMessage: "A candle shop in Austin" },
    });
  });

  it("still sends the typed name after the disclosure is closed", async () => {
    mocks.create.mockResolvedValue({ id: "c9", issuePrefix: "NEW", name: "Newco" });
    await render();
    await openNameField();
    await type("Newco");
    await openNameField();
    expect(container.querySelector("#start-company-name")).toBeNull();
    await typeDescription("A candle shop in Austin");
    await submit();
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Newco",
      description: "A candle shop in Austin",
      kickoff: true,
    });
  });

  it("shows the server error and stays put when create fails", async () => {
    mocks.create.mockRejectedValue(new Error("Only admins can create companies"));
    await render();
    await typeDescription("A candle shop");
    await submit();
    expect(container.textContent).toContain("Only admins can create companies");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("lets an existing, non-managed user create another company, with a way back", async () => {
    mocks.company = { companies: [ACME], selectedCompany: ACME, loading: false };
    await render();
    expect(container.querySelector("[data-testid=redirect]")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    const back = container.querySelector("[data-testid=back-link]");
    expect(back?.getAttribute("href")).toBe("/ACM/assistant");
    expect(back?.textContent).toBe("Back to Acme");
  });

  it("offers no back link to someone without a company", async () => {
    await render();
    expect(container.querySelector("[data-testid=back-link]")).toBeNull();
  });

  it("explains, instead of silently redirecting, that a cloud-managed stack creates companies in Cloud", async () => {
    mocks.cloud = { cloudBaseUrl: "https://cloud.example.com" };
    mocks.company = { companies: [ACME], selectedCompany: ACME, loading: false };
    await render();
    expect(container.querySelector("[data-testid=redirect]")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("created there, not in this app");
    expect(container.querySelector("[data-testid=back-link]")?.getAttribute("href")).toBe("/ACM/assistant");
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(mocks.navigateTopLevel).toHaveBeenCalledWith("https://cloud.example.com/stacks/new");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("never offers in-app create on a cloud-managed stack with no company", async () => {
    mocks.cloud = { cloudBaseUrl: "https://cloud.example.com" };
    await render();
    expect(container.querySelector("input")).toBeNull();
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(mocks.navigateTopLevel).toHaveBeenCalledWith("https://cloud.example.com/stacks/new");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("explains an unreachable Cloud instead of rendering an inert control", async () => {
    mocks.cloud = { cloudBaseUrl: null };
    await render();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Staples Cloud");
  });

  it("tells a signed-in user with no company to ask for access when they cannot create", async () => {
    mocks.canCreate = { canCreate: false, loaded: true };
    await render();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Ask the person who invited you for access");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("explains admin-only creation to a member who already has a company", async () => {
    mocks.canCreate = { canCreate: false, loaded: true };
    mocks.company = { companies: [ACME], selectedCompany: ACME, loading: false };
    await render();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Only an admin can create a company here");
    expect(container.querySelector("[data-testid=back-link]")?.getAttribute("href")).toBe("/ACM/assistant");
  });

  it("waits for the creation policy before showing the form", async () => {
    mocks.canCreate = { canCreate: false, loaded: false };
    await render();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("Ask the person who invited you");
  });

  it("renders nothing interactive while companies load", async () => {
    mocks.company = { companies: [], selectedCompany: null, loading: true };
    await render();
    expect(container.querySelector("input")).toBeNull();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { CompanyBriefPage } from "./CompanyBriefPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));

vi.mock("@/api/companyBrief", () => ({ companyBriefApi: { get: mocks.get, update: mocks.update } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Acme" } }),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: (props: { value: string; onChange: (value: string) => void; readOnly?: boolean; ariaLabel?: string }) => (
    <textarea
      data-testid="brief-editor"
      aria-label={props.ariaLabel}
      readOnly={props.readOnly}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

const BRIEF = { body: "# Mission\nMake staples.", revisionId: "11111111-1111-4111-8111-111111111111", revisionNumber: 3, updatedAt: "2026-10-10T12:00:00.000Z" };

function Crumbs() {
  const { breadcrumbs } = useBreadcrumbs();
  return <span data-testid="crumbs">{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</span>;
}

describe("CompanyBriefPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.get.mockReset();
    mocks.update.mockReset();
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
            <CompanyBriefPage />
          </BreadcrumbProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  const editor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="brief-editor"]')!;
  const saveButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Save"))!;
  async function type(value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor(), value);
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("loads the brief into the editor and saves edits against its revision", async () => {
    mocks.get.mockResolvedValue(BRIEF);
    mocks.update.mockResolvedValue({ ...BRIEF, body: "# Mission\nMake great staples.", revisionNumber: 4, revisionId: "22222222-2222-4222-8222-222222222222" });
    await render();
    expect(container.querySelector('[data-testid="crumbs"]')?.textContent).toContain("Company brief");
    expect(editor().value).toBe("# Mission\nMake staples.");
    expect(container.textContent).toContain("Revision 3");
    expect(saveButton().disabled).toBe(true);

    await type("# Mission\nMake great staples.");
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    await settle();
    expect(mocks.update).toHaveBeenCalledWith("company-1", { body: "# Mission\nMake great staples.", baseRevisionId: BRIEF.revisionId });
    expect(container.textContent).toContain("Revision 4");
  });

  it("starts an empty brief and explains who reads it", async () => {
    mocks.get.mockResolvedValue(null);
    mocks.update.mockResolvedValue({ ...BRIEF, body: "Glossary", revisionNumber: 1 });
    await render();
    expect(editor().value).toBe("");
    expect(container.textContent).toMatch(/every agent/i);
    await type("Glossary");
    await act(async () => saveButton().click());
    await settle();
    expect(mocks.update).toHaveBeenCalledWith("company-1", { body: "Glossary" });
  });

  it("explains a conflict and a read-only refusal instead of overwriting", async () => {
    mocks.get.mockResolvedValue(BRIEF);
    mocks.update.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    await render();
    await type("Mine");
    await act(async () => saveButton().click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/someone else changed/i);
    expect(editor().value).toBe("Mine");

    mocks.update.mockRejectedValueOnce(new ApiError("Viewer access is read-only", 403, null));
    await act(async () => saveButton().click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/view-only/i);
  });
});

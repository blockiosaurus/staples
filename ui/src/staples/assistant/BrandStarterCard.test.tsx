// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandStarterCard } from "./BrandStarterCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  upload: vi.fn(),
  updateBranding: vi.fn(),
  company: { id: "c1", issuePrefix: "NEW", logoAssetId: null as string | null },
}));

vi.mock("@/api/brand-starter", () => ({ brandStarterApi: { get: mocks.get } }));
vi.mock("@/api/assets", () => ({ assetsApi: { uploadCompanyLogo: mocks.upload } }));
vi.mock("@/api/companies", () => ({ companiesApi: { updateBranding: mocks.updateBranding } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: mocks.company }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const concepts = [1, 2, 3].map((index) => ({
  index,
  name: ["Ember", "Lantern", "Wick"][index - 1],
  kind: "geometric" as const,
  markPath: `/api/c/concept-${index}-mark.svg`,
  lockupPath: `/api/c/concept-${index}-lockup.svg`,
  previewPath: null,
}));

function status(over: Record<string, unknown> = {}) {
  return {
    issue: { id: "i1", identifier: "NEW-1", status: "done" },
    designerName: "Brand Designer",
    latestNote: null,
    concepts,
    documentPath: null,
    palettePath: null,
    tagline: null,
    ...over,
  };
}

describe("BrandStarterCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BrandStarterCard />
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.get.mockReset();
    mocks.upload.mockReset().mockResolvedValue({ assetId: "asset-1" });
    mocks.updateBranding.mockReset().mockResolvedValue({});
    mocks.company.logoAssetId = null;
    localStorage.clear();
    globalThis.fetch = vi.fn(async () => ({ blob: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }) })) as never;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function button(label: string) {
    return [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
  }

  it("renders nothing without a brand starter", async () => {
    mocks.get.mockResolvedValue(status({ issue: null, concepts: [] }));
    await mount();
    expect(container.textContent).toBe("");
  });

  it("shows progress and the latest note while the designer works", async () => {
    mocks.get.mockResolvedValue(status({ concepts: [], latestNote: "Sketching marks", issue: { id: "i1", identifier: "NEW-1", status: "in_progress" } }));
    await mount();
    expect(container.textContent).toContain("Your brand designer is working on name and logo ideas");
    expect(container.textContent).toContain("Sketching marks");
  });

  it("applies the chosen concept's name and logo", async () => {
    mocks.get.mockResolvedValue(status());
    await mount();
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(3);
    expect(imgs[1].getAttribute("src")).toBe("/api/c/concept-2-lockup.svg");
    expect(container.textContent).toContain("Lantern");
    const uses = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Use this");
    expect(uses).toHaveLength(3);
    await act(async () => uses[1].click());
    await act(async () => {});
    const file = mocks.upload.mock.calls[0][1] as File;
    expect(mocks.upload.mock.calls[0][0]).toBe("c1");
    expect(file.name).toBe("concept-2-mark.svg");
    expect(mocks.updateBranding).toHaveBeenCalledWith("c1", { name: "Lantern", logoAssetId: "asset-1" });
    expect(container.textContent).toContain("Applied");
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/NEW/artifacts");
    expect(link.textContent).toBe("See what we've made");
  });

  it("keeps the person's name when asked", async () => {
    mocks.get.mockResolvedValue(status());
    await mount();
    const box = container.querySelector("input[type=checkbox]") as HTMLInputElement;
    await act(async () => box.click());
    const uses = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Use this");
    await act(async () => uses[0].click());
    await act(async () => {});
    expect(mocks.updateBranding).toHaveBeenCalledWith("c1", { logoAssetId: "asset-1" });
  });

  it("shows an error and keeps the tiles usable when applying fails", async () => {
    mocks.get.mockResolvedValue(status());
    mocks.upload.mockRejectedValue(new Error("Upload failed"));
    await mount();
    const uses = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Use this");
    await act(async () => uses[0].click());
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Upload failed");
    expect(button("Use this").disabled).toBe(false);
  });

  it("shows a compact applied state with a dismiss when a logo is already set", async () => {
    mocks.company.logoAssetId = "asset-9";
    mocks.get.mockResolvedValue(status());
    await mount();
    expect(container.textContent).toContain("Brand applied");
    await act(async () => (container.querySelector('button[aria-label="Dismiss brand starter"]') as HTMLButtonElement).click());
    expect(localStorage.getItem("staples.brandStarter.dismissed.c1")).toBe("1");
    expect(container.textContent).toBe("");
  });
});

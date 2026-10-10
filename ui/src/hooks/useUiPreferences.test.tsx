// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES } from "@paperclipai/shared";
import { useUiPreferences } from "./useUiPreferences";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), getSession: vi.fn() }));
vi.mock("../api/uiPreferences", () => ({ uiPreferencesApi: { get: mocks.get, patch: mocks.patch } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: mocks.getSession } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useUiPreferences", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let observed: ReturnType<typeof useUiPreferences>;

  function Probe() {
    observed = useUiPreferences("company-1");
    return null;
  }
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.get.mockResolvedValue({ ...DEFAULT_UI_PREFERENCES, revealed: { "nav.projects": "2026-01-01T00:00:00.000Z" } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 50 && !observed.loaded; i += 1) await flush();
    expect(observed.loaded).toBe(true);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  });

  it("applies a pin optimistically before the request resolves", async () => {
    let resolve!: (value: unknown) => void;
    mocks.patch.mockReturnValue(new Promise((r) => { resolve = r; }));
    expect(observed.loaded).toBe(true);
    await act(async () => observed.update({ pin: ["nav.goals"] }));
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1); // request still pending
    expect(observed.preferences.pinned).toContain("nav.goals");
    await act(async () => resolve({ ...observed.preferences, pinned: ["nav.goals"], updatedAt: "2026-02-01T00:00:00.000Z" }));
    await flush();
    expect(observed.preferences.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("restores the previous value when the request fails", async () => {
    mocks.patch.mockRejectedValue(new Error("boom"));
    await act(async () => observed.update({ pin: ["nav.goals"] }));
    await flush();
    expect(observed.preferences.pinned).not.toContain("nav.goals");
  });

  it("skips the request for a no-op patch", async () => {
    await act(async () => observed.update({ reveal: ["nav.projects"] }));
    await flush();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

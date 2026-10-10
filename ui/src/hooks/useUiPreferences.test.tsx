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

  const resolved = (patch: Partial<typeof DEFAULT_UI_PREFERENCES>, stamp: string) => ({
    ...DEFAULT_UI_PREFERENCES,
    revealed: { "nav.projects": "2026-01-01T00:00:00.000Z" },
    ...patch,
    updatedAt: stamp,
  });

  it("keeps a newer optimistic patch when an earlier response arrives late", async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    mocks.patch
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
    await act(async () => observed.update({ pin: ["nav.goals"] }));
    await act(async () => observed.update({ pin: ["nav.issues"] }));
    await flush();
    expect(observed.preferences.pinned).toEqual(["nav.goals", "nav.issues"]);
    await act(async () => resolveFirst(resolved({ pinned: ["nav.goals"] }, "t1")));
    await flush();
    expect(observed.preferences.pinned).toEqual(["nav.goals", "nav.issues"]);
    await act(async () => resolveSecond(resolved({ pinned: ["nav.goals", "nav.issues"] }, "t2")));
    await flush();
    expect(observed.preferences.pinned).toEqual(["nav.goals", "nav.issues"]);
    expect(observed.preferences.updatedAt).toBe("t2");
  });

  it("keeps the second change when the first overlapping request fails", async () => {
    let rejectFirst!: (e: unknown) => void;
    mocks.patch
      .mockReturnValueOnce(new Promise((_, r) => { rejectFirst = r; }))
      .mockResolvedValueOnce(resolved({ pinned: ["nav.issues"] }, "t2"));
    await act(async () => observed.update({ pin: ["nav.goals"] }));
    await act(async () => observed.update({ pin: ["nav.issues"] }));
    await act(async () => rejectFirst(new Error("boom")));
    await flush();
    await flush();
    expect(observed.preferences.pinned).toEqual(["nav.issues"]);
  });

  it("ignores a GET that resolves after a newer PATCH ack", async () => {
    let resolveGet!: (v: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise((r) => { resolveGet = r; }));
    mocks.patch.mockResolvedValueOnce(resolved({ hidden: ["nav.projects"] }, "2026-03-02T00:00:00.000Z"));
    let refetch!: Promise<unknown>;
    await act(async () => {
      refetch = client.refetchQueries();
    });
    await act(async () => observed.update({ hide: ["nav.projects"] }));
    await flush();
    expect(observed.preferences.hidden).toEqual(["nav.projects"]);
    expect(observed.preferences.updatedAt).toBe("2026-03-02T00:00:00.000Z");
    await act(async () => {
      resolveGet(resolved({}, "2026-03-01T00:00:00.000Z"));
      await refetch;
    });
    await flush();
    expect(observed.preferences.hidden).toEqual(["nav.projects"]);
    expect(observed.preferences.updatedAt).toBe("2026-03-02T00:00:00.000Z");
  });

  it("sends one request for two same-tick identical reveals", async () => {
    mocks.patch.mockResolvedValue(resolved({}, "t1"));
    await act(async () => {
      observed.update({ reveal: ["nav.goals"] });
      observed.update({ reveal: ["nav.goals"] });
    });
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
});

describe("useUiPreferences before load", () => {
  it("queues updates until server data arrives", async () => {
    let resolveGet!: (v: unknown) => void;
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.get.mockReturnValue(new Promise((r) => { resolveGet = r; }));
    mocks.patch.mockResolvedValue({ ...DEFAULT_UI_PREFERENCES, pinned: ["nav.goals"], updatedAt: "t1" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let seen!: ReturnType<typeof useUiPreferences>;
    function P() { seen = useUiPreferences("company-9"); return null; }
    const el = document.createElement("div");
    const r = createRoot(el);
    const tick = async () => act(async () => { await new Promise((x) => setTimeout(x, 0)); });
    await act(async () => r.render(<QueryClientProvider client={client}><P /></QueryClientProvider>));
    for (let i = 0; i < 5; i += 1) await tick();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => seen.update({ pin: ["nav.goals"] }));
    await tick();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(seen.loaded).toBe(false);
    await act(async () => resolveGet({ ...DEFAULT_UI_PREFERENCES, updatedAt: "t0" }));
    for (let i = 0; i < 5; i += 1) await tick();
    expect(seen.loaded).toBe(true);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(seen.preferences.pinned).toEqual(["nav.goals"]);
    await act(async () => r.unmount());
    client.clear();
  });
});

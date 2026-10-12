// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSetupCard } from "./AssistantSetupCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  testEnvironment: vi.fn(),
  retryLifecycle: vi.fn(),
  setup: vi.fn(),
  adapters: vi.fn(),
  testAgentSetup: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectionProps: [] as Array<Record<string, any>>,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { testEnvironment: mocks.testEnvironment, retryLifecycle: mocks.retryLifecycle },
}));
vi.mock("@/api/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/assistant")>()),
  assistantApi: { setup: mocks.setup, adapters: mocks.adapters },
}));
vi.mock("@/lib/test-agent-setup", () => ({ testAgentSetup: mocks.testAgentSetup }));
vi.mock("@/components/AdapterMark", () => ({ AdapterMark: () => null }));
vi.mock("@/components/new-agent/AgentProviderConnection", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AgentProviderConnection: (props: Record<string, any>) => {
    mocks.connectionProps.push(props);
    return <div data-testid="provider-connection">Connect {props.adapterType}</div>;
  },
}));

const result = (status: string, codes: Array<[string, string?]>) => ({
  adapterType: "x", status, testedAt: "", checks: codes.map(([code, level = "info"]) => ({ code, level, message: `raw ${code}` })),
});
const ADAPTERS = [
  { adapterType: "claude_local", installed: true, available: true, engine: "cli", signedIn: null },
  { adapterType: "codex_local", installed: false, available: false, engine: null, signedIn: null, hint: "Not installed: install the codex CLI, then check again." },
  { adapterType: "gemini_local", installed: true, available: true, engine: null, signedIn: null, hint: "Sign-in not checked — if `gemini` isn't logged in, run it in a terminal once." },
  { adapterType: "kimi_local", installed: true, available: false, engine: null, signedIn: null, hint: "Needs Node 24.11 or newer on this computer." },
];

describe("AssistantSetupCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.connectionProps.length = 0;
    mocks.retryLifecycle.mockReset().mockResolvedValue({});
    mocks.adapters.mockReset().mockResolvedValue({ adapters: ADAPTERS });
    mocks.setup.mockReset().mockResolvedValue({
      agent: { id: "assistant-1", name: "Assistant", urlKey: "assistant", adapterType: "claude_local", status: "paused" },
      setup: { state: "starting", adapterType: "claude_local" },
    });
    mocks.testAgentSetup.mockReset();
    mocks.testEnvironment.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function settle() {
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  }
  async function render(
    setup: { state: "ready" | "starting" | "needs_model" | "error"; message?: string; reason?: string; adapterType?: string },
    canConfigure = true,
    hostedInferenceAvailable = false,
  ) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantSetupCard companyId="company-1" agentId="assistant-1" canConfigure={canConfigure} hostedInferenceAvailable={hostedInferenceAvailable}
            setup={{ adapterType: "claude_local", ...setup }} />
        </QueryClientProvider>,
      );
    });
    await settle();
  }
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text));

  it("lists the runtime adapters from cheap detection, with sign-in hints and no model calls", async () => {
    await render({ state: "needs_model" });
    expect(mocks.adapters).toHaveBeenCalledWith("company-1");
    expect(mocks.testEnvironment).not.toHaveBeenCalled();
    expect(mocks.testAgentSetup).not.toHaveBeenCalled();
    expect(button("Claude")?.textContent).toContain("Installed");
    expect(button("Claude")?.disabled).toBe(false);
    expect(button("Codex")?.textContent).toContain("Not installed");
    expect(button("Codex")?.disabled).toBe(true);
    expect(button("Kimi")?.disabled).toBe(true);
    expect(button("Gemini")?.querySelector('[data-testid="adapter-status"]')?.textContent).toBe("Installed");
    expect(container.textContent).toContain("Sign-in not checked — if gemini isn't logged in, run it in a terminal once.");
    expect(container.querySelector("code")?.textContent).toBe("gemini");
  });

  it("lays tiles out by the card's own width so the narrow dock stacks them", async () => {
    await render({ state: "needs_model" });
    // A container query, not a viewport breakpoint: the dock is narrow on a wide screen.
    expect(container.querySelector('[data-testid="adapter-picker"]')?.className).toContain("@container");
    const tiles = container.querySelector('[data-testid="adapter-tiles"]')!;
    expect(tiles.className).toContain("@md:grid-cols-2");
    expect(tiles.className).not.toContain("sm:grid-cols-2");
    // The status never squeezes into the name: it stays whole and wraps below when there is no room.
    const status = button("Codex")!.querySelector('[data-testid="adapter-status"]')!;
    expect(status.className).toContain("whitespace-nowrap");
    expect(status.parentElement?.className).toContain("flex-wrap");
  });

  it("says sign-in is needed only when detection found no sign-in", async () => {
    mocks.adapters.mockResolvedValue({ adapters: ADAPTERS.map((item) => item.adapterType === "gemini_local"
      ? { ...item, signedIn: false, hint: "Sign in needed: run `gemini` in a terminal once and log in, then check again." }
      : item.adapterType === "claude_local" ? { ...item, signedIn: true } : item) });
    await render({ state: "needs_model" });
    const status = (text: string) => button(text)?.querySelector('[data-testid="adapter-status"]')?.textContent;
    expect(status("Gemini")).toBe("Sign in needed");
    expect(status("Claude")).toBe("Signed in");
    expect(status("Kimi")).toBe("Unavailable");
  });

  it("reuses the adapter list for 30 seconds", async () => {
    await render({ state: "needs_model" });
    await render({ state: "starting" });
    await render({ state: "needs_model" });
    expect(mocks.adapters).toHaveBeenCalledTimes(1);
  });

  it("checks again on request", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Check again")!.click());
    await settle();
    expect(mocks.adapters).toHaveBeenCalledTimes(2);
  });

  it("shows the code-derived reason when setup needs a model", async () => {
    await render({ state: "needs_model", reason: "Claude isn't signed in on this computer." });
    expect(container.textContent).toContain("Claude isn't signed in on this computer.");
  });

  it("connects Claude with one back control, probing only the chosen adapter on the detected engine", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Claude")!.click());
    const props = mocks.connectionProps.at(-1)!;
    expect(props.adapterType).toBe("claude_local");
    expect(props.hideBack).toBe(true);
    expect(container.querySelectorAll("button").length).toBe(1);
    expect(button("Choose another model")).toBeDefined();

    mocks.testAgentSetup.mockResolvedValue(result("pass", [["claude_hello_probe_passed"]]));
    const connection = { env: {}, aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
    await expect(props.testConnection(connection)).resolves.toBe(true);
    expect(mocks.testAgentSetup).toHaveBeenCalledWith(expect.objectContaining({
      adapterType: "claude_local", adapterConfig: { engine: "cli", env: {} }, aiConnection: connection.aiConnection,
    }));
    await act(async () => props.onConnected(connection));
    await settle();
    expect(mocks.setup).toHaveBeenCalledWith("company-1", {
      adapterType: "claude_local", adapterConfig: { engine: "cli" }, aiConnection: connection.aiConnection,
    });
  });

  it("falls back to the CLI engine when the chosen adapter's ACP engine is unavailable", async () => {
    mocks.adapters.mockResolvedValue({ adapters: [{ ...ADAPTERS[0], engine: null }, ...ADAPTERS.slice(1)] });
    await render({ state: "needs_model" });
    await act(async () => button("Claude")!.click());
    mocks.testAgentSetup
      .mockResolvedValueOnce(result("fail", [["adapter_engine_unavailable", "error"]]))
      .mockResolvedValueOnce(result("pass", [["claude_hello_probe_passed"]]));
    await expect(mocks.connectionProps.at(-1)!.testConnection({ env: {} })).resolves.toBe(true);
    expect(mocks.testAgentSetup.mock.calls[1]![0].adapterConfig).toEqual({ engine: "cli", env: {} });
    await act(async () => mocks.connectionProps.at(-1)!.onConnected({ env: {} }));
    await settle();
    expect(mocks.setup).toHaveBeenCalledWith("company-1", { adapterType: "claude_local", adapterConfig: { engine: "cli" } });
  });

  it("explains a failed test with fixed copy, never the raw check message", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Claude")!.click());
    mocks.testAgentSetup.mockResolvedValue(result("warn", [["claude_hello_probe_auth_required", "warn"]]));
    await expect(mocks.connectionProps.at(-1)!.testConnection({ env: {} })).resolves.toBe(false);
    await settle();
    expect(mocks.connectionProps.at(-1)!.testError).toBe("Claude isn't signed in on this computer.");
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("tests Gemini fully before using it, and offers Check again when it isn't signed in", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Gemini")!.click());
    // Sign-in is tested, not assumed.
    expect(container.textContent).not.toContain("sign-in already set up");
    expect(container.textContent).toContain("We'll test the connection before using it.");
    mocks.testEnvironment.mockResolvedValueOnce(result("warn", [["gemini_hello_probe_auth_required", "warn"]]));
    await act(async () => button("Use Gemini")!.click());
    await settle();
    expect(mocks.testEnvironment).toHaveBeenCalledWith("company-1", "gemini_local", { adapterConfig: {} });
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Gemini isn't signed in on this computer.");
    expect(container.textContent).not.toContain("raw gemini");

    mocks.testEnvironment.mockResolvedValueOnce(result("pass", [["gemini_hello_probe_passed"]]));
    await act(async () => button("Check again")!.click());
    await settle();
    expect(mocks.setup).toHaveBeenCalledWith("company-1", { adapterType: "gemini_local" });
  });

  it("shows a spinner while starting", async () => {
    await render({ state: "starting" });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Getting the Assistant ready");
    expect(mocks.adapters).not.toHaveBeenCalled();
  });

  it("offers to connect a model when the connection test failed, with the fixed reason", async () => {
    await render({ state: "error", message: "The model couldn't be reached. Connect a model to continue.", reason: "Claude didn't answer in time." });
    expect(container.textContent).toContain("The model couldn't be reached. Connect a model to continue.");
    expect(container.textContent).toContain("Claude didn't answer in time.");
    expect(button("Claude")).toBeDefined();
    await act(async () => button("Retry")!.click());
    await settle();
    expect(mocks.retryLifecycle).toHaveBeenCalledWith("assistant-1", "company-1");
  });

  it("shows other errors with Retry only", async () => {
    await render({ state: "error", message: "The lifecycle step failed. Retry the operation." });
    expect(container.textContent).toContain("The lifecycle step failed");
    expect(mocks.adapters).not.toHaveBeenCalled();
    expect(button("Retry")).toBeDefined();
  });

  it("asks viewers to get an owner to connect a model, without probes or actions", async () => {
    await render({ state: "needs_model", reason: "Claude isn't signed in on this computer." }, false);
    expect(container.textContent).toContain("Ask an owner to connect a model");
    expect(container.textContent).toContain("Claude isn't signed in on this computer.");
    expect(mocks.adapters).not.toHaveBeenCalled();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await render({ state: "error", message: "The lifecycle step failed. Retry the operation." }, false);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  describe("Claude (hosted)", () => {
    const KEY = "sk-ant-secret-key-123";
    const HOSTED = { adapterType: "claude_managed", installed: true, available: false, engine: null, signedIn: false, label: "Claude (hosted)", needsKey: true };
    const withHosted = (over = {}) => mocks.adapters.mockResolvedValue({ adapters: [...ADAPTERS, { ...HOSTED, ...over }] });
    const input = () => container.querySelector<HTMLInputElement>('input[type="password"]');
    const type = async (value: string) => {
      await act(async () => {
        const el = input()!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("renders nothing when ready, even with hosted inference", async () => {
      await render({ state: "ready", adapterType: "claude_managed" }, true, true);
      expect(container.querySelector('[data-testid="assistant-setup-card"]')).toBeNull();
    });

    it("shows the finishing state, not the picker, while a hosted Assistant provisions", async () => {
      await render({ state: "needs_model", adapterType: "claude_managed" }, true, true);
      expect(container.textContent).toContain("Finishing Assistant setup…");
      expect(container.querySelector('[data-testid="adapter-picker"]')).toBeNull();
      expect(mocks.adapters).not.toHaveBeenCalled();
      await render({ state: "starting", adapterType: "claude_managed", message: "Finishing Assistant setup…" }, true, true);
      expect(container.textContent).toContain("Finishing Assistant setup…");
    });

    it("offers the hosted tile with key copy, and a password field that submits once and clears", async () => {
      withHosted();
      mocks.setup.mockRejectedValueOnce(new Error("That Anthropic API key was rejected."));
      await render({ state: "needs_model" });
      expect(button("Claude (hosted)")?.textContent).toContain("Runs in Anthropic's cloud. Needs an Anthropic API key.");
      expect(button("Claude")?.textContent).not.toContain("hosted");
      await act(async () => button("Claude (hosted)")!.click());
      expect(input()?.autocomplete).toBe("off");
      expect((button("Connect") as HTMLButtonElement).disabled).toBe(true);
      await type(KEY);
      await act(async () => { button("Connect")!.click(); });
      await settle();
      expect(mocks.setup).toHaveBeenCalledTimes(1);
      expect(mocks.setup).toHaveBeenCalledWith("company-1", { adapterType: "claude_managed", apiKey: KEY });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("That Anthropic API key was rejected.");
      expect(input()?.value).toBe("");
      expect(container.innerHTML).not.toContain(KEY);
    });

    it("clears the key and leaves it out of the page after a successful submit", async () => {
      withHosted();
      const onSuccess = mocks.setup;
      await render({ state: "needs_model" });
      await act(async () => button("Claude (hosted)")!.click());
      await type(KEY);
      await act(async () => { button("Connect")!.click(); });
      await settle();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(input()?.value ?? "").toBe("");
      expect(container.innerHTML).not.toContain(KEY);
    });

    it("connects without a key when the server provides one", async () => {
      withHosted({ available: true, signedIn: true, needsKey: false });
      await render({ state: "needs_model" });
      expect(button("Claude (hosted)")?.textContent).toContain("Provided by this Staples server.");
      await act(async () => button("Claude (hosted)")!.click());
      expect(input()).toBeNull();
      await act(async () => { button("Connect")!.click(); });
      await settle();
      expect(mocks.setup).toHaveBeenCalledWith("company-1", { adapterType: "claude_managed" });
    });
  });
});

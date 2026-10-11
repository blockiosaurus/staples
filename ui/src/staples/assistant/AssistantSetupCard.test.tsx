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
  testAgentSetup: vi.fn(),
  connectionProps: [] as Array<Record<string, any>>,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { testEnvironment: mocks.testEnvironment, retryLifecycle: mocks.retryLifecycle },
}));
vi.mock("@/api/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/assistant")>()),
  assistantApi: { setup: mocks.setup },
}));
vi.mock("@/lib/test-agent-setup", () => ({ testAgentSetup: mocks.testAgentSetup }));
vi.mock("@/components/AdapterMark", () => ({ AdapterMark: () => null }));
vi.mock("@/components/new-agent/AgentProviderConnection", () => ({
  AgentProviderConnection: (props: Record<string, any>) => {
    mocks.connectionProps.push(props);
    return <div data-testid="provider-connection">Connect {props.adapterType}</div>;
  },
}));

const check = (code: string, level = "info") => ({ code, level, message: code });
const result = (status: string, codes: Array<[string, string?]>) => ({
  adapterType: "x", status, testedAt: "", checks: codes.map(([code, level]) => check(code, level)),
});

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
    mocks.setup.mockReset().mockResolvedValue({
      agent: { id: "assistant-1", name: "Assistant", urlKey: "assistant", adapterType: "claude_local", status: "paused" },
      setup: { state: "starting", adapterType: "claude_local" },
    });
    mocks.testAgentSetup.mockReset();
    mocks.testEnvironment.mockReset().mockImplementation(async (_companyId: string, type: string, data: { adapterConfig: Record<string, unknown> }) => {
      if (type === "claude_local") {
        return data.adapterConfig.engine === "cli"
          ? result("warn", [["claude_command_resolvable"], ["claude_hello_probe_auth_required", "warn"]])
          : result("fail", [["adapter_engine_unavailable", "error"]]);
      }
      if (type === "gemini_local") return result("pass", [["gemini_command_resolvable"], ["gemini_hello_probe_passed"]]);
      return result("fail", [[`${type.replace("_local", "")}_command_unresolvable`, "error"]]);
    });
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
  async function render(setup: { state: "ready" | "starting" | "needs_model" | "error"; message?: string }) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantSetupCard companyId="company-1" agentId="assistant-1" setup={{ adapterType: "claude_local", ...setup }} />
        </QueryClientProvider>,
      );
    });
    await settle();
  }
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text));

  it("lists only the runtime adapters, probing each and marking what is installed", async () => {
    await render({ state: "needs_model" });
    expect(mocks.testEnvironment.mock.calls.map((call) => call[1]).sort()).toEqual(
      ["claude_local", "claude_local", "codex_local", "gemini_local", "kimi_local"],
    );
    // Claude's ACP lane is missing on this host: it is re-probed on the CLI engine.
    expect(mocks.testEnvironment).toHaveBeenCalledWith("company-1", "claude_local", { adapterConfig: { engine: "cli" } });
    expect(button("Claude")?.textContent).toContain("Installed");
    expect(button("Claude")?.disabled).toBe(false);
    expect(button("Gemini")?.textContent).toContain("Installed");
    expect(button("Codex")?.textContent).toContain("Not installed");
    expect(button("Codex")?.disabled).toBe(true);
    expect(button("Kimi")?.disabled).toBe(true);
  });

  it("connects Claude through AgentProviderConnection and configures the Assistant on the CLI engine", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Claude")!.click());
    expect(container.querySelector('[data-testid="provider-connection"]')).not.toBeNull();
    const props = mocks.connectionProps.at(-1)!;
    expect(props.adapterType).toBe("claude_local");

    mocks.testAgentSetup.mockResolvedValue(result("pass", [["claude_hello_probe_passed"]]));
    const connection = { env: {}, aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
    await expect(props.testConnection(connection)).resolves.toBe(true);
    expect(mocks.testAgentSetup).toHaveBeenCalledWith(expect.objectContaining({
      adapterType: "claude_local", adapterConfig: { engine: "cli", env: {} }, aiConnection: connection.aiConnection,
    }));

    await act(async () => props.onConnected(connection));
    await settle();
    expect(mocks.setup).toHaveBeenCalledWith("company-1", {
      adapterType: "claude_local",
      adapterConfig: { engine: "cli" },
      aiConnection: connection.aiConnection,
    });
  });

  it("reports a failed connection test without configuring", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Claude")!.click());
    mocks.testAgentSetup.mockResolvedValue(result("warn", [["claude_hello_probe_auth_required", "warn"]]));
    await expect(mocks.connectionProps.at(-1)!.testConnection({ env: {} })).resolves.toBe(false);
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("uses an already signed-in CLI adapter directly", async () => {
    await render({ state: "needs_model" });
    await act(async () => button("Gemini")!.click());
    await act(async () => button("Use Gemini")!.click());
    await settle();
    expect(mocks.setup).toHaveBeenCalledWith("company-1", { adapterType: "gemini_local" });
  });

  it("shows a spinner while starting", async () => {
    await render({ state: "starting" });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Getting the Assistant ready");
    expect(mocks.testEnvironment).not.toHaveBeenCalled();
  });

  it("shows the error with a Retry that retries the lifecycle", async () => {
    await render({ state: "error", message: "The lifecycle step failed. Retry the operation." });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The lifecycle step failed");
    await act(async () => button("Retry")!.click());
    await settle();
    expect(mocks.retryLifecycle).toHaveBeenCalledWith("assistant-1", "company-1");
  });
});

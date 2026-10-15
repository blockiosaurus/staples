// @vitest-environment jsdom

// `/agents/new` is the Hire an agent marketplace; the custom new-agent form
// moved to `/agents/new/custom`. Drives the real <App> route table.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papActivityRoutingPatched?: boolean;
  };
  if (!sheetProto.__papActivityRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap16302-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papActivityRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// Sentinel page that also reports the resolved path + query, so we can assert
// the merged route *and* the preset mode a redirect carried into it.
vi.mock("./pages/NewAgent", () => ({
  NewAgent: () => {
    const location = useLocation();
    return <div>{`CUSTOM_FORM@${location.pathname}${location.search}`}</div>;
  },
}));

vi.mock("./pages/AgentDetail", () => ({
  AgentDetail: () => <div>AGENT_DETAIL</div>,
}));

vi.mock("./api/agentTemplates", () => ({
  agentTemplatesApi: { list: vi.fn(async () => []), get: vi.fn() },
}));

vi.mock("./staples/assistant/AssistantProvider", () => ({ useAskAssistant: () => () => false }));

const PAP_COMPANY = { id: "company-1", name: "Staples", issuePrefix: "PAP", status: "active" };
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BreadcrumbProvider companyName="Staples">
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </BreadcrumbProvider>
      </QueryClientProvider>,
    );
  });
  return root;
}

async function waitForText(container: HTMLElement, text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}

describe("App new-agent routing", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("serves the marketplace at /:company/agents/new", async () => {
    const root = renderAppAt(container, "/PAP/agents/new");
    await waitForText(container, "Hire an agent");
    expect(container.textContent).not.toContain("CUSTOM_FORM");
    expect(container.textContent).not.toContain("AGENT_DETAIL");
    flushSync(() => root.unmount());
  });

  it("serves the custom form at /:company/agents/new/custom with its parameters", async () => {
    const root = renderAppAt(container, "/PAP/agents/new/custom?name=Carl&adapterType=codex_local");
    await waitForText(container, "CUSTOM_FORM@/PAP/agents/new/custom?name=Carl&adapterType=codex_local");
    flushSync(() => root.unmount());
  });

  it("sends old /agents/new links with custom-form parameters to the custom form", async () => {
    const root = renderAppAt(container, "/PAP/agents/new?name=Carl&adapterType=codex_local");
    await waitForText(container, "CUSTOM_FORM@/PAP/agents/new/custom?name=Carl&adapterType=codex_local");
    flushSync(() => root.unmount());
  });
});

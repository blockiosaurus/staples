// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAutopilotCategory, AgentTemplateSummary } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AutopilotPanel } from "./AutopilotPanel";
import { AgentTemplateChip } from "./AgentTemplateChip";
import { agentTemplateRecord, outwardCategoryForTool, toolNamePatternMatches } from "./templateRecord";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
  listTemplates: vi.fn(),
  revokeTrustRule: vi.fn(),
}));

vi.mock("@/api/agentAutopilot", () => ({ agentAutopilotApi: { get: mocks.get, setMode: mocks.setMode } }));
vi.mock("@/api/tools", () => ({ toolsApi: { revokeTrustRule: mocks.revokeTrustRule } }));
vi.mock("@/api/agentTemplates", () => ({ agentTemplatesApi: { list: mocks.listTemplates } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={`/PAP${to}`} {...props}>
      {children}
    </a>
  ),
}));

const CONTENT_TEMPLATE = {
  ref: "staples/content-creator",
  version: "1.0.0",
  readOnly: false,
  outwardActions: [
    { capability: "social", label: "Publishing posts", toolPatterns: ["*post*", "*publish*"] },
    { capability: "cms", label: "Publishing to your site", toolPatterns: ["*publish*"] },
  ],
  requiredApps: [
    { capability: "social", anyOf: ["linkedin", "x"], why: "Posts." },
    { capability: "cms", anyOf: ["webflow"], why: "Site." },
  ],
};
const EMAIL_TEMPLATE = {
  ref: "staples/email-secretary",
  version: "1.0.1",
  readOnly: false,
  outwardActions: [{
    capability: "email", label: "Sending email", destructiveLabel: "Deleting email",
    toolPatterns: ["*send*", "*reply*"], destructiveToolPatterns: ["*delete*", "*trash*"],
  }],
  requiredApps: [{ capability: "email", anyOf: ["agentmail", "gmail"], why: "Email." }],
};

function category(overrides: Partial<AgentAutopilotCategory> & Pick<AgentAutopilotCategory, "capability" | "label">): AgentAutopilotCategory {
  return { destructiveLabel: null, connection: null, mode: "ask", stale: false, canToggle: false, remembered: [], ...overrides };
}

const SOCIAL = category({
  capability: "social",
  label: "Publishing posts",
  connection: { id: "conn-x", appSlug: "x", displayName: "X (Acme)" },
  canToggle: true,
});
const CMS = category({ capability: "cms", label: "Publishing to your site" });
const EMAIL = category({
  capability: "email",
  label: "Sending email",
  destructiveLabel: "Deleting email",
  connection: { id: "conn-mail", appSlug: "agentmail", displayName: "AgentMail inbox" },
  mode: "auto",
  canToggle: true,
});

describe("AutopilotPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    for (const mock of Object.values(mocks)) mock.mockReset();
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

  async function render(metadata: unknown, name = "Casey") {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutopilotPanel agent={{ id: "agent-1", companyId: "company-1", name, metadata }} />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  const row = (capability: string) => container.querySelector<HTMLElement>(`[data-testid="autopilot-row-${capability}"]`);
  const radio = (scope: HTMLElement | null, label: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((button) => button.textContent === label) ?? null;
  const checkedLabel = (scope: HTMLElement | null) =>
    scope?.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null;

  it("shows remembered permissions for a category and lets the person make them ask again", async () => {
    const remembered = [{ policyId: "trust-1", toolName: "create_post" }];
    mocks.get.mockResolvedValueOnce({ categories: [{ ...SOCIAL, remembered }, CMS] });
    mocks.get.mockResolvedValue({ categories: [SOCIAL, CMS] });
    mocks.revokeTrustRule.mockResolvedValue({ id: "trust-1" });
    await render({ staplesTemplate: CONTENT_TEMPLATE });

    const note = container.querySelector<HTMLElement>('[data-testid="autopilot-remembered-social"]');
    expect(note?.textContent).toContain("Some actions are always allowed (remembered)");
    expect(note?.textContent).toContain("create_post");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/PAP/agents/agent-1/tools");
    expect(container.querySelector('[data-testid="autopilot-remembered-cms"]')).toBeNull();

    const button = [...(note?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === "Ask first again")!;
    await act(async () => button.click());
    await settle();
    expect(mocks.revokeTrustRule).toHaveBeenCalledWith("company-1", "trust-1", expect.any(String));
    expect(container.querySelector('[data-testid="autopilot-remembered-social"]')).toBeNull();
  });

  it("shows one row per category with its connection or a Connect link, and its mode", async () => {
    mocks.get.mockResolvedValue({ categories: [SOCIAL, CMS] });
    await render({ staplesTemplate: CONTENT_TEMPLATE });

    expect(mocks.get).toHaveBeenCalledWith("agent-1");
    expect(container.textContent).toContain("Choose what Casey may do without asking you first.");
    const social = row("social")!;
    expect(social.textContent).toContain("Publishing posts");
    expect(social.textContent).toContain("Using X (Acme)");
    expect(social.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Publishing posts");
    expect(checkedLabel(social)).toBe("Ask first");
    expect(radio(social, "Send without asking")?.disabled).toBe(false);

    const cms = row("cms")!;
    const connect = cms.querySelector("a");
    expect(connect?.textContent).toBe("Connect Webflow first");
    expect(connect?.getAttribute("href")).toBe("/PAP/apps");
    // No connection: the control is disabled.
    expect(radio(cms, "Ask first")?.disabled).toBe(true);
    expect(radio(cms, "Send without asking")?.disabled).toBe(true);
    expect(cms.querySelector('[role="radiogroup"]')?.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the destructive action as Always asks with no control", async () => {
    mocks.get.mockResolvedValue({ categories: [EMAIL] });
    await render({ staplesTemplate: EMAIL_TEMPLATE });
    const email = row("email")!;
    expect(checkedLabel(email)).toBe("Send without asking");
    const destructive = container.querySelector<HTMLElement>('[data-testid="autopilot-destructive-email"]')!;
    expect(destructive.textContent).toContain("Deleting email");
    expect(destructive.textContent).toContain("Always asks");
    expect(destructive.querySelector('[role="radiogroup"], button')).toBeNull();
    expect(email.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  });

  it("shows a stale category as Ask first with a note to turn it on again", async () => {
    mocks.get.mockResolvedValue({ categories: [{ ...EMAIL, mode: "ask", stale: true }] });
    await render({ staplesTemplate: EMAIL_TEMPLATE });
    const email = row("email")!;
    expect(checkedLabel(email)).toBe("Ask first");
    expect(email.textContent).toContain("Autopilot needs to be turned on again for AgentMail inbox");
  });

  it("shows the stale note when the connection is gone", async () => {
    mocks.get.mockResolvedValue({ categories: [{ ...EMAIL, connection: null, canToggle: false, mode: "ask", stale: true }] });
    await render({ staplesTemplate: EMAIL_TEMPLATE });
    expect(row("email")?.textContent).toContain("Autopilot needs to be turned on again once AgentMail or Gmail is connected");
    expect(checkedLabel(row("email"))).toBe("Ask first");
  });

  it("toggles optimistically, calls the API and refetches", async () => {
    mocks.get.mockResolvedValueOnce({ categories: [SOCIAL, CMS] });
    let resolveSet!: (value: AgentAutopilotCategory) => void;
    mocks.setMode.mockReturnValue(new Promise((resolve) => { resolveSet = resolve; }));
    await render({ staplesTemplate: CONTENT_TEMPLATE });

    mocks.get.mockResolvedValue({ categories: [{ ...SOCIAL, mode: "auto" }, CMS] });
    await act(async () => radio(row("social"), "Send without asking")!.click());
    expect(mocks.setMode).toHaveBeenCalledWith("agent-1", "social", "auto");
    // Optimistic: already shown as on, and the control is busy.
    expect(checkedLabel(row("social"))).toBe("Send without asking");
    expect(radio(row("social"), "Ask first")?.disabled).toBe(true);

    await act(async () => resolveSet({ ...SOCIAL, mode: "auto" }));
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(checkedLabel(row("social"))).toBe("Send without asking");
    expect(radio(row("social"), "Ask first")?.disabled).toBe(false);
  });

  it("rolls back and shows the error inline when the change fails", async () => {
    mocks.get.mockResolvedValue({ categories: [SOCIAL, CMS] });
    mocks.setMode.mockRejectedValue(new Error("Connect an app for this first"));
    await render({ staplesTemplate: CONTENT_TEMPLATE });

    await act(async () => radio(row("social"), "Send without asking")!.click());
    await settle();
    expect(checkedLabel(row("social"))).toBe("Ask first");
    expect(row("social")?.querySelector('[role="alert"]')?.textContent).toBe("Connect an app for this first");
    expect(row("cms")?.querySelector('[role="alert"]')).toBeNull();
  });

  it("rolls back only the failed category when two changes are in flight", async () => {
    const SECOND = { ...SOCIAL, capability: "news", label: "Sending newsletters" };
    mocks.get.mockResolvedValue({ categories: [SOCIAL, SECOND] });
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: AgentAutopilotCategory) => void;
    mocks.setMode
      .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    await render({ staplesTemplate: CONTENT_TEMPLATE });

    await act(async () => radio(row("social"), "Send without asking")!.click());
    await act(async () => radio(row("news"), "Send without asking")!.click());
    expect(radio(row("social"), "Ask first")?.disabled).toBe(true);
    expect(radio(row("news"), "Ask first")?.disabled).toBe(true);

    await act(async () => rejectFirst(new Error("Could not change")));
    await settle();
    expect(checkedLabel(row("social"))).toBe("Ask first");
    expect(row("social")?.querySelector('[role="alert"]')?.textContent).toBe("Could not change");
    // The other change is still in flight and keeps its optimistic value.
    expect(checkedLabel(row("news"))).toBe("Send without asking");
    expect(radio(row("news"), "Ask first")?.disabled).toBe(true);
    expect(radio(row("social"), "Ask first")?.disabled).toBe(false);

    mocks.get.mockResolvedValue({ categories: [SOCIAL, { ...SECOND, mode: "auto" }] });
    await act(async () => resolveSecond({ ...SECOND, mode: "auto" }));
    await settle();
    expect(checkedLabel(row("news"))).toBe("Send without asking");
    expect(row("news")?.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not call the API when the current mode is clicked again", async () => {
    mocks.get.mockResolvedValue({ categories: [SOCIAL] });
    await render({ staplesTemplate: CONTENT_TEMPLATE });
    await act(async () => radio(row("social"), "Ask first")!.click());
    expect(mocks.setMode).not.toHaveBeenCalled();
  });

  it("shows a retryable load error", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Agent not found"));
    await render({ staplesTemplate: EMAIL_TEMPLATE });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Agent not found");
    mocks.get.mockResolvedValue({ categories: [EMAIL] });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    await settle();
    expect(row("email")).not.toBeNull();
  });

  it("explains when the agent has no categories or no template", async () => {
    mocks.get.mockResolvedValue({ categories: [] });
    await render({ staplesTemplate: { ref: "staples/researcher", version: "1.0.0", readOnly: true, outwardActions: [], requiredApps: [] } }, "Riley");
    expect(container.textContent).toContain("Riley has no outward actions to put on Autopilot.");

    act(() => root.unmount());
    root = createRoot(container);
    mocks.get.mockClear();
    await render({});
    expect(mocks.get).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Autopilot is available for agents hired from a template.");
  });

  it("invalidates only this agent's Autopilot query key", () => {
    expect(queryKeys.agentAutopilot("agent-1")).toEqual(["agent-autopilot", "agent-1"]);
  });
});

describe("AgentTemplateChip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listTemplates.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(metadata: unknown) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentTemplateChip agent={{ metadata }} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("names the template from the marketplace with its pinned version", async () => {
    mocks.listTemplates.mockResolvedValue([{ ref: "staples/email-secretary", name: "Email secretary" } as AgentTemplateSummary]);
    await render({ staplesTemplate: EMAIL_TEMPLATE });
    expect(mocks.listTemplates).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="agent-template-chip"]')?.textContent).toBe("From template: Email secretary v1.0.1");
  });

  it("falls back to the ref's slug when the template is not listed", async () => {
    mocks.listTemplates.mockResolvedValue([]);
    await render({ staplesTemplate: { ref: "staples/preview-thing", version: "0.1.0" } });
    expect(container.querySelector('[data-testid="agent-template-chip"]')?.textContent).toBe("From template: preview-thing v0.1.0");
  });

  it("renders nothing for an agent not hired from a template", async () => {
    await render({ other: 1 });
    expect(container.querySelector('[data-testid="agent-template-chip"]')).toBeNull();
    expect(mocks.listTemplates).not.toHaveBeenCalled();
  });
});

describe("template record helpers", () => {
  it("reads the record and matches tool names to one outward category", () => {
    const record = agentTemplateRecord({ staplesTemplate: EMAIL_TEMPLATE });
    expect(record).toMatchObject({ ref: "staples/email-secretary", slug: "email-secretary", version: "1.0.1" });
    expect(outwardCategoryForTool(record, "send_message")?.label).toBe("Sending email");
    expect(outwardCategoryForTool(record, "SEND_MESSAGE")?.label).toBe("Sending email");
    // Destructive names never belong to the routine category.
    expect(outwardCategoryForTool(record, "trash_and_send")).toBeNull();
    expect(outwardCategoryForTool(record, "list_messages")).toBeNull();
    // Ambiguous across categories: no single label.
    expect(outwardCategoryForTool(agentTemplateRecord({ staplesTemplate: CONTENT_TEMPLATE }), "publish_item")).toBeNull();
    expect(agentTemplateRecord(null)).toBeNull();
    expect(agentTemplateRecord({ staplesTemplate: { version: "1" } })).toBeNull();
  });

  it("matches globs literally apart from *", () => {
    expect(toolNamePatternMatches("*send*", "gmail.send_message")).toBe(true);
    expect(toolNamePatternMatches("send", "send_message")).toBe(false);
    expect(toolNamePatternMatches("*.*", "ab")).toBe(false);
    expect(toolNamePatternMatches("*", "anything")).toBe(false);
  });
});

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplateDetail, AgentTemplateSummary } from "@paperclipai/shared";
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/BreadcrumbContext";
import { MarketplacePage, groupTemplates } from "./MarketplacePage";
import { HIRE_UNAVAILABLE_NOTICE } from "./TemplateDetailSheet";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  askAssistant: vi.fn(),
  search: "",
}));

vi.mock("@/api/agentTemplates", () => ({ agentTemplatesApi: { list: mocks.list, get: mocks.get } }));
vi.mock("@/staples/assistant/AssistantProvider", () => ({ useAskAssistant: () => mocks.askAssistant }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Acme" } }),
}));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/agents/new", search: mocks.search }),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={`/PAP${to}`} {...props}>
      {children}
    </a>
  ),
}));

function summary(overrides: Partial<AgentTemplateSummary> & Pick<AgentTemplateSummary, "slug" | "name">): AgentTemplateSummary {
  return {
    ref: `staples/${overrides.slug}`,
    tagline: `${overrides.name} tagline`,
    icon: "mail",
    marketplaceCategory: "communication",
    version: "1.0.0",
    needs: [],
    asksBefore: [],
    routines: [],
    defaultBudgetMonthlyCents: null,
    readOnly: false,
    ...overrides,
  };
}

const SECRETARY = summary({
  slug: "email-secretary",
  name: "Email secretary",
  needs: [
    { capability: "email", anyOf: ["gmail", "agentmail"], optional: false, why: "Reads and drafts your email." },
    { capability: "calendar", anyOf: ["google-calendar"], optional: true, why: "Checks your calendar." },
  ],
  asksBefore: ["Send an email"],
  routines: [
    { title: "Morning inbox sweep", schedule: "0 8 * * 1-5", timezone: "person" },
    { title: "Weekly review", schedule: "0 16 * * 5", timezone: "America/New_York" },
  ],
  defaultBudgetMonthlyCents: 2000,
});
const BOOKKEEPER = summary({
  slug: "bookkeeper",
  name: "Bookkeeper",
  icon: "calculator",
  marketplaceCategory: "finance",
  needs: [{ capability: "accounting", anyOf: ["xero"], optional: false, why: "Reads your books." }],
  readOnly: true,
});
const RESEARCHER = summary({ slug: "researcher", name: "Researcher", icon: "search", marketplaceCategory: "research" });
const CODER = summary({ slug: "coding-agent", name: "Coding agent", icon: "code", marketplaceCategory: "engineering" });

const SECRETARY_DETAIL: AgentTemplateDetail = {
  ...SECRETARY,
  description: "Your secretary keeps the inbox tidy.",
  setupQuestions: [
    {
      id: "callMe",
      prompt: "What should your secretary call you?",
      required: true,
      answerMode: "text",
      initialText: "Pat Lee",
    },
    {
      id: "sweepTime",
      prompt: "When should the morning inbox sweep run?",
      required: true,
      answerMode: "single_select",
      options: [
        { id: "7am", label: "7:00" },
        { id: "8am", label: "8:00", recommended: true },
      ],
    },
  ],
};

function Crumbs() {
  const { breadcrumbs } = useBreadcrumbs();
  return <span data-testid="crumbs">{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</span>;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("MarketplacePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.list.mockReset();
    mocks.get.mockReset();
    mocks.askAssistant.mockReset();
    mocks.search = "";
    // Out of category order on purpose: the page orders sections itself.
    mocks.list.mockResolvedValue([CODER, BOOKKEEPER, SECRETARY, RESEARCHER]);
    mocks.get.mockResolvedValue(SECRETARY_DETAIL);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BreadcrumbProvider companyName="Acme">
            <Crumbs />
            <MarketplacePage />
          </BreadcrumbProvider>
        </QueryClientProvider>,
      );
    });
    await flush();
    await vi.waitFor(() =>
      expect(container.querySelector('h2, [role="alert"], [data-testid="navigate"]')).not.toBeNull(),
    );
  }

  async function openSecretary() {
    const card = container.querySelector<HTMLButtonElement>('[data-testid="template-card-email-secretary"]');
    expect(card, container.innerHTML.slice(0, 400)).not.toBeNull();
    await act(async () => card!.click());
    await flush();
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Setup questions"]')).not.toBeNull());
  }

  function hireButton() {
    return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Hire");
  }

  it("groups templates into categories in marketplace order, dropping empty ones", () => {
    expect(groupTemplates([CODER, BOOKKEEPER, SECRETARY, RESEARCHER]).map((group) => group.category)).toEqual([
      "communication",
      "research",
      "engineering",
      "finance",
    ]);
  });

  it("renders the heading, category sections in order and a Build your own link", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Hire an agent");
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Communication",
      "Research",
      "Engineering",
      "Finance",
    ]);
    const build = [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("Build your own"));
    expect(build?.getAttribute("href")).toBe("/PAP/agents/new/custom");
    expect(container.querySelector('[data-testid="crumbs"]')?.textContent).toBe("Agents / Hire an agent");
  });

  it("cards show what the agent needs, what it asks before, read-only and works right away", async () => {
    await render();
    const secretary = container.querySelector('[data-testid="template-card-email-secretary"]')!.textContent;
    expect(secretary).toContain("Email secretary");
    expect(secretary).toContain("Email secretary tagline");
    expect(secretary).toContain("Needs: Gmail or AgentMail");
    expect(secretary).not.toContain("Google Calendar");
    expect(secretary).toContain("Asks before: Send an email");
    const bookkeeper = container.querySelector('[data-testid="template-card-bookkeeper"]')!.textContent;
    expect(bookkeeper).toContain("Needs: Xero");
    expect(bookkeeper).toContain("Read-only");
    const researcher = container.querySelector('[data-testid="template-card-researcher"]')!.textContent;
    expect(researcher).toContain("Works right away");
    expect(researcher).not.toContain("Asks before");
  });

  it("the detail sheet shows the description, human schedules, services and access, and the setup questions", async () => {
    await render();
    await openSecretary();
    expect(mocks.get).toHaveBeenCalledWith("company-1", "email-secretary");
    const text = document.body.textContent ?? "";
    expect(document.body.querySelector('[data-testid="markdown"]')?.textContent).toBe("Your secretary keeps the inbox tidy.");
    expect(text).toContain("Morning inbox sweep");
    expect(text).toContain("Weekdays at 8:00");
    expect(text).toContain("Fridays at 16:00 (America/New_York)");
    expect(text).not.toContain("0 8 * * 1-5");
    expect(text).toContain("Gmail or AgentMail");
    expect(text).toContain("Reads and drafts your email.");
    expect(text).toContain("Google Calendar (optional)");
    expect(text).toContain("Send an email");
    expect(text).toContain("$20 a month");
    const questions = document.body.querySelector('[aria-label="Setup questions"]')!;
    expect(questions.textContent).toContain("What should your secretary call you?");
    expect(questions.textContent).toContain("Suggested: Pat Lee");
    expect(questions.textContent).toContain("8:00 (recommended)");
    expect(questions.querySelector("input, textarea, select")).toBeNull();
  });

  it("Hire hands off to the Assistant with the template's name and closes the sheet", async () => {
    mocks.askAssistant.mockReturnValue(true);
    await render();
    await openSecretary();
    await act(async () => hireButton()!.click());
    await flush();
    expect(mocks.askAssistant).toHaveBeenCalledWith({ text: "Set up Email secretary", send: true });
    expect(hireButton()).toBeUndefined();
    expect(document.body.textContent).not.toContain(HIRE_UNAVAILABLE_NOTICE);
  });

  it("shows the unavailable notice and keeps the sheet open when the Assistant can't take it", async () => {
    mocks.askAssistant.mockReturnValue(false);
    await render();
    await openSecretary();
    await act(async () => hireButton()!.click());
    await flush();
    expect(mocks.askAssistant).toHaveBeenCalledWith({ text: "Set up Email secretary", send: true });
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(HIRE_UNAVAILABLE_NOTICE);
    expect(hireButton()).toBeDefined();
  });

  it("surfaces a failed list load with a retry", async () => {
    mocks.list.mockRejectedValue(new Error("Server unavailable"));
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Server unavailable");
    expect([...alert!.querySelectorAll("button")].some((button) => button.textContent?.includes("Retry"))).toBe(true);
  });

  it("sends old /agents/new links carrying custom-form parameters on to the custom form", async () => {
    mocks.search = "?name=Carl&adapterType=codex_local";
    await render();
    expect(container.querySelector('[data-testid="navigate"]')?.textContent).toBe(
      "/agents/new/custom?name=Carl&adapterType=codex_local",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

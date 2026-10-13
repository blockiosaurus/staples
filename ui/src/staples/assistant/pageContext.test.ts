import { describe, expect, it } from "vitest";
import { assistantPageContextSchema } from "@paperclipai/shared";
import { currentPageContext, pageContextLabel } from "./pageContext";

describe("currentPageContext", () => {
  it("derives a company-relative issue context with the page's label and title", () => {
    const context = currentPageContext({
      pathname: "/PAP/issues/PAP-12",
      companyPrefix: "pap",
      title: "Fix login • Acme • Paperclip",
      label: "Fix login",
    });
    expect(context).toEqual({
      route: "/issues/PAP-12",
      title: "Fix login • Acme • Paperclip",
      entity: { type: "issue", id: "PAP-12", label: "Fix login" },
    });
    expect(assistantPageContextSchema.safeParse(context).success).toBe(true);
  });

  it.each([
    ["/PAP/agents/alpha/runs/r1", { type: "agent", id: "alpha" }],
    ["/PAP/projects/p1/issues", { type: "project", id: "p1" }],
    ["/PAP/goals/g1", { type: "goal", id: "g1" }],
    ["/PAP/routines/rt1/history", { type: "routine", id: "rt1" }],
    ["/PAP/approvals/a1", { type: "approval", id: "a1" }],
    ["/PAP/skills/s1", { type: "skill", id: "s1" }],
  ])("maps %s to its entity", (pathname, entity) => {
    expect(currentPageContext({ pathname, companyPrefix: "PAP" })?.entity).toEqual(entity);
  });

  it.each(["/PAP/issues", "/PAP/issues/all", "/PAP/agents/all", "/PAP/agents/new", "/PAP/agents/new/custom", "/PAP/approvals/pending", "/PAP/skills/studio", "/PAP/dashboard"])(
    "has no entity on list or non-entity page %s",
    (pathname) => {
      const context = currentPageContext({ pathname, companyPrefix: "PAP" });
      expect(context).not.toBeNull();
      expect(context?.entity).toBeUndefined();
    },
  );

  it.each(["/PAP/company/settings/secrets", "/PAP/company/settings/access/members", "/PAP/settings/general"])(
    "sends only the route on settings page %s",
    (pathname) => {
      const context = currentPageContext({ pathname, companyPrefix: "PAP", title: "API key sk-123 • Acme", label: "sk-123" });
      expect(context).toEqual({ route: pathname.replace("/PAP", "") });
    },
  );

  it("is null on the Assistant page itself", () => {
    expect(currentPageContext({ pathname: "/PAP/assistant", companyPrefix: "PAP" })).toBeNull();
  });

  it("clips fields to the schema limits", () => {
    const context = currentPageContext({
      pathname: `/PAP/issues/${"x".repeat(300)}/${"y".repeat(600)}`,
      companyPrefix: "PAP",
      title: "t".repeat(300),
      label: "l".repeat(300),
    });
    expect(assistantPageContextSchema.safeParse(context).success).toBe(true);
  });

  it("labels the chip with the entity label, then the page title, then the route", () => {
    expect(pageContextLabel({ route: "/issues/PAP-1", entity: { type: "issue", id: "PAP-1", label: "Fix login" } })).toBe("Fix login");
    expect(pageContextLabel({ route: "/dashboard", title: "Dashboard • Acme • Paperclip" })).toBe("Dashboard");
    expect(pageContextLabel({ route: "/dashboard" })).toBe("/dashboard");
  });
});

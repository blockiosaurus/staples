// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MoreFieldsToggle,
  executionHasContent,
  relationshipsHaveContent,
  workspaceHasContent,
  isSectionHidden,
  moreFieldsStorageKey,
  useMoreFieldsExpanded,
} from "./more-fields";

// Mirrors how IssueProperties wires the disclosure: Work and About always show;
// Relationships / Execution / Workspace show only with content or when expanded.
function Harness({ companyId, hasBlocker = false }: { companyId: string; hasBlocker?: boolean }) {
  const [expanded, toggle] = useMoreFieldsExpanded(companyId);
  const sections = [
    { id: "issue-props-relationships", has: hasBlocker },
    { id: "issue-props-execution", has: false },
    { id: "issue-props-workspace", has: false },
  ];
  return (
    <div>
      <section data-testid="work">Work</section>
      {sections.map((s) => (
        <div key={s.id} id={s.id} hidden={isSectionHidden(s.has, expanded)} />
      ))}
      {sections.some((s) => !s.has) ? (
        <MoreFieldsToggle expanded={expanded} onToggle={toggle} controls={sections.map((s) => s.id).join(" ")} />
      ) : null}
      <section data-testid="about">About</section>
    </div>
  );
}

const hidden = (id: string) => (document.getElementById(id) as HTMLElement).hidden;

describe("issue properties More fields disclosure", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  it("empty task shows Work + About + More fields with optional sections hidden", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<Harness companyId="c1" />));
    expect(container.querySelector('[data-testid="work"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="about"]')).not.toBeNull();
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toContain("More fields");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(
      "issue-props-relationships issue-props-execution issue-props-workspace",
    );
    expect(hidden("issue-props-relationships")).toBe(true);
    expect(hidden("issue-props-execution")).toBe(true);
    await act(async () => root.unmount());
  });

  it("a section with content shows without expanding", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<Harness companyId="c1" hasBlocker />));
    expect(hidden("issue-props-relationships")).toBe(false);
    expect(hidden("issue-props-execution")).toBe(true);
    await act(async () => root.unmount());
  });

  it("expanding reveals all sections and persists per company", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<Harness companyId="c1" />));
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(hidden("issue-props-execution")).toBe(false);
    expect(hidden("issue-props-workspace")).toBe(false);
    expect(window.localStorage.getItem(moreFieldsStorageKey("c1"))).toBe("1");
    expect(moreFieldsStorageKey("c1")).toBe("staples:issue-props-expanded:c1");
    await act(async () => root.unmount());

    const second = createRoot(container);
    await act(async () => second.render(<Harness companyId="c1" />));
    expect(hidden("issue-props-execution")).toBe(false);
    await act(async () => second.unmount());

    const other = createRoot(container);
    await act(async () => other.render(<Harness companyId="c2" />));
    expect(hidden("issue-props-execution")).toBe(true);
    await act(async () => other.unmount());
  });

  it("a section that gains content stays visible after collapsing", () => {
    expect(isSectionHidden(true, false)).toBe(false);
    expect(isSectionHidden(false, false)).toBe(true);
    expect(isSectionHidden(false, true)).toBe(false);
  });

  it("does not break when localStorage throws", async () => {
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const root = createRoot(container);
    await act(async () => root.render(<Harness companyId="c1" />));
    expect(hidden("issue-props-execution")).toBe(true);
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(hidden("issue-props-execution")).toBe(false);
    await act(async () => root.unmount());
    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  it("toggle label flips to Fewer fields when expanded", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<Harness companyId="c1" />));
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(button.textContent).toContain("Fewer fields");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => root.unmount());
  });
});

describe("section content predicates", () => {
  const rel = { blockedByCount: 0, blockingCount: 0, childCount: 0, relatedTaskCount: 0, pullRequestCount: 0, externalObjectCount: 0 };
  const exe = { policyAvailable: true, hasReviewPolicyBadge: false, reviewerCount: 0, approverCount: 0, hasMonitor: false, hasWatchdog: false };
  const ws = { hasWorkspaceOverride: false, hasRuntimeControls: false };

  it("Relationships", () => {
    expect(relationshipsHaveContent(rel)).toBe(false);
    expect(relationshipsHaveContent({ ...rel, blockedByCount: 1 })).toBe(true);
    expect(relationshipsHaveContent({ ...rel, blockingCount: 1 })).toBe(true);
    expect(relationshipsHaveContent({ ...rel, parentId: "p" })).toBe(true);
    expect(relationshipsHaveContent({ ...rel, childCount: 1 })).toBe(true);
    expect(relationshipsHaveContent({ ...rel, relatedTaskCount: 1 })).toBe(true);
    expect(relationshipsHaveContent({ ...rel, pullRequestCount: 1 })).toBe(true);
  });

  it("Execution", () => {
    expect(executionHasContent(exe)).toBe(false);
    expect(executionHasContent({ ...exe, reviewerCount: 1 })).toBe(true);
    expect(executionHasContent({ ...exe, approverCount: 1 })).toBe(true);
    expect(executionHasContent({ ...exe, hasWatchdog: true })).toBe(true);
    expect(executionHasContent({ ...exe, currentExecutionLabel: "Running" })).toBe(true);
    expect(executionHasContent({ ...exe, showScheduledRetryRow: true })).toBe(true);
    expect(executionHasContent({ ...exe, hasMonitor: true })).toBe(true);
    expect(executionHasContent({ ...exe, policyAvailable: false })).toBe(true);
  });

  it("Workspace", () => {
    expect(workspaceHasContent(ws)).toBe(false);
    expect(workspaceHasContent({ ...ws, hasWorkspaceOverride: true })).toBe(true);
    expect(workspaceHasContent({ ...ws, executionWorkspaceId: "w" })).toBe(true);
    expect(workspaceHasContent({ ...ws, branchName: "b" })).toBe(true);
    expect(workspaceHasContent({ ...ws, cwd: "/x" })).toBe(true);
    expect(workspaceHasContent({ ...ws, hasRuntimeControls: true })).toBe(true);
  });
});

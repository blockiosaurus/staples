import { useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

const STORAGE_PREFIX = "staples:issue-props-expanded:";

export function moreFieldsStorageKey(companyId: string) {
  return `${STORAGE_PREFIX}${companyId}`;
}

function readExpanded(companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  try {
    return window.localStorage.getItem(moreFieldsStorageKey(companyId)) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(companyId: string | null | undefined, expanded: boolean) {
  if (!companyId) return;
  try {
    window.localStorage.setItem(moreFieldsStorageKey(companyId), expanded ? "1" : "0");
  } catch {
    // Storage can be unavailable or blocked; the choice just won't persist.
  }
}

/** Per-person, per-company "More fields" expanded state. Defaults to collapsed. */
export function useMoreFieldsExpanded(companyId: string | null | undefined) {
  const [state, setState] = useState(() => ({ companyId, expanded: readExpanded(companyId) }));
  // Re-sync when the company changes.
  const expanded = state.companyId === companyId ? state.expanded : readExpanded(companyId);
  const toggle = useCallback(() => {
    const next = !expanded;
    writeExpanded(companyId, next);
    setState({ companyId, expanded: next });
  }, [companyId, expanded]);
  return [expanded, toggle] as const;
}

/**
 * A section stays visible when it holds a non-default value or the person
 * expanded "More fields". Once a value is set it counts as content, so the
 * section survives collapsing.
 */
export function isSectionHidden(hasContent: boolean, expanded: boolean) {
  return !hasContent && !expanded;
}

export function relationshipsHaveContent(input: {
  parentId?: string | null;
  blockedByCount: number;
  blockingCount: number;
  childCount: number;
  relatedTaskCount: number;
  pullRequestCount: number;
  workProductsError?: boolean;
  externalObjectCount: number;
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
}): boolean {
  return Boolean(
    input.parentId || input.blockedByCount > 0 || input.blockingCount > 0 || input.childCount > 0
      || input.relatedTaskCount > 0 || input.pullRequestCount > 0 || input.workProductsError
      || input.externalObjectCount > 0 || input.externalObjectsLoading || input.externalObjectsError,
  );
}

export function executionHasContent(input: {
  policyAvailable: boolean;
  hasReviewPolicyBadge: boolean;
  reviewerCount: number;
  approverCount: number;
  hasMonitor: boolean;
  hasWatchdog: boolean;
  currentExecutionLabel?: string | null;
  showScheduledRetryRow?: boolean;
}): boolean {
  return Boolean(
    !input.policyAvailable || input.hasReviewPolicyBadge || input.reviewerCount > 0 || input.approverCount > 0
      || input.hasMonitor || input.hasWatchdog || input.currentExecutionLabel || input.showScheduledRetryRow,
  );
}

export function workspaceHasContent(input: {
  hasWorkspaceOverride: boolean;
  executionWorkspaceId?: string | null;
  branchName?: string | null;
  cwd?: string | null;
  hasRuntimeControls: boolean;
}): boolean {
  return Boolean(
    input.hasWorkspaceOverride || input.executionWorkspaceId || input.branchName || input.cwd
      || input.hasRuntimeControls,
  );
}

export function MoreFieldsToggle({
  expanded,
  onToggle,
  controls,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** Space-separated ids of the regions this button shows or hides. */
  controls: string;
}) {
  return (
    <button
      type="button"
      className="mt-3 flex w-full items-center gap-1.5 rounded py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      data-testid="issue-props-more-fields"
    >
      <ChevronRight
        className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
        aria-hidden
      />
      {expanded ? "Fewer fields" : "More fields"}
    </button>
  );
}

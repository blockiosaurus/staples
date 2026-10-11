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
  const [expanded, setExpanded] = useState(() => readExpanded(companyId));
  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      writeExpanded(companyId, next);
      return next;
    });
  }, [companyId]);
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
      More fields
    </button>
  );
}

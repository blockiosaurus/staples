import { useEffect, useId, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useSidebar } from "../../context/SidebarContext";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../../lib/utils";
import { useSurfaces } from "./useSurfaces";

const ROW = "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-(length:--text-compact) font-medium text-foreground/80";
const ACTION = "shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

type SurfaceAction = "hide" | "unhide" | "pin" | "unpin";
const counterpart: Record<SurfaceAction, SurfaceAction> = { hide: "unhide", unhide: "hide", pin: "unpin", unpin: "pin" };
const actionSelector = (action: SurfaceAction, id: string) => `[data-surface-action="${action}:${id}"]`;

/** Sidebar "More" row: reach hidden surfaces, hide/unhide, and "Show everything". */
export function SidebarMoreMenu() {
  const { states, visible, hiddenAvailable, preferences, preferencesFailed, ready, update } = useSurfaces();
  const { collapsed, peeking } = useSidebar();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rail = collapsed && !peeking;
  const contentRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // After Hide/Unhide/Pin/Unpin the clicked row moves lists; keep keyboard focus on the
  // same surface's counterpart control (or the menu itself) instead of losing it.
  const [pendingFocus, setPendingFocus] = useState<{ id: string; from: SurfaceAction } | null>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    const content = contentRef.current;
    if (!content) {
      setPendingFocus(null);
      return;
    }
    const target = content.querySelector<HTMLElement>(actionSelector(counterpart[pendingFocus.from], pendingFocus.id));
    if (target) {
      target.focus();
      setPendingFocus(null);
      return;
    }
    // The optimistic update has not rendered yet: wait for the next render.
    if (content.querySelector(actionSelector(pendingFocus.from, pendingFocus.id))) return;
    content.focus();
    setPendingFocus(null);
  }, [pendingFocus, states]);

  const applyAction = (action: SurfaceAction, id: string) => {
    if (preferencesFailed) return;
    update(
      action === "hide" ? { hide: [id] }
        : action === "unhide" ? { unhide: [id] }
        : action === "pin" ? { pin: [id] }
        : { unpin: [id] },
    );
    setPendingFocus({ id, from: action });
  };

  if (!ready) return null;

  const openable = hiddenAvailable.filter((state) => state.source !== "hidden");
  const personHidden = states.filter((state) => state.available && state.source === "hidden");
  const removable = visible.filter((state) => state.surface.tier !== "core");

  if (
    openable.length === 0 &&
    personHidden.length === 0 &&
    removable.length === 0 &&
    !preferences.showEverything
  ) {
    return null;
  }

  const trigger = (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={rail ? "More" : undefined}
      className="flex w-[calc(100%-1rem)] items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Ellipsis className="h-4 w-4 shrink-0" />
      <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>More</span>
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {rail ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">More</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent side="right" align="end" className="w-64 p-2">
        <div ref={contentRef} tabIndex={-1} data-more-menu-content="" className="outline-none">
          {openable.length > 0 ? (
            <section aria-labelledby={`${headingId}-open`} className="mb-1">
              <h3 id={`${headingId}-open`} className="px-2 py-1 text-xs font-medium text-muted-foreground">Open</h3>
              {openable.map(({ surface }) => (
                <div key={surface.id} className="flex w-full items-center">
                  <button
                    type="button"
                    className={cn(ROW, "min-w-0 flex-1 text-left transition-colors hover:bg-accent")}
                    onClick={() => {
                      navigate(surface.to);
                      setOpen(false);
                    }}
                  >
                    <surface.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{surface.label}</span>
                  </button>
                  <button
                    type="button"
                    className={ACTION}
                    aria-label={`Pin ${surface.label}`}
                    data-surface-action={`pin:${surface.id}`}
                    disabled={preferencesFailed}
                    onClick={() => applyAction("pin", surface.id)}
                  >
                    Pin
                  </button>
                </div>
              ))}
            </section>
          ) : null}
          {removable.length > 0 || personHidden.length > 0 ? (
            <section aria-labelledby={`${headingId}-sidebar`} className="mb-1">
              <h3 id={`${headingId}-sidebar`} className="px-2 py-1 text-xs font-medium text-muted-foreground">In your sidebar</h3>
              {removable.map(({ surface, source }) => {
                const action = source === "pinned" ? "unpin" : "hide";
                const label = source === "pinned" ? "Unpin" : "Hide";
                return (
                  <div key={surface.id} className={ROW}>
                    <surface.icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{surface.label}</span>
                    <button
                      type="button"
                      className={ACTION}
                      aria-label={`${label} ${surface.label}`}
                      data-surface-action={`${action}:${surface.id}`}
                      disabled={preferencesFailed}
                      onClick={() => applyAction(action, surface.id)}
                    >
                      {label}
                    </button>
                  </div>
                );
              })}
              {personHidden.map(({ surface }) => (
                <div key={surface.id} className={cn(ROW, "text-muted-foreground")}>
                  <surface.icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{surface.label}</span>
                  <button
                    type="button"
                    className={ACTION}
                    aria-label={`Unhide ${surface.label}`}
                    data-surface-action={`unhide:${surface.id}`}
                    disabled={preferencesFailed}
                    onClick={() => applyAction("unhide", surface.id)}
                  >
                    Unhide
                  </button>
                </div>
              ))}
            </section>
          ) : null}
          <div className={cn(ROW, "border-t border-border pt-2")}>
            <span className="flex-1">Show everything</span>
            <ToggleSwitch
              aria-label="Show everything"
              checked={preferences.showEverything}
              disabled={preferencesFailed}
              onCheckedChange={(value) => update({ showEverything: value })}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

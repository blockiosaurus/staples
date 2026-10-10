import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Maximize2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidePanelFrame } from "@/components/side-panel";
import { IsolatedBreadcrumbProvider } from "@/context/BreadcrumbContext";
import { IsolatedPanelProvider } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AssistantConversation } from "./AssistantConversation";
import { useAssistantShell } from "./AssistantProvider";
import { pageContextLabel } from "./pageContext";

export const ASSISTANT_DOCK_WIDTH = 400;

function SeeingChip() {
  const shell = useAssistantShell();
  if (!shell?.pageContext) return null;
  if (shell.contextDropped) {
    return (
      <span className="min-w-0 truncate rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
        Not sharing this page
      </span>
    );
  }
  const label = pageContextLabel(shell.pageContext);
  return (
    <span
      data-testid="assistant-seeing-chip"
      className="inline-flex min-w-0 items-center gap-0.5 rounded-full border border-border bg-muted py-0.5 pl-2 pr-0.5 text-xs text-muted-foreground"
      title={`The Assistant sees: ${label}`}
    >
      <span className="min-w-0 truncate">Seeing: {label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-4 shrink-0 rounded-full"
        aria-label="Don't share this page with the next message"
        onClick={shell.dropContext}
      >
        <X className="size-3" />
      </Button>
    </span>
  );
}

/** Below this width the in-flow 400px dock would crush the page; overlay instead. */
export const ASSISTANT_DOCK_OVERLAY_BELOW = 1280;

function useViewportBelow(width: number) {
  const [below, setBelow] = useState(() => typeof window !== "undefined" && window.innerWidth < width);
  useEffect(() => {
    const update = () => setBelow(window.innerWidth < width);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [width]);
  return below;
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "textarea:not([disabled])", "input:not([disabled])",
  "select:not([disabled])", "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])",
].join(",");

const COMPOSER_SELECTOR = '[data-testid="task-chat-composer-dock"]:not([inert]) [contenteditable="true"], [data-testid="task-chat-composer-dock"]:not([inert]) textarea';

function focusableWithin(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[inert]"));
}

/**
 * The Cmd/Ctrl+J Assistant dock. Wide desktops: its own host in the flex row
 * beside the properties panel. Narrow desktops (< 1280px): an overlay on the
 * right. Mobile: a full-screen modal sheet. The conversation is rendered
 * embedded, with panel and breadcrumb writes isolated from the host page.
 */
export function AssistantDock() {
  const shell = useAssistantShell();
  if (!shell || !shell.dockOpen || shell.onAssistantPage) return null;
  return <AssistantDockPanel />;
}

function AssistantDockPanel() {
  const shell = useAssistantShell()!;
  const { isMobile } = useSidebar();
  const overlay = useViewportBelow(ASSISTANT_DOCK_OVERLAY_BELOW);
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { setDockOpen, dockFocusRequest } = shell;

  // Return focus to wherever the person was when the dock closes.
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    return () => {
      const active = document.activeElement;
      const focusWasInDock = !active || active === document.body || (root?.contains(active) ?? false);
      if (focusWasInDock && previous?.isConnected && !root?.contains(previous)) previous.focus();
    };
  }, []);

  // Opening the dock (shortcut or toggle) moves focus into it. The surface
  // focuses its composer; if that isn't ready yet, hold focus on the dock so
  // Escape and Tab work from the start. A dock restored on page load doesn't
  // take focus.
  useEffect(() => {
    if (dockFocusRequest <= 0) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (root && !root.contains(document.activeElement)) root.focus();
    });
    // The composer stays inert until the thread's history is revealed, so the
    // surface's own focus request can land too early; finish the job once it
    // is interactive, unless the person has already moved focus elsewhere.
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const root = rootRef.current;
      const active = document.activeElement;
      const holdingDock = !!root && (active === root || active === document.body || active === null);
      const composer = root?.querySelector<HTMLElement>(COMPOSER_SELECTOR);
      if (holdingDock && composer) composer.focus();
      if (!holdingDock || composer || attempts >= 30) window.clearInterval(timer);
    }, 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [dockFocusRequest]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    // Portaled popovers bubble through React; only handle keys from the dock's own DOM.
    if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      setDockOpen(false);
      return;
    }
    if (isMobile && event.key === "Tab") {
      const focusable = focusableWithin(root);
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
      <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-sm font-medium">Assistant</span>
      <SeeingChip />
    </div>
  );
  const controls = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Open the Assistant full page"
        title="Open full page"
        onClick={() => {
          setDockOpen(false);
          navigate("/assistant");
        }}
      >
        <Maximize2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close the Assistant"
        title="Close (Esc or ⌘J)"
        onClick={() => setDockOpen(false)}
      >
        <X />
      </Button>
    </>
  );

  const mode = isMobile ? "sheet" : overlay ? "overlay" : "docked";
  const frame = (
    <SidePanelFrame
      label="Assistant"
      presentation={isMobile ? "sheet" : "docked"}
      contentMode="full-bleed"
      header={header}
      trailingControls={controls}
      className={cn(mode === "docked" && "shrink-0", mode === "overlay" && "h-full w-full")}
      bodyClassName="flex flex-col"
      style={mode === "docked" ? { width: ASSISTANT_DOCK_WIDTH } : undefined}
    >
      <div data-assistant-dock-body="" className="flex min-h-0 flex-1 flex-col px-3">
        <IsolatedPanelProvider>
          <IsolatedBreadcrumbProvider>
            <AssistantConversation embedded />
          </IsolatedBreadcrumbProvider>
        </IsolatedPanelProvider>
      </div>
    </SidePanelFrame>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="assistant-dock"
      data-assistant-dock=""
      data-dock-mode={mode}
      onKeyDown={onKeyDown}
      {...(isMobile ? { role: "dialog", "aria-modal": true, "aria-label": "Assistant" } : {})}
      className={cn(
        "outline-none",
        mode === "sheet" && "fixed inset-0 z-40 bg-background",
        mode === "overlay" && "fixed inset-y-0 right-0 z-40 max-w-full bg-background shadow-lg",
        mode === "docked" && "flex h-full min-h-0",
      )}
      style={mode === "overlay" ? { width: ASSISTANT_DOCK_WIDTH } : undefined}
    >
      {frame}
    </div>
  );
}

/** Header button that toggles the dock; hidden until the Assistant is available. */
export function AssistantDockToggle() {
  const shell = useAssistantShell();
  if (!shell?.available || shell.onAssistantPage) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={shell.dockOpen ? "Close the Assistant" : "Open the Assistant"}
      aria-pressed={shell.dockOpen}
      title="Assistant (⌘J)"
      onClick={shell.toggleDock}
      className={cn("text-muted-foreground", shell.dockOpen && "bg-accent text-accent-foreground")}
    >
      <Sparkles className="h-4 w-4" />
    </Button>
  );
}

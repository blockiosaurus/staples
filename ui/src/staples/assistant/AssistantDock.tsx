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

/**
 * The Cmd/Ctrl+J Assistant dock: its own host beside the properties panel
 * (desktop) or a full-screen sheet (mobile). The conversation is rendered
 * embedded, with panel and breadcrumb writes isolated from the host page.
 */
export function AssistantDock() {
  const shell = useAssistantShell();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  if (!shell || !shell.dockOpen || shell.onAssistantPage) return null;

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
          shell.setDockOpen(false);
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
        title="Close (⌘J)"
        onClick={() => shell.setDockOpen(false)}
      >
        <X />
      </Button>
    </>
  );

  const frame = (
    <SidePanelFrame
      label="Assistant"
      presentation={isMobile ? "sheet" : "docked"}
      contentMode="full-bleed"
      header={header}
      trailingControls={controls}
      className={cn(!isMobile && "shrink-0")}
      bodyClassName={cn("flex flex-col", isMobile && "overflow-y-auto")}
      style={isMobile ? undefined : { width: ASSISTANT_DOCK_WIDTH }}
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

  if (isMobile) {
    return <div data-testid="assistant-dock" className="fixed inset-0 z-40 bg-background">{frame}</div>;
  }
  return <div data-testid="assistant-dock" className="flex h-full min-h-0">{frame}</div>;
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

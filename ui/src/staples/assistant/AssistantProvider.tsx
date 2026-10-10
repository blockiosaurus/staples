import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssistantPageContext } from "@paperclipai/shared";
import { buildDocumentTitle, useOptionalBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useLocation } from "@/lib/router";
import { currentPageContext } from "./pageContext";
import { useAssistant } from "./useAssistant";

export const ASSISTANT_DOCK_OPEN_STORAGE_KEY = "staples:assistant-dock-open";

export interface AssistantCommentMetadata {
  pageContext?: AssistantPageContext;
}

export interface AssistantShellValue {
  /** GET /assistant succeeded; chrome (toggle button) only shows when true. */
  available: boolean;
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;
  /** What the person is looking at now (null on the Assistant page). */
  pageContext: AssistantPageContext | null;
  /** The person dropped the current page's context for their next message. */
  contextDropped: boolean;
  dropContext: () => void;
  /**
   * Metadata for the message being sent right now. Consumes a pending
   * "drop context": the message after it carries context again.
   */
  takeCommentMetadata: () => AssistantCommentMetadata | undefined;
  /** The current route is the full-page Assistant. */
  onAssistantPage: boolean;
}

const AssistantShellContext = createContext<AssistantShellValue | null>(null);

function readDockOpen(): boolean {
  try {
    return localStorage.getItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDockOpen(open: boolean) {
  try {
    localStorage.setItem(ASSISTANT_DOCK_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { available } = useAssistant({ withConversation: false });
  const { selectedCompany } = useCompany();
  const location = useLocation();
  const breadcrumbs = useOptionalBreadcrumbs()?.breadcrumbs;
  const [dockOpen, setDockOpenState] = useState(readDockOpen);
  const [droppedRoute, setDroppedRoute] = useState<string | null>(null);
  const label = breadcrumbs && breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1]!.label : null;
  // The same string BreadcrumbProvider writes to document.title (it does so in
  // an effect that runs after ours, so document.title itself would lag).
  const title = breadcrumbs ? buildDocumentTitle(breadcrumbs, selectedCompany?.name) : document.title;

  const pageContext = useMemo(
    () => currentPageContext({
      pathname: location.pathname,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
      title,
      label,
    }),
    [location.pathname, selectedCompany?.issuePrefix, title, label],
  );
  const onAssistantPage = pageContext === null && /\/assistant\/?$/i.test(location.pathname);
  const contextDropped = pageContext !== null && droppedRoute === pageContext.route;

  const latest = useRef({ pageContext, contextDropped });
  latest.current = { pageContext, contextDropped };

  const setDockOpen = useCallback((open: boolean) => {
    setDockOpenState(open);
    writeDockOpen(open);
  }, []);
  const toggleDock = useCallback(() => {
    setDockOpenState((current) => {
      writeDockOpen(!current);
      return !current;
    });
  }, []);
  const dropContext = useCallback(() => {
    if (latest.current.pageContext) setDroppedRoute(latest.current.pageContext.route);
  }, []);
  const takeCommentMetadata = useCallback((): AssistantCommentMetadata | undefined => {
    const { pageContext: context, contextDropped: dropped } = latest.current;
    if (dropped) {
      setDroppedRoute(null);
      return undefined;
    }
    return context ? { pageContext: context } : undefined;
  }, []);

  const value = useMemo<AssistantShellValue>(() => ({
    available,
    dockOpen,
    setDockOpen,
    toggleDock,
    pageContext,
    contextDropped,
    dropContext,
    takeCommentMetadata,
    onAssistantPage,
  }), [available, dockOpen, setDockOpen, toggleDock, pageContext, contextDropped, dropContext, takeCommentMetadata, onAssistantPage]);

  return <AssistantShellContext.Provider value={value}>{children}</AssistantShellContext.Provider>;
}

/** Null outside the app shell (e.g. isolated tests or public pages). */
export function useAssistantShell(): AssistantShellValue | null {
  return useContext(AssistantShellContext);
}

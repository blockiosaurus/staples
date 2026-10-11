import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

export interface AskAssistantInput {
  text: string;
  /** Send immediately, exactly as if the person pressed Send in the composer. */
  send?: boolean;
  /** What the message is about; appended as a plain `About: <label> (<href>)` line. */
  context?: { label: string; href: string };
}

/** A message waiting for the Assistant composer to pick it up (consumed once, by nonce). */
export interface PendingAssistantAsk {
  text: string;
  send: boolean;
  nonce: number;
}

/** The message `askAssistant` hands the composer: text plus a plain-text context line. */
export function composeAskText({ text, context }: Pick<AskAssistantInput, "text" | "context">): string {
  if (!context) return text;
  const label = context.label.replace(/\s+/g, " ").trim();
  const line = `About: ${label} (${context.href.trim()})`;
  return text ? `${text}\n\n${line}` : line;
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
  /** Metadata for the message being sent right now (none while dropped). */
  commentMetadata: () => AssistantCommentMetadata | undefined;
  /**
   * A message was sent successfully: a pending "drop context" is used up, so
   * the next message carries context again. A failed send keeps it dropped.
   */
  commentSent: () => void;
  /**
   * The current route already shows the Assistant conversation (the full
   * page, or its agent chat/issue route), so the dock stays hidden.
   */
  onAssistantPage: boolean;
  /** Increments each time the dock opens; the dock focuses its composer. */
  dockFocusRequest: number;
  /**
   * A page-level conversation surface reports the agent it shows. Returns a
   * release function for unmount.
   */
  claimConversationPage: (agentId: string) => () => void;
  /** The Assistant agent id, once known (matches a conversation surface to the Assistant). */
  assistantAgentId: string | null;
  /**
   * Open the Assistant with `text` in the composer (or send it). Uses the
   * conversation already on screen when there is one, else the dock.
   */
  askAssistant: (input: AskAssistantInput) => void;
  /** Undelivered ask for the current company; the composer applies it once. */
  pendingAsk: PendingAssistantAsk | null;
  /** The composer took the ask with this nonce; stop offering it. */
  consumeAsk: (nonce: number) => void;
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
  const { available, summary } = useAssistant({ withConversation: false });
  const assistantAgentId = summary?.agent.id ?? null;
  const [pageConversationAgentId, setPageConversationAgentId] = useState<string | null>(null);
  const [dockFocusRequest, setDockFocusRequest] = useState(0);
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
  const onAssistantPage = (pageContext === null && /\/assistant\/?$/i.test(location.pathname))
    || (assistantAgentId !== null && pageConversationAgentId === assistantAgentId);
  const contextDropped = pageContext !== null && droppedRoute === pageContext.route;

  const latest = useRef({ pageContext, contextDropped });
  latest.current = { pageContext, contextDropped };

  const dockOpenRef = useRef(dockOpen);
  dockOpenRef.current = dockOpen;
  const setDockOpen = useCallback((open: boolean) => {
    if (open && !dockOpenRef.current) setDockFocusRequest((current) => current + 1);
    dockOpenRef.current = open;
    setDockOpenState(open);
    writeDockOpen(open);
  }, []);
  const toggleDock = useCallback(() => {
    setDockOpen(!dockOpenRef.current);
  }, [setDockOpen]);
  const claimConversationPage = useCallback((agentId: string) => {
    setPageConversationAgentId(agentId);
    return () => setPageConversationAgentId((current) => (current === agentId ? null : current));
  }, []);
  const dropContext = useCallback(() => {
    if (latest.current.pageContext) setDroppedRoute(latest.current.pageContext.route);
  }, []);
  const commentMetadata = useCallback((): AssistantCommentMetadata | undefined => {
    const { pageContext: context, contextDropped: dropped } = latest.current;
    if (dropped || !context) return undefined;
    return { pageContext: context };
  }, []);
  const commentSent = useCallback(() => {
    setDroppedRoute(null);
  }, []);

  const companyId = selectedCompany?.id ?? null;
  const [askState, setAskState] = useState<(PendingAssistantAsk & { companyId: string }) | null>(null);
  const askNonce = useRef(0);
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;
  // A pending ask belongs to the company it was made in.
  useEffect(() => {
    setAskState((current) => (current && current.companyId !== companyId ? null : current));
  }, [companyId]);
  // An ask nobody took (dock closed, or the person navigated away) must not
  // fire later on an unrelated open.
  useEffect(() => {
    if (!dockOpen && !onAssistantPage) setAskState(null);
  }, [dockOpen, onAssistantPage]);
  useEffect(() => {
    setAskState(null);
  }, [location.pathname]);
  const pendingAsk = useMemo<PendingAssistantAsk | null>(
    () => (askState && askState.companyId === companyId
      ? { text: askState.text, send: askState.send, nonce: askState.nonce }
      : null),
    [askState, companyId],
  );
  const onAssistantPageRef = useRef(onAssistantPage);
  onAssistantPageRef.current = onAssistantPage;
  const askAssistant = useCallback((input: AskAssistantInput) => {
    const currentCompanyId = companyIdRef.current;
    if (!currentCompanyId) return;
    askNonce.current += 1;
    setAskState({
      text: composeAskText(input),
      send: input.send === true,
      nonce: askNonce.current,
      companyId: currentCompanyId,
    });
    if (!onAssistantPageRef.current) setDockOpen(true);
  }, [setDockOpen]);
  const consumeAsk = useCallback((nonce: number) => {
    setAskState((current) => (current && current.nonce === nonce ? null : current));
  }, []);

  const value = useMemo<AssistantShellValue>(() => ({
    available,
    dockOpen,
    setDockOpen,
    toggleDock,
    pageContext,
    contextDropped,
    dropContext,
    commentMetadata,
    commentSent,
    onAssistantPage,
    dockFocusRequest,
    claimConversationPage,
    assistantAgentId,
    askAssistant,
    pendingAsk,
    consumeAsk,
  }), [
    available, dockOpen, setDockOpen, toggleDock, pageContext, contextDropped, dropContext,
    commentMetadata, commentSent, onAssistantPage, dockFocusRequest, claimConversationPage,
    assistantAgentId, askAssistant, pendingAsk, consumeAsk,
  ]);

  return <AssistantShellContext.Provider value={value}>{children}</AssistantShellContext.Provider>;
}

/** Null outside the app shell (e.g. isolated tests or public pages). */
export function useAssistantShell(): AssistantShellValue | null {
  return useContext(AssistantShellContext);
}

/**
 * Open the Assistant from any page with a pre-filled (or auto-sent) message.
 * A no-op outside the app shell.
 */
export function useAskAssistant(): AssistantShellValue["askAssistant"] {
  const shell = useAssistantShell();
  const askAssistant = shell?.askAssistant;
  return useCallback((input: AskAssistantInput) => askAssistant?.(input), [askAssistant]);
}

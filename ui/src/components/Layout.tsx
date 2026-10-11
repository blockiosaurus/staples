import { SetupWizardSidebarOutlet } from "./SetupWizard";
import { ChatSetupSidebarProvider } from "@/context/ChatSetupSidebarContext";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { Sidebar } from "./Sidebar";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";
import { CompanySettingsNav } from "./access/CompanySettingsNav";
import { AppsSidebar } from "./AppsSidebar";
import { AppDetailSidebar } from "./AppConnectionSidebar";
import { AgentContextualSidebar } from "./AgentContextualSidebar";
import { RoutineContextualSidebar } from "./RoutineContextualSidebar";
import { SkillsContextualSidebar } from "./SkillsContextualSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { ToastViewport } from "./ToastViewport";
import { AnnouncementWell } from "./AnnouncementWell";
import { PluginAppShellOverlays } from "./PluginAppShellOverlays";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";
import { SurfaceTracker } from "../staples/surfaces/SurfaceTracker";
import { AssistantProvider, useAssistantShell } from "../staples/assistant/AssistantProvider";
import { AssistantDock } from "../staples/assistant/AssistantDock";
import { StageZeroShell } from "../staples/assistant/StageZeroShell";
import { useCompanySignals } from "../hooks/useCompanySignals";
import { SidebarShell } from "./SidebarShell";
import { SecondarySidebar } from "./SecondarySidebar";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { useDialogActions } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { useMobileNavVisibility } from "../hooks/useMobileNavVisibility";
import { healthApi } from "../api/health";
import { resolveArchivedCompanyBounce, shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import { useOptionalToastActions } from "../context/ToastContext";
import {
  applyMainContentScrollTop,
  NavigationScrollMemory,
  resetNavigationScroll,
  shouldResetScrollOnNavigation,
} from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { scheduleMainContentFocus } from "../lib/main-content-focus";
import { pinDocumentScrollToZero } from "../lib/pin-document-scroll";
import {
  classifyShellRoute,
  getCompanyPathSegments,
  rememberContextualSidebarOrigin,
  type ContextualSidebarSurface,
} from "../lib/shell-navigation";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { UnprefixedBoardRedirect } from "./UnprefixedBoardRedirect";
import { isBoardPathWithoutPrefix } from "@/lib/company-routes";
import { PluginSlotMount, resolveRouteSidebarSlot, usePluginSlots } from "../plugins/slots";

function getCompanyRouteSegment(pathname: string, companyPrefix: string | undefined): string | null {
  return getCompanyPathSegments(pathname, companyPrefix)[0]?.toLowerCase() ?? null;
}

const RESERVED_APP_SUBPATHS = new Set([
  "browse",
  "connections",
  "assistant-connection",
  "connect",
  "chat",
  "vercel-connect",
  "review",
  "attention",
  "gateways",
  "advanced",
  "app",
]);

/**
 * Company route roots that render in the normal shell even in stage 0:
 * settings, brief and organization (`company`, `companies`), profiles (`u`),
 * and the pages the Assistant sends people to.
 */
const STAGE_ZERO_EXEMPT_ROOTS = new Set(["company", "companies", "u", "agents", "apps", "issues", "approvals"]);

export function Layout({ sidebarSections }: { sidebarSections?: ReactNode }) {
  return (
    <AssistantProvider>
      <LayoutShell sidebarSections={sidebarSections} />
    </AssistantProvider>
  );
}

function LayoutShell({ sidebarSections }: { sidebarSections?: ReactNode }) {
  const {
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    collapsed,
    peeking,
    setPeeking,
    isMobile,
  } = useSidebar();
  const { openNewIssue } = useDialogActions();
  const { togglePanelVisible } = usePanel();
  // Optional: Layout also renders in harnesses without a ToastProvider.
  const pushToast = useOptionalToastActions()?.pushToast ?? null;
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();
  const {
    companyPrefix,
    pluginRoutePath: matchedPluginRoutePath,
    agentId,
    routineId,
  } = useParams<{
    companyPrefix: string;
    pluginRoutePath?: string;
    agentId?: string;
    routineId?: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const shellRoute = classifyShellRoute(location.pathname, companyPrefix);
  const isCompanySettingsRoute = shellRoute.builtInContextualSurface === "settings";
  const companyPathSegments = shellRoute.companySegments;
  const isTaskDetailRoute = shellRoute.isTaskDetail;
  const isAgentChatRoute = companyPathSegments[0]?.toLowerCase() === "chats";
  const isAssistantRoute = companyPathSegments[0]?.toLowerCase() === "assistant";
  // Chat keeps its header beside the agent sidebar, including before an agent is selected.
  // The full-page Assistant is the same conversation surface, so it gets the same shell.
  const useStreamlinedTaskDetailShell = isTaskDetailRoute || isAgentChatRoute || isAssistantRoute;
  const isToolsRoute = companyPathSegments[0]?.toLowerCase() === "tools";
  const isAppsRoute = companyPathSegments[0]?.toLowerCase() === "apps";
  const appDetailConnectionId =
    isAppsRoute && companyPathSegments[1] && !RESERVED_APP_SUBPATHS.has(companyPathSegments[1].toLowerCase())
      ? companyPathSegments[1]
      : null;
  const appDetailApplicationId =
    isAppsRoute && companyPathSegments[1]?.toLowerCase() === "app" && companyPathSegments[2]
      ? companyPathSegments[2]
      : null;
  const startTriggered = useRef(false);
  const previousPathname = useRef<string | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const scrollMemory = useRef(new NavigationScrollMemory());
  const activeScrollKey = useRef<string>(location.key);
  const mobileNavVisible = useMobileNavVisibility(isMobile, location.pathname);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;
  const pluginRoutePath = useMemo(
    () => matchedPluginRoutePath?.toLowerCase() ?? getCompanyRouteSegment(location.pathname, companyPrefix),
    [companyPrefix, location.pathname, matchedPluginRoutePath],
  );
  const routeSidebarCompanyId = matchedCompany?.id ?? null;
  const routeSidebarCompanyPrefix = matchedCompany?.issuePrefix ?? null;
  const { slots: routeSidebarSlots } = usePluginSlots({
    slotTypes: ["page", "routeSidebar"],
    companyId: routeSidebarCompanyId,
    enabled: Boolean(routeSidebarCompanyId && pluginRoutePath),
  });
  const routeSidebarSlot = useMemo(
    () => resolveRouteSidebarSlot(routeSidebarSlots, pluginRoutePath),
    [pluginRoutePath, routeSidebarSlots],
  );
  const sidebarContext = useMemo(
    () => ({
      companyId: routeSidebarCompanyId,
      companyPrefix: routeSidebarCompanyPrefix,
    }),
    [routeSidebarCompanyId, routeSidebarCompanyPrefix],
  );
  // Most contextual routes replace the global navigation inside the same
  // sidebar shell. Skills, Apps, Agent details, and Routine details are the
  // exceptions: their local navigation is a second rail
  // beside the persistent company nav.
  const sharedSecondarySidebar = isCompanySettingsRoute ? (
    <CompanySettingsSidebar />
  ) : appDetailConnectionId ? (
    <AppDetailSidebar kind="connection" connectionId={appDetailConnectionId} />
  ) : appDetailApplicationId ? (
    <AppDetailSidebar kind="application" applicationId={appDetailApplicationId} />
  ) : isAppsRoute || isToolsRoute ? (
    <AppsSidebar />
  ) : routeSidebarSlot ? (
    <ContextualSidebarFrame
      surface={`plugin:${routeSidebarSlot.id}`}
      title={routeSidebarSlot.displayName}
    >
      <PluginSlotMount
        slot={routeSidebarSlot}
        context={sidebarContext}
        className="min-h-0 flex-1"
        missingBehavior="placeholder"
      />
    </ContextualSidebarFrame>
  ) : null;
  const secondarySidebar = isAgentChatRoute ? <AgentConversationsSidebar /> : shellRoute.builtInContextualSurface === "agent" && agentId ? (
    <AgentContextualSidebar agentRef={agentId} />
  ) : shellRoute.builtInContextualSurface === "routine" && routineId ? (
    <SetupWizardSidebarOutlet><RoutineContextualSidebar routineId={routineId} /></SetupWizardSidebarOutlet>
  ) : shellRoute.builtInContextualSurface === "skills" ? (
    <SkillsContextualSidebar />
  ) : sharedSecondarySidebar;
  const hasSecondarySidebar = secondarySidebar != null;
  const keepsPrimarySidebar = hasSecondarySidebar && (
    isAgentChatRoute
    || shellRoute.builtInContextualSurface === "skills"
    || shellRoute.builtInContextualSurface === "agent"
    || shellRoute.builtInContextualSurface === "routine"
    || isAppsRoute
    || isToolsRoute
  );
  const replacesPrimarySidebar = hasSecondarySidebar && !keepsPrimarySidebar;
  const contextualSurface: ContextualSidebarSurface | null = !hasSecondarySidebar
    ? null
    : routeSidebarSlot && !shellRoute.builtInContextualSurface
      ? `plugin:${routeSidebarSlot.id}`
      : shellRoute.builtInContextualSurface;
  const previousShellRoute = useRef<{
    pathname: string;
    surface: ContextualSidebarSurface | null;
  } | null>(null);
  // Stage 0: no staff agents yet, so the Assistant is the whole app. Settings,
  // brief, organization and profile pages stay reachable in the normal shell,
  // as do the pages the Assistant links to (agents, connectors, tasks and
  // approvals), so its advice never points at a page that cannot open.
  // While signals load, show a neutral spinner rather than flashing the sidebar.
  const { signals, loaded: signalsLoaded, failed: signalsFailed } = useCompanySignals(selectedCompanyId);
  const stageZeroRoot = companyPathSegments[0]?.toLowerCase();
  const stageZeroExempt = !companyPrefix || hasUnknownCompanyPrefix
    || STAGE_ZERO_EXEMPT_ROOTS.has(stageZeroRoot ?? "");
  const decidedShell: "stage_zero" | "normal" | null = !selectedCompanyId || stageZeroExempt || signalsFailed
    ? "normal"
    : !signalsLoaded
      ? null
      : signals?.agents === 0 ? "stage_zero" : "normal";
  // While another company's signals load, keep whichever shell is showing; only
  // block (spinner) when nothing is known yet.
  const lastShell = useRef<"stage_zero" | "normal" | null>(null);
  if (decidedShell) lastShell.current = decidedShell;
  const shownShell = decidedShell ?? lastShell.current;
  const stageZeroShell: "pending" | "stage_zero" | null = stageZeroExempt
    ? null
    : shownShell === null ? "pending" : shownShell === "stage_zero" ? "stage_zero" : null;
  // Stage 0 -> stage 1 happens in place: when the first staff agent arrives
  // while the person is on the Assistant, they stay there (the plan card records
  // its outcome and the Assistant's follow-up shows) and the stage-1 sidebar,
  // with Home first, appears around it. The company index lands on Home.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { devServer?: { enabled?: boolean } } | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const previous = previousShellRoute.current;
    if (
      contextualSurface
      && companyPrefix
      && previous
      && previous.surface !== contextualSurface
      && previous.pathname !== location.pathname
    ) {
      rememberContextualSidebarOrigin({
        surface: contextualSurface,
        companyPrefix,
        previousPathname: previous.pathname,
      });
    }
    previousShellRoute.current = { pathname: location.pathname, surface: contextualSurface };
  }, [companyPrefix, contextualSurface, location.pathname]);

  useEffect(() => {
    if (companiesLoading || startTriggered.current) return;
    // Deployment mode and Cloud-managed state decide whether /start can work at
    // all; until health is in, "no company" could still be a managed stack.
    if (!health) return;
    if (health?.deploymentMode === "authenticated") return;
    // Cloud provisions the single company for a stack, and POST /companies is a
    // 403 floor there — sending the user to /start could only dead-end.
    if (health?.cloud) return;
    if (companies.length === 0) {
      startTriggered.current = true;
      navigate("/start", { replace: true });
    }
  }, [companies, companiesLoading, navigate, health]);

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;

    if (!matchedCompany) {
      const fallback = (selectedCompanyId ? companies.find((company) => company.id === selectedCompanyId) : null)
        ?? companies[0]
        ?? null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedCompany.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    // Stale state (remembered paths, history, bookmarks, restored tabs)
    // deposits users into archived companies long after archiving; a cold
    // arrival bounces to an active company instead of dwelling there.
    // Deliberate visits (the company is already the selection) stay put.
    const bounce = resolveArchivedCompanyBounce({
      matchedCompany,
      selectedCompanyId,
      companies,
    });
    if (bounce) {
      pushToast?.({
        title: `${matchedCompany.name} is archived`,
        body: `Switched to ${bounce.name}.`,
        tone: "info",
        dedupeKey: `archived-company-bounce:${matchedCompany.id}`,
      });
      setSelectedCompanyId(bounce.id, { source: "route_sync" });
      navigate(`/${bounce.issuePrefix}/home`, { replace: true });
      return;
    }

    if (
      shouldSyncCompanySelectionFromRoute({
        selectionSource,
        selectedCompanyId,
        routeCompanyId: matchedCompany.id,
      })
    ) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
    matchedCompany,
    location.pathname,
    location.search,
    navigate,
    pushToast,
    selectionSource,
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  const togglePanel = togglePanelVisible;
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  // Peek (hover flyout) triggers for the collapsed rail. Opening has a tiny
  // delay so a pointer merely sweeping across the rail doesn't flash it open;
  // closing is debounced to avoid flicker on the rail→overlay seam. Keyboard
  // focus opens immediately so tabbing reaches the full nav. Context gates the
  // effective `peeking` to desktop + collapsed + hover-capable pointers, so
  // these handlers are inert otherwise.
  const peekTimer = useRef<number | null>(null);
  // Whether the pointer is currently over the peek panel. Used to keep the peek
  // open across focus changes (e.g. navigation steals focus to <main>) as long as
  // the user is still hovering — it should only close when they actually mouse off
  // (PAP-10676).
  const pointerInsidePanel = useRef(false);
  // When the user explicitly collapses while the pointer is still over the panel,
  // suppress re-peeking until the pointer actually leaves — otherwise the lingering
  // hover immediately re-expands the rail and the collapse "doesn't take" until the
  // mouse moves away (PAP-10676). Re-armed on the next genuine pointer-leave.
  const suppressPeekRef = useRef(false);
  const clearPeekTimer = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);
  const openPeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(true), 50);
  }, [clearPeekTimer, setPeeking]);
  const openPeekImmediate = useCallback(() => {
    clearPeekTimer();
    setPeeking(true);
  }, [clearPeekTimer, setPeeking]);
  const closePeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(false), 120);
  }, [clearPeekTimer, setPeeking]);
  // Tracked even while expanded so that, at the moment of collapse, we know
  // whether the pointer is over the panel and should suppress the re-peek.
  const handlePanelPointerEnter = useCallback(() => {
    pointerInsidePanel.current = true;
    if (collapsed && !suppressPeekRef.current) openPeek();
  }, [collapsed, openPeek]);
  const handlePanelPointerLeave = useCallback(() => {
    pointerInsidePanel.current = false;
    suppressPeekRef.current = false; // pointer left — re-arm peek for the next hover
    closePeek();
  }, [closePeek]);
  const handlePanelFocus = useCallback(() => {
    if (suppressPeekRef.current) return;
    openPeekImmediate();
  }, [openPeekImmediate]);
  // Close on focus leaving the panel only when the pointer isn't hovering it.
  // Clicking a rail/peek nav item moves focus to <main> on navigation; if the
  // mouse is still over the flyout we keep it open until the pointer leaves.
  const handlePanelBlur = useCallback(() => {
    if (pointerInsidePanel.current) return;
    closePeek();
  }, [closePeek]);

  // Tidy up any pending peek timer on unmount.
  useEffect(() => clearPeekTimer, [clearPeekTimer]);

  // An explicit collapse must be atomic: cancel any in-flight/active peek, and if
  // the pointer is still over the panel suppress re-peeking until it leaves, so the
  // rail doesn't immediately re-expand under the lingering hover (PAP-10676).
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (collapsed !== wasCollapsed.current) {
      if (collapsed) {
        clearPeekTimer();
        setPeeking(false);
        suppressPeekRef.current = pointerInsidePanel.current;
      } else {
        suppressPeekRef.current = false;
      }
      wasCollapsed.current = collapsed;
    }
  }, [collapsed, clearPeekTimer, setPeeking]);

  // Intentionally do NOT close the peek on navigation: clicking a nav item means
  // the pointer is still over the flyout, so it should stay open until the user
  // actually mouses off (handled by onPanelMouseLeave) or blurs out / hits Escape
  // (PAP-10676). Auto-closing here made the sidebar collapse on every page change.

  // Escape closes an open peek without trapping the pointer.
  useEffect(() => {
    if (!peeking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearPeekTimer();
        setPeeking(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [peeking, clearPeekTimer, setPeeking]);

  useCompanyPageMemory();

  const assistantShell = useAssistantShell();
  useKeyboardShortcuts({
    onToggleAssistant: assistantShell?.toggleDock,
    onNewIssue: () => openNewIssue(),
    onSearch: openSearch,
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onShowShortcuts: () => setShortcutsOpen(true),
    onGoToInbox: () => navigate("/inbox"),
  });

  // Swipe gesture to open/close sidebar on mobile
  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30; // px from left edge to start open-swipe
    const MIN_DISTANCE = 50; // minimum horizontal swipe distance
    const MAX_VERTICAL = 75; // max vertical drift before we ignore

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);

      if (dy > MAX_VERTICAL) return; // vertical scroll, ignore

      // Swipe right from left edge → open
      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

      // Swipe left when open → close
      if (sidebarOpen && dx < -MIN_DISTANCE) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = isMobile ? "visible" : "clip";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  // `scrollIntoView` walks every ancestor scroll container. On a long thread
  // the post-submit `scrollIntoView` on the new comment reaches `<html>` and
  // animates `documentElement.scrollTop` via the browser's internal scroll
  // algorithm, which bypasses the CSS `overflow` on the root element and
  // visually shifts the entire shell (sidebar included) off-screen. Pin
  // both roots to scrollTop=0 on every scroll tick.
  useEffect(() => {
    if (isMobile) return;
    return pinDocumentScrollToZero();
  }, [isMobile]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mainContent = mainContentRef.current;
    return scheduleMainContentFocus(mainContent);
  }, [location.pathname]);

  // Continuously record the scroll offset of the active history entry so a
  // later back/forward navigation can restore it (see NavigationScrollMemory).
  useEffect(() => {
    const main = mainContentRef.current;
    if (!main) return;
    const recordScroll = () => {
      scrollMemory.current.remember(activeScrollKey.current, main.scrollTop);
    };
    main.addEventListener("scroll", recordScroll, { passive: true });
    return () => main.removeEventListener("scroll", recordScroll);
  }, []);

  useLayoutEffect(() => {
    const main = mainContentRef.current;
    const shouldResetScroll = shouldResetScrollOnNavigation({
      previousPathname: previousPathname.current,
      pathname: location.pathname,
      navigationType,
      state: location.state,
    });

    previousPathname.current = location.pathname;

    const isHistoryPop = navigationType === "POP";
    const restoredScrollTop = isHistoryPop ? scrollMemory.current.recall(location.key) : 0;
    activeScrollKey.current = location.key;

    if (isHistoryPop) {
      applyMainContentScrollTop(main, restoredScrollTop);
      // Cached page content can finish laying out a frame after commit; re-apply
      // once it has so the restored offset isn't clamped to a shorter interim height.
      const raf = requestAnimationFrame(() => applyMainContentScrollTop(main, restoredScrollTop));
      return () => cancelAnimationFrame(raf);
    }

    if (shouldResetScroll) {
      resetNavigationScroll(main);
    }
  }, [location.key, location.pathname, location.state, navigationType]);

  if (stageZeroShell === "pending") {
    return (
      <div
        data-testid="layout-signals-loading"
        role="status"
        aria-label="Loading"
        className="flex h-dvh items-center justify-center bg-background text-muted-foreground"
      >
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      </div>
    );
  }
  if (stageZeroShell === "stage_zero") {
    return (
      <ChatSetupSidebarProvider>
        <StageZeroShell deploymentMode={health?.deploymentMode} />
        <ToastViewport />
        <PluginAppShellOverlays localTrusted={health?.deploymentMode === "local_trusted"} />
      </ChatSetupSidebarProvider>
    );
  }

  return (
    <ChatSetupSidebarProvider>
      <SurfaceTracker />
      <div
      className={cn(
        "bg-background text-foreground pt-(--sz-safe-top)",
        // overflow-x-clip on mobile keeps a stray wide descendant from making the
        // whole viewport scroll horizontally. clip (not hidden) leaves overflow-y
        // computed as visible, so native body scroll + the sticky breadcrumb keep
        // working.
        isMobile ? "min-h-dvh overflow-x-clip" : "flex h-dvh flex-col overflow-clip",
      )}
      >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-(--z-200) focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      <WorktreeBanner />
      <DevRestartBanner devServer={health?.devServer} />
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-clip")}>
        {isMobile && sidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
        )}

        {isMobile ? (
          <div
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-(--sz-safe-top) transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <div className="w-60 shrink-0 overflow-hidden">
                {hasSecondarySidebar ? (
                  <SecondarySidebar>{secondarySidebar}</SecondarySidebar>
                ) : (
                  <Sidebar>{sidebarSections}</Sidebar>
                )}
              </div>
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              forceExpanded={replacesPrimarySidebar}
            />
          </div>
        ) : (
          <SidebarShell
            open={sidebarOpen}
            collapsed={replacesPrimarySidebar ? false : collapsed}
            peeking={replacesPrimarySidebar ? false : peeking}
            resizable
            onPanelMouseEnter={replacesPrimarySidebar ? undefined : handlePanelPointerEnter}
            onPanelMouseLeave={replacesPrimarySidebar ? undefined : handlePanelPointerLeave}
            onPanelFocusCapture={!replacesPrimarySidebar && collapsed ? handlePanelFocus : undefined}
            onPanelBlurCapture={!replacesPrimarySidebar && collapsed ? handlePanelBlur : undefined}
          >
            <div className="flex flex-1 min-h-0">
              {replacesPrimarySidebar ? (
                <SecondarySidebar>{secondarySidebar}</SecondarySidebar>
              ) : (
                <Sidebar>{sidebarSections}</Sidebar>
              )}
            </div>
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              forceExpanded={replacesPrimarySidebar}
            />
          </SidebarShell>
        )}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <div
            className={cn(
              !isMobile && useStreamlinedTaskDetailShell && "hidden",
              isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
            )}
          >
            <StandaloneBrowserControls mobile={isMobile} />
            <BreadcrumbBar />
            {isMobile && isCompanySettingsRoute ? (
              <div className="border-b border-border px-4 pb-3">
                <CompanySettingsNav />
              </div>
            ) : null}
          </div>
          <div className={cn(
            isMobile ? "block" : "flex flex-1 min-h-0",
            !isMobile && useStreamlinedTaskDetailShell && "streamlined-task-detail-surface",
          )}>
            {!isMobile && keepsPrimarySidebar ? (
              <SecondarySidebar className="w-60 shrink-0 bg-background">
                {secondarySidebar}
              </SecondarySidebar>
            ) : null}
            <div className={cn(!isMobile && useStreamlinedTaskDetailShell ? "flex min-w-0 flex-1 flex-col" : "contents")}>
              {!isMobile && useStreamlinedTaskDetailShell ? (
                <>
                  <StandaloneBrowserControls mobile={false} />
                  <BreadcrumbBar taskDetailLayout />
                </>
              ) : null}
              <main
              id="main-content"
              ref={mainContentRef}
              tabIndex={-1}
              // Publish the pinned-composer bottom offset to descendants
              // (PAP-495): while the auto-hiding mobile nav is on screen, raise
              // it to the nav height so a sticky composer clears the nav; drop
              // it back to the safe-area dock when the nav hides. Desktop leaves
              // the token at its :root default.
              style={
                isMobile
                  ? ({
                      "--tc-composer-bottom": mobileNavVisible
                        ? "var(--tc-composer-visible-nav-offset)"
                        : "var(--tc-composer-hidden-nav-offset)",
                      "--mobile-nav-motion-duration": mobileNavVisible
                        ? "var(--motion-mobile-nav-enter)"
                        : "var(--motion-mobile-nav-exit)",
                      "--mobile-nav-motion-ease": mobileNavVisible
                        ? "var(--motion-ease-out-expo)"
                        : "var(--motion-ease-standard)",
                    } as CSSProperties)
                  : undefined
              }
              className={cn(
                "flex-1 p-4 outline-none md:p-6",
                // The task thread owns its scrollable top spacing. Leaving the
                // page shell's top padding in place creates a stationary dark
                // strip below the breadcrumb while messages scroll behind it.
                !isMobile && useStreamlinedTaskDetailShell && "pt-0 md:pt-0",
                // Reserve the scrollbar gutter on desktop so pages whose height
                // changes (e.g. switching skill-detail tabs) don't widen/shift
                // when the vertical scrollbar appears or disappears (PAP-10907).
                isMobile
                  ? isTaskDetailRoute || isAssistantRoute
                    ? "overflow-visible pb-(--tc-composer-visible-nav-offset)"
                    : "overflow-visible pb-(--sz-calc-14)"
                  : "overflow-auto [scrollbar-gutter:stable]",
              )}
            >
              {hasUnknownCompanyPrefix ? (
                isBoardPathWithoutPrefix(location.pathname) ? (
                  <UnprefixedBoardRedirect />
                ) : (
                  <NotFoundPage
                    scope="invalid_company_prefix"
                    requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix}
                  />
                )
              ) : (
                <RouteErrorBoundary>
                  <Outlet />
                </RouteErrorBoundary>
              )}
              </main>
            </div>
            <PropertiesPanel taskDetailLayout={!isMobile && useStreamlinedTaskDetailShell} />
            {/* Its own host, not the single-slot PanelContext: the dock sits
                beside whatever the page put in the properties panel. */}
            <AssistantDock />
          </div>
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <NewIssueDialog />
      <NewProjectDialog />
      <NewGoalDialog />
      <NewAgentDialog />
      <KeyboardShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ToastViewport />
      <AnnouncementWell health={health} />
      <PluginAppShellOverlays localTrusted={health?.deploymentMode === "local_trusted"} />
      </div>
    </ChatSetupSidebarProvider>
  );
}

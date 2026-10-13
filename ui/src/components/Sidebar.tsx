import { Search, SquarePen } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { attentionBadgeCount } from "../lib/attention";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { primarySidebarStyles } from "./primary-sidebar-styles";
import { useSurfaces } from "../staples/surfaces/useSurfaces";
import { SidebarMoreMenu } from "../staples/surfaces/SidebarMoreMenu";
import { renderableSurfaces, type SurfaceState } from "../staples/surfaces/resolve";

export function Sidebar({ children }: { children?: ReactNode }) {
  const { openNewIssue } = useDialogActions();
  // Every labeled section is collapsible (session-scoped, default open) —
  // one policy across static nav groups and the data-driven sections.
  const [workOpen, setWorkOpen] = useState(true);
  const [organizationOpen, setOrganizationOpen] = useState(true);
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627) + reconnect reconcile — no
    // interval poll needed. Polling here also re-armed React Query's timer on
    // every live-event cache write, a major source of steady-state churn.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const liveRunCount = liveRuns?.length ?? 0;
  const liveIssueIds = new Set(
    (liveRuns ?? []).flatMap((run) => run.issueId ? [run.issueId] : []),
  );
  const { states, ready } = useSurfaces();
  // No-flash: until signals/prefs/flags settle, render only core surfaces plus
  // ones already persisted (pinned/revealed); never render then remove a
  // grows item because late signals arrived.
  const shown = renderableSurfaces(states, ready);
  const shownIds = new Set(shown.map((state) => state.surface.id));
  const combinedInboxTasks = experimentalSettings?.enableCombinedInboxTasks === true;
  const showDecisions = shownIds.has("nav.decisions");
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && showDecisions,
    refetchInterval: 60_000,
  });
  const attentionCount = attentionBadgeCount(attentionFeed);

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  const topSurfaces = shown.filter((state) => state.surface.group === "top");
  const workSurfaces = shown.filter((state) => state.surface.group === "work");
  const orgSurfaces = shown.filter((state) => state.surface.group === "org");

  const inboxBadgeProps = {
    badge: inboxBadge.inbox,
    badgeLabel: "unread",
    badgeTone: inboxBadge.failedRuns > 0 ? ("danger" as const) : ("default" as const),
    alert: inboxBadge.failedRuns > 0,
  };

  function renderSurface({ surface, isNew }: SurfaceState) {
    let extras: Record<string, unknown> = {};
    let textBadge: string | undefined;
    switch (surface.id) {
      case "nav.home":
        extras = { liveCount: liveRunCount };
        break;
      case "nav.inbox":
        extras = inboxBadgeProps;
        break;
      case "nav.tasks":
        if (combinedInboxTasks) extras = inboxBadgeProps;
        break;
      case "nav.decisions":
        extras = { badge: attentionCount, badgeLabel: "decisions" };
        break;
      case "nav.status":
      case "nav.cases":
        textBadge = "beta";
        break;
    }
    if (isNew) textBadge = "new";
    return (
      <Fragment key={surface.id}>
        <SidebarNavItem
          to={surface.to}
          label={surface.label}
          icon={surface.icon}
          textBadge={textBadge}
          hint={isNew ? surface.reason : undefined}
          {...extras}
        />
        {surface.id === "nav.projects" ? <SidebarStarredProjects /> : null}
      </Fragment>
    );
  }

  return (
    <aside
      className={cn(
        "w-full h-full min-h-0 flex flex-col",
        primarySidebarStyles.surface,
      )}
    >
      {/* Top bar: company name, aligned with top sections and borderless.
          Search deliberately does NOT live here:
          the header's spare width goes to the workspace/organization name,
          which is the user's orientation anchor and truncates otherwise.
          Search is the first nav item below instead. */}
      <div className="flex h-(--sz-60px) shrink-0 items-center gap-1 px-3">
        <SidebarCompanyMenu />
      </div>

      <nav className={primarySidebarStyles.nav}>
        <div className={primarySidebarStyles.group}>
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? "New Task" : undefined}
                className={cn(
                  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New Task</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">New Task</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          {/* Search moved out of the header so the workspace name keeps the
              width; a nav row also keeps search reachable from the
              collapsed rail, where the old header icon was dropped entirely.
              Cmd/Ctrl+K remains the keyboard path (command palette). */}
          <SidebarNavItem to="/search" label="Search" icon={Search} />
          {topSurfaces.map(renderSurface)}
        </div>

        {workSurfaces.length > 0 ? (
        <SidebarSection label="Work" collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
          {workSurfaces.map(renderSurface)}
          <PluginSlotOutlet
            errorBehavior="hidden"
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            errorBehavior="hidden"
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </SidebarSection>
        ) : null}

        {orgSurfaces.length > 0 ? (
          <SidebarSection
            label="Org"
            collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
          >
            {orgSurfaces.map(renderSurface)}
          </SidebarSection>
        ) : null}

        <SidebarMoreMenu />

        {children ?? <SidebarAgents />}

        <SidebarRecentTasks companyId={selectedCompanyId} liveIssueIds={liveIssueIds} />

        <PluginSlotOutlet
          errorBehavior="hidden"
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}

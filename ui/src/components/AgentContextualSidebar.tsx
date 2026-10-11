import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  Activity,
  BadgeDollarSign,
  BookOpenText,
  ChevronRight,
  History,
  KeyRound,
  Library,
  MessageSquare,
  PlayCircle,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { isTemplatedAgent } from "@/staples/autopilot/templateRecord";
import { chatProviderVisible, useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";
import {
  agentActiveViewFromPath,
  agentAdvancedNavigation,
  agentChannelCount,
  agentDetailHref,
  agentPrimaryNavigation,
  isAgentAdvancedActive,
  isAgentAdvancedItemHidden,
  readAgentAdvancedOpen,
  resolveAgentAdvancedOpen,
  writeAgentAdvancedOpen,
  agentScopedAuditHref,
  type AgentLocalDetailView,
} from "@/pages/agent-detail-navigation";

const localIcons = {
  overview: Sparkles,
  instructions: BookOpenText,
  skills: Library,
  autopilot: Zap,
  runtime: Settings2,
  secrets: ShieldCheck,
  tools: Wrench,
  channels: MessageSquare,
  permissions: ShieldCheck,
  "api-keys": KeyRound,
  revisions: History,
} satisfies Record<AgentLocalDetailView, typeof Sparkles>;

const auditItems = [
  { section: "activity", label: "Activity", icon: Activity },
  { section: "runs", label: "Runs", icon: PlayCircle },
  { section: "costs", label: "Costs", icon: ReceiptText },
  { section: "budgets", label: "Budgets", icon: BadgeDollarSign },
] as const;

export function AgentContextualSidebar({
  agentRef,
  agentId,
  agentName,
  labels = { secrets: "Secrets & variables" },
}: {
  agentRef: string;
  agentId?: string;
  agentName?: string;
  labels?: Partial<Record<AgentLocalDetailView, string>>;
}) {
  const { selectedCompanyId } = useCompany();
  // Always resolved: the template record (Autopilot) lives on the agent.
  const { data: resolvedAgent } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentRef), selectedCompanyId ?? null, "contextual-sidebar"],
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId ?? undefined),
    enabled: Boolean(agentRef && selectedCompanyId),
  });
  const resolvedId = agentId ?? resolvedAgent?.id;
  const resolvedName = agentName ?? resolvedAgent?.name ?? "Agent";

  const location = useLocation();
  const activeView = agentActiveViewFromPath(location.pathname);
  const auditActive =
    /^(?:\/[^/]+)?\/activity/.test(location.pathname) &&
    Boolean(resolvedId) &&
    new URLSearchParams(location.search).get("agentId") === resolvedId;
  const advancedActive = isAgentAdvancedActive({ activeView, auditActive });
  const [storedOpen, setStoredOpen] = useState(() => readAgentAdvancedOpen());
  const advancedOpen = resolveAgentAdvancedOpen({ storedOpen, advancedActive });

  const { enabled: chatEnabled, githubEnabled } = useChatConnectorsEnabled();
  const { data: endpoints } = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId ?? ""),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && resolvedId),
  });
  const { data: keys } = useQuery({
    queryKey: queryKeys.agents.keys(resolvedId ?? ""),
    queryFn: () => agentsApi.listKeys(resolvedId!, selectedCompanyId ?? undefined),
    enabled: Boolean(resolvedId),
  });
  const counts = {
    channels: endpoints
      ? agentChannelCount(endpoints, resolvedId ?? "", (provider) =>
          chatProviderVisible(provider, chatEnabled, githubEnabled))
      : undefined,
    apiKeys: keys ? keys.length : undefined,
    templated: resolvedAgent ? isTemplatedAgent(resolvedAgent) : undefined,
  };

  const toggleAdvanced = () => {
    if (advancedActive) return;
    const next = !advancedOpen;
    setStoredOpen(next);
    writeAgentAdvancedOpen(next);
  };

  const renderSection = (section: { label: string; items: ReadonlyArray<{ value: AgentLocalDetailView; label: string }> }, first = false) => {
    const items = section.items.filter((item) => !isAgentAdvancedItemHidden(item.value, counts, activeView));
    if (items.length === 0) return null;
    return (
      <div
        key={section.label}
        data-slot="contextual-sidebar-section"
        className={first ? contextualSidebarStyles.section : "mt-3"}
      >
        <p data-slot="contextual-sidebar-section-label" className={contextualSidebarStyles.sectionLabel}>
          {section.label}
        </p>
        <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
          {items.map((item) => (
            <SidebarNavItem
              key={item.value}
              to={agentDetailHref(agentRef, item.value)}
              label={labels?.[item.value] ?? item.label}
              icon={localIcons[item.value]}
            />
          ))}
        </div>
      </div>
    );
  };

  const advancedSections = agentAdvancedNavigation();
  const advancedId = "agent-advanced-nav";

  return (
    <ContextualSidebarFrame
      surface="agent"
      title={resolvedName}
      fallbackTo="/agents/all"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav
        aria-label={`${resolvedName} navigation`}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        {agentPrimaryNavigation().map((section) => renderSection(section, true))}

        <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            aria-disabled={advancedActive || undefined}
            onClick={advancedActive ? undefined : toggleAdvanced}
            className={`${contextualSidebarStyles.sectionLabel} flex w-full items-center gap-1 text-left hover:text-foreground`}
          >
            <ChevronRight className={advancedOpen ? "size-3 rotate-90" : "size-3"} aria-hidden />
            Advanced
          </button>
          <div id={advancedId}>
            {advancedOpen && (
              <>
                {advancedSections.map((section) => renderSection(section))}
                <div data-slot="contextual-sidebar-section" className="mt-3">
                  <p data-slot="contextual-sidebar-section-label" className={contextualSidebarStyles.sectionLabel}>
                    Audit
                  </p>
                  <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
                    {resolvedId ? auditItems.map((item) => (
                      <SidebarNavItem
                        key={item.section}
                        to={agentScopedAuditHref(resolvedId, item.section)}
                        label={item.label}
                        icon={item.icon}
                      />
                    )) : (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading audit links…</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}

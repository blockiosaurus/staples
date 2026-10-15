import { lazy, Suspense } from "react";
import type { ToolConnectionCredentialSource } from "@paperclipai/shared";
import { Navigate, Outlet, Route, Routes, useActiveCompanyPrefix, useLocation, useParams } from "@/lib/router";
import { Layout } from "./components/Layout";
import { TaskChatLab } from "./pages/TaskChatLab";
import { PipelinesExperimentalGate } from "./components/PipelinesExperimentalGate";
import { CasesExperimentalGate } from "./components/CasesExperimentalGate";
import { StatusCardsExperimentalGate } from "./components/StatusCardsExperimentalGate";
import { CloudManagedPageGate } from "./components/CloudManagedPageGate";
import { HiddenSettingsPageGate } from "./components/HiddenSettingsPageGate";
import { IsolatedWorkspacesRouteGate } from "./components/IsolatedWorkspacesRouteGate";
import {
  ExecutionWorkspaceCompanyGate,
  UnprefixedExecutionWorkspaceRedirect,
} from "./components/UnprefixedExecutionWorkspaceRedirect";
import { useHiddenSettings } from "./hooks/useHiddenSettings";
import { Cases } from "./pages/Cases";
import { CaseDetail } from "./pages/CaseDetail";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { InstanceAdminGate } from "./components/InstanceAdminGate";
import { InstanceGeneralSettings } from "./pages/InstanceGeneralSettings";
import { PaperclipLoading } from "./components/AnimatedPaperclipIcon";
import { UnprefixedBoardRedirect } from "./components/UnprefixedBoardRedirect";
import { Dashboard } from "./pages/Dashboard";
import { DashboardLive } from "./pages/DashboardLive";
import { Companies } from "./pages/Companies";
import { AGENT_FILTER_TABS, Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { ProjectWorkspaceDetail } from "./pages/ProjectWorkspaceDetail";
import { Workspaces } from "./pages/Workspaces";
import { Issues } from "./pages/Issues";
import { Search } from "./pages/Search";
import { IssueDetail } from "./pages/IssueDetail";
import { AgentChats } from "./pages/AgentChats";
import { AgentChat } from "./pages/AgentChat";
import { AssistantPage } from "./staples/assistant/AssistantPage";
import { CompanyBriefPage } from "./staples/brief/CompanyBriefPage";
import { HomePage } from "./staples/home/HomePage";
import { Routines } from "./pages/Routines";
import { Learnings, PipelineItemDetail, PipelineItemLegacyRedirect, Pipelines, ReviewQueue } from "./pages/Pipelines";
import { PipelineSettings } from "./pages/PipelineSettings";
import { StatusCards } from "./pages/StatusCards";
import { RoutineDetail } from "./pages/RoutineDetail";
import { UserProfile } from "./pages/UserProfile";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { Artifacts } from "./pages/Artifacts";
import { GoalDetail } from "./pages/GoalDetail";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { CompanyActivity } from "./pages/audit/CompanyActivity";
import { AuditHub } from "./pages/audit/AuditHub";
import { Inbox } from "./pages/Inbox";
import { useCombinedInboxTasksEnabled } from "./hooks/useCombinedInboxTasksEnabled";
import { WhatNeedsMe } from "./pages/WhatNeedsMe";
import { DecisionQueuePage } from "./pages/DecisionQueuePage";
import { CompanySettings } from "./pages/CompanySettings";
import { CompanyEnvironments } from "./pages/CompanyEnvironments";
import { CompanySettingsPluginPage } from "./pages/CompanySettingsPluginPage";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./pages/CompanyAccess";
import { AdvancedToolsRoute } from "./pages/tools/AdvancedToolsRoute";
import { ProfileWizardRoute } from "./pages/tools/profiles/ProfileWizardRoute";
import { ProfileDetailRoute } from "./pages/tools/profiles/ProfileDetailRoute";
import { Browse } from "./pages/apps/Browse";
import { AppsConnect } from "./pages/apps/AppsConnect";
import { ChatEndpointSetup } from "./pages/apps/chat/ChatEndpointSetup";
import { ChatEndpointDetail } from "./pages/apps/chat/ChatEndpointDetail";
import { ChatIdentityConfirm } from "./pages/apps/chat/ChatIdentityConfirm";
import { ChatConnectorsExperimentalGate } from "./components/ChatConnectorsExperimentalGate";
import { useChatConnectorsEnabled } from "./hooks/useChatConnectorsEnabled";
import { canEnterAppsConnect } from "./pages/apps/app-connect-policy";
import { AppsReview } from "./pages/apps/AppsReview";
import { AppDetail } from "./pages/apps/AppDetail";
import { AppNotConnected } from "./pages/apps/AppNotConnected";
import { PaperclipCloudOAuthHandoffPage } from "./pages/apps/PaperclipCloudOAuthHandoff";
import { GatewaysList } from "./pages/apps/gateways/GatewaysList";
import { GatewayDetail } from "./pages/apps/gateways/GatewayDetail";
import { CompanySkills } from "./pages/CompanySkills";
import { SkillSources } from "./pages/SkillSources";
import { SkillStudio } from "./pages/SkillStudio";
import { Secrets } from "./pages/Secrets";
import { CompanyImport } from "./pages/CompanyImport";
import { DesignGuide } from "./pages/DesignGuide";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { InstanceAccess } from "./pages/InstanceAccess";
import { ProfileSettings } from "./pages/ProfileSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { AdapterManager } from "./pages/AdapterManager";
import { PluginPage } from "./pages/PluginPage";
import { NewAgent } from "./pages/NewAgent";
import { MarketplacePage } from "./staples/marketplace/MarketplacePage";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { AssistantConnection } from "./pages/apps/AssistantConnection";
import { McpConnectPage, McpDevicePage, AssistantConnectionsPage } from "./pages/McpConnect";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { TermsPage } from "./pages/legal/TermsPage";
import { PrivacyPage } from "./pages/legal/PrivacyPage";
import { JoinRequestQueue } from "./pages/JoinRequestQueue";
import { NotFoundPage } from "./pages/NotFound";
import { useCompany } from "./context/CompanyContext";
import { loadLastInboxTab } from "./lib/inbox";
import { TASK_VIEW_PARAM, taskViewForInboxTab, type TaskViewKey } from "./lib/task-views";
import { StartCompanyPage } from "./staples/start/StartCompanyPage";
import { OnboardingRedirect } from "./staples/start/OnboardingRedirect";
import { filterHiddenInstanceSettingsPath, normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";

const CompanyExport = lazy(() =>
  import("./pages/CompanyExport").then((module) => ({ default: module.CompanyExport })),
);

function boardRoutes(combinedInboxTasksEnabled: boolean) {
  const mergedTasks = combinedInboxTasksEnabled;
  return (
    <>
      <Route index element={<Navigate to="home" replace />} />
      <Route path="home" element={<HomePage />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route
        path="timeline"
        element={<AuditCompatibilityRedirect to="/activity/timeline" />}
      />
      <Route path="onboarding" element={<OnboardingRedirect />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/brief" element={<CompanyBriefPage />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/environments" element={<Navigate to="/company/settings/instance/environments" replace />} />
      <Route path="company/settings/cloud-upstream" element={<Navigate to="/company/export" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="company.members" />}>
        <Route path="company/settings/members" element={<CompanyAccess />} />
        <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      </Route>
      {/* Invites moved into the Members page; the old URL redirects (and stays
          gated so a hidden Invites surface never round-trips through it). */}
      <Route element={<HiddenSettingsPageGate pageKey="company.invites" />}>
        <Route
          path="company/settings/invites"
          element={<Navigate to="/company/settings/members?tab=invites" replace />}
        />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.export" />}>
        <Route
          path="company/export/*"
          element={(
            <Suspense fallback={<PaperclipLoading />}>
              <CompanyExport />
            </Suspense>
          )}
        />
      </Route>
      <Route element={<CloudManagedPageGate />}>
        <Route element={<HiddenSettingsPageGate pageKey="company.import" />}>
          <Route path="company/import" element={<CompanyImport />} />
        </Route>
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.secrets" />}>
        <Route path="company/settings/secrets" element={<Secrets />} />
      </Route>
      <Route path="company/settings/tools" element={<LegacyToolsSettingsRedirect />} />
      <Route path="company/settings/tools/:tab" element={<LegacyToolsSettingsRedirect />} />
      <Route path="tools" element={<LegacyToolsRedirect />} />
      <Route path="tools/:tab" element={<LegacyToolsRedirect />} />
      <Route path="apps" element={<Browse />} />
      <Route path="apps/assistant-connection" element={<AssistantConnection />} />
      <Route path="apps/browse" element={<Navigate to="/apps" replace />} />
      <Route path="apps/connections" element={<Navigate to="/apps" replace />} />
      <Route path="apps/byo" element={<AppsConnect byoOnly />} />
      <Route
        path="apps/vercel-connect"
        element={<AppsConnectEntryRoute credentialSource="vercel_connect" />}
      />
      <Route path="apps/connect" element={<AppsConnectEntryRoute />} />
      <Route path="apps/chat/connect" element={
        <ChatConnectorsExperimentalGate><ChatEndpointSetup /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/chat/:endpointId" element={
        <ChatConnectorsExperimentalGate><Navigate to="settings" replace /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/chat/:endpointId/reviews/:reviewId" element={
        <ChatConnectorsExperimentalGate><ChatEndpointDetail /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/chat/:endpointId/:tab" element={
        <ChatConnectorsExperimentalGate><ChatEndpointDetail /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/connect/:appKey" element={<Navigate to="/apps" replace />} />
      <Route path="apps/connect/:appKey/:stage" element={<Navigate to="/apps" replace />} />
      <Route path="apps/review" element={<AppsReview />} />
      {/* Connector health is inline on the Apps landing page; keep legacy links working. */}
      <Route path="apps/attention" element={<Navigate to="/apps" replace />} />
      <Route path="apps/gateways" element={<GatewaysList />} />
      <Route path="apps/gateways/:gatewayId" element={<Navigate to="overview" replace />} />
      <Route path="apps/gateways/:gatewayId/:tab" element={<GatewayDetail />} />
      <Route path="apps/advanced" element={<AdvancedToolsRoute />} />
      <Route path="apps/advanced/gateways" element={<GatewaysList />} />
      <Route path="apps/advanced/profiles/new" element={<ProfileWizardRoute mode="new" />} />
      <Route path="apps/advanced/profiles/:profileId/edit" element={<ProfileWizardRoute mode="edit" />} />
      <Route path="apps/advanced/profiles/:profileId" element={<ProfileDetailRoute />} />
      <Route path="apps/advanced/audit" element={<Navigate to="/apps" replace />} />
      <Route path="apps/advanced/run-your-own" element={<Navigate to="/apps" replace />} />
      <Route path="apps/advanced/:tab" element={<AdvancedToolsRoute />} />
      <Route path="apps/app/:applicationId" element={<AppNotConnected />} />
      <Route path="apps/app/:applicationId/:tab" element={<AppNotConnected />} />
      <Route path="apps/:connectionId" element={<Navigate to="permissions" replace />} />
      <Route path="apps/:connectionId/:tab" element={<AppDetail />} />
      <Route path="company/settings/instance" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.profile" />}>
        <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      </Route>
      <Route element={<InstanceAdminGate />}>
        <Route path="company/settings/instance/general" element={<InstanceGeneralSettings />} />
      </Route>
      <Route path="company/settings/instance/heartbeats" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.environments" />}>
        <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
        <Route path="company/settings/instance/environments/new" element={<CompanyEnvironments mode="create" />} />
        <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.access" />}>
        <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.experimental" />}>
        <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.plugins" />}>
        <Route path="company/settings/instance/plugins" element={<PluginManager />} />
        <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.adapters" />}>
        <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      </Route>
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/sources" element={<SkillSources />} />
      <Route path="skills/sources/:sourceId" element={<SkillSources />} />
      <Route path="skills/studio" element={<SkillStudio />} />
      <Route path="skills/studio/new" element={<SkillStudio />} />
      <Route path="skills/studio/:skillId" element={<SkillStudio />} />
      <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
      <Route
        path="skills/*"
        element={<CompanySkills />}
      />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route
        path="org"
        element={<Navigate to="/agents/all" replace />}
      />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      {AGENT_FILTER_TABS.map((tab) => (
        <Route
          key={tab}
          path={`agents/${tab}`}
          element={<Agents />}
        />
      ))}
      <Route path="agents/new" element={<MarketplacePage />} />
      <Route path="agents/new/custom" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      </Route>
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="workspaces" element={<Workspaces />} />
      </Route>
      <Route path="issues" element={<Issues />} />
      <Route path="tasks" element={<Navigate to="/issues" replace />} />
      <Route path="search" element={<Search />} />
      {mergedTasks ? (
        <>
          {/* Combined Inbox + Task List: the status presets are real views, not aliases of /issues. */}
          <Route path="issues/all" element={<TaskViewRedirect view="all" />} />
          <Route path="issues/active" element={<TaskViewRedirect view="active" />} />
          <Route path="issues/backlog" element={<TaskViewRedirect view="backlog" />} />
          <Route path="issues/done" element={<TaskViewRedirect view="done" />} />
          <Route path="issues/recent" element={<TaskViewRedirect view="recent" />} />
        </>
      ) : (
        <>
          <Route path="issues/all" element={<Navigate to="/issues" replace />} />
          <Route path="issues/active" element={<Navigate to="/issues" replace />} />
          <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
          <Route path="issues/done" element={<Navigate to="/issues" replace />} />
          <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
        </>
      )}
      <Route path="chats" element={<AgentChats />} />
      <Route path="chats/:agentRef" element={<AgentChat />} />
      <Route path="assistant" element={<AssistantPage />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="routines" element={<Routines />} />
      <Route
        path="cases"
        element={<CasesExperimentalGate><Cases /></CasesExperimentalGate>}
      />
      <Route
        path="cases/:caseIdentifier"
        element={<CasesExperimentalGate><CaseDetail /></CasesExperimentalGate>}
      />
      <Route
        path="status"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      <Route
        path="status/:cardId"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      {/* Back-compat: the board lived at /status-cards before PAP-15223. */}
      <Route path="status-cards" element={<StatusCardsLegacyRedirect />} />
      <Route path="status-cards/:cardId" element={<StatusCardsLegacyRedirect />} />
      <Route
        path="review-queue"
        element={<PipelinesExperimentalGate><ReviewQueue /></PipelinesExperimentalGate>}
      />
      <Route
        path="learnings"
        element={<PipelinesExperimentalGate><Learnings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/add"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/settings"
        element={<PipelinesExperimentalGate><PipelineSettings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/items/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemDetail /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/cases/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemLegacyRedirect /></PipelinesExperimentalGate>}
      />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route element={<ExecutionWorkspaceCompanyGate />}>
          <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
        </Route>
      </Route>
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="activity" element={<CompanyActivity />} />
      <Route path="activity/runs" element={<AuditHub section="runs" />} />
      <Route path="activity/costs" element={<AuditHub section="costs" />} />
      <Route path="activity/budgets" element={<AuditHub section="budgets" />} />
      <Route path="activity/timeline" element={<AuditHub section="timeline" />} />
      <Route path="audit" element={<AuditCompatibilityRedirect to="/activity" forceAgentMode />} />
      <Route path="audit/activity" element={<AuditCompatibilityRedirect to="/activity" />} />
      <Route path="audit/runs" element={<AuditCompatibilityRedirect to="/activity/runs" />} />
      <Route path="audit/costs" element={<AuditCompatibilityRedirect to="/activity/costs" />} />
      <Route path="audit/budgets" element={<AuditCompatibilityRedirect to="/activity/budgets" />} />
      <Route path="audit/timeline" element={<AuditCompatibilityRedirect to="/activity/timeline" />} />
      <Route path="runs" element={<AuditCompatibilityRedirect to="/activity/runs" />} />
      <Route path="costs" element={<AuditCompatibilityRedirect to="/activity/costs" />} />
      <Route path="budgets" element={<AuditCompatibilityRedirect to="/activity/budgets" />} />
      {/* Task chat dev harness — dev builds only. */}
      {import.meta.env.DEV ? (
        <Route path="dev/task-chat-lab" element={<TaskChatLab />} />
      ) : null}
      <Route path="decisions" element={<WhatNeedsMe />} />
      <Route path="decisions/queues/:key" element={<DecisionQueuePage />} />
      {/* Combined Inbox + Task List: Inbox is a view inside Tasks. Every /inbox/* URL still
          resolves — it redirects into the matching view — and with the flag off
          (or in the legacy shell) the standalone pages stay. /inbox/requests
          stays its own page either way; Settings → Members links straight to it. */}
      {mergedTasks ? (
        <>
          <Route path="inbox" element={<InboxRootRedirect />} />
          <Route path="inbox/mine" element={<TaskViewRedirect view="mine" />} />
          <Route path="inbox/recent" element={<TaskViewRedirect view="recent" />} />
          <Route path="inbox/unread" element={<TaskViewRedirect view="unread" />} />
          <Route path="inbox/blocked" element={<TaskViewRedirect view="blocked" />} />
          <Route path="inbox/all" element={<TaskViewRedirect view="everything" />} />
          <Route path="inbox/new" element={<TaskViewRedirect view="mine" />} />
        </>
      ) : (
        <>
          <Route path="inbox" element={<InboxRootRedirect />} />
          <Route path="inbox/mine" element={<Inbox />} />
          <Route path="inbox/recent" element={<Inbox />} />
          <Route path="inbox/unread" element={<Inbox />} />
          <Route path="inbox/blocked" element={<Inbox />} />
          <Route path="inbox/all" element={<Inbox />} />
          <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
        </>
      )}
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function AppsConnectEntryRoute({
  credentialSource = "paperclip_vault",
}: {
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const { enabled: chatConnectorsEnabled, githubEnabled: githubReviewBotsEnabled } = useChatConnectorsEnabled();
  return canEnterAppsConnect(searchParams, { chatConnectorsEnabled, githubReviewBotsEnabled })
    ? <AppsConnect credentialSource={credentialSource} />
    : <Navigate to="/apps" replace />;
}

function InboxRootRedirect() {
  const { enabled: combinedInboxTasksEnabled } = useCombinedInboxTasksEnabled();
  return combinedInboxTasksEnabled
    ? <TaskViewRedirect view={taskViewForInboxTab(loadLastInboxTab())} />
    : <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

/** Sends a retired Inbox/Tasks URL to its view on the merged Tasks surface. */
function TaskViewRedirect({ view }: { view: TaskViewKey }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set(TASK_VIEW_PARAM, view);
  return <Navigate to={`/issues?${params.toString()}${location.hash}`} replace />;
}

function LegacySkillStudioRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix, skillId } = useParams<{ companyPrefix?: string; skillId?: string }>();

  if (loading) return null;

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany || !skillId) {
    return <Navigate to="/skills/studio" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}/skills/studio/${encodeURIComponent(skillId)}${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacySettingsRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { hidden: hiddenSettings } = useHiddenSettings();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany) {
    return <Navigate to="/start" replace />;
  }

  const normalizedPath = filterHiddenInstanceSettingsPath(
    normalizeRememberedInstanceSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
    ),
    hiddenSettings,
  );

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${normalizedPath}`}
      replace
    />
  );
}

function LegacyToolsSettingsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

// The developer "Tools" surface moved under the Apps "Advanced setup" door
// (PAP-10862). `/tools` and `/tools/:tab` redirect to their new home.
function LegacyToolsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

function legacyToolsRedirectTarget(tab?: string) {
  if (!tab) return "/apps/advanced/profiles";
  if (tab === "applications" || tab === "connections" || tab === "overview" || tab === "examples") return "/apps";
  if (tab === "runtime" || tab === "audit") return "/apps";
  if (tab === "policies") return "/apps/advanced/profiles";
  return `/apps/advanced/${tab}`;
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <Navigate to="/start" replace />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/home`} replace />;
}

function StatusCardsLegacyRedirect() {
  const { cardId } = useParams<{ cardId?: string }>();
  const prefix = useActiveCompanyPrefix();
  const base = prefix ? `/${prefix}` : "";
  return <Navigate to={`${base}/status${cardId ? `/${cardId}` : ""}`} replace />;
}

function AuditCompatibilityRedirect({
  to,
  forceAgentMode = false,
}: {
  to: string;
  forceAgentMode?: boolean;
}) {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  if (forceAgentMode) searchParams.set("mode", "agents");
  const search = searchParams.toString();
  return <Navigate to={`${to}${search ? `?${search}` : ""}${location.hash}`} replace />;
}

export function App() {
  const { enabled: combinedInboxTasksEnabled, loaded: experimentalSettingsLoaded } = useCombinedInboxTasksEnabled();

  return (
    <>
      <Routes>
        <Route path="oauth-handoff" element={<PaperclipCloudOAuthHandoffPage />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="mcp-connect/:id" element={<McpConnectPage />} />
        <Route path="dot-connect/:id" element={<McpConnectPage agentPairingOnly />} />
        <Route path="mcp-device" element={<McpDevicePage />} />
        <Route path="assistant-connections" element={<AssistantConnectionsPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route element={experimentalSettingsLoaded ? <CloudAccessGate allowMembershipRequest /> : <PaperclipLoading />}>
          {/* The identity APIs enforce the chat rollout flag. Nonmembers cannot
              read experimental settings, but a private invitation may request membership. */}
          <Route path="chat-identity/confirm" element={<ChatIdentityConfirm />} />
        </Route>

        <Route element={experimentalSettingsLoaded ? <CloudAccessGate /> : <PaperclipLoading />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="start" element={<StartCompanyPage />} />
          <Route path="onboarding" element={<OnboardingRedirect />} />
          <Route path="instance" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings/*" element={<LegacySettingsRedirect />} />
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="home" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="tasks" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="review-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="learnings" element={<UnprefixedBoardRedirect />} />
          <Route path="cases" element={<UnprefixedBoardRedirect />} />
          <Route path="cases/:caseIdentifier" element={<UnprefixedBoardRedirect />} />
          <Route path="status" element={<UnprefixedBoardRedirect />} />
          <Route path="status/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/add" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/items/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/cases/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="artifacts" element={<UnprefixedBoardRedirect />} />
          <Route path="audit" element={<UnprefixedBoardRedirect />} />
          <Route path="audit/*" element={<UnprefixedBoardRedirect />} />
          <Route path="activity" element={<UnprefixedBoardRedirect />} />
          <Route path="activity/*" element={<UnprefixedBoardRedirect />} />
          <Route path="runs" element={<UnprefixedBoardRedirect />} />
          <Route path="costs" element={<UnprefixedBoardRedirect />} />
          <Route path="budgets" element={<UnprefixedBoardRedirect />} />
          <Route path="decisions" element={<UnprefixedBoardRedirect />} />
          <Route path="assistant" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/new" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/:skillId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          {AGENT_FILTER_TABS.map((tab) => (
            <Route key={tab} path={`agents/${tab}`} element={<UnprefixedBoardRedirect />} />
          ))}
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new/custom" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes(combinedInboxTasksEnabled)}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
    </>
  );
}

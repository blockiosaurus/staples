import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAssistantAgent, type Agent, type Issue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { agentChatsApi } from "@/api/agentChats";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { excludeAssistantAgents } from "@/lib/assistant-agent";

const assistantAgentIds = (agents: Agent[]) => agents.filter(isAssistantAgent).map((agent) => agent.id);

export function useAgentChatNavigation() {
  const { selectedCompanyId: companyId } = useCompany();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  // The Assistant has its own page (/assistant); it is not part of the Chats roster.
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId, select: excludeAssistantAgents,
  });
  const assistantIds = useQuery({
    queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId, select: assistantAgentIds,
  });
  const hiddenKey = (assistantIds.data ?? []).join(",");
  const selectChats = useCallback(
    (list: Issue[]) => {
      const hidden = new Set(hiddenKey ? hiddenKey.split(",") : []);
      return hidden.size === 0 ? list : list.filter((chat) => !hidden.has(chat.conversationAgentId ?? ""));
    },
    [hiddenKey],
  );
  const chats = useQuery({
    queryKey: queryKeys.agentChats.list(companyId, userId), queryFn: () => agentChatsApi.list(companyId!),
    enabled: !!companyId && session.isSuccess, select: selectChats,
  });
  return { companyId, userId, agents, chats, session };
}

/** Explicitly adding a chat uses the existing atomic, one-per-agent resolver. */
export function useOpenAgentChat(companyId: string | null, userId: string | null) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const scope = useRef({ companyId, userId, mounted: true });
  useEffect(() => {
    const current = { companyId, userId, mounted: true };
    scope.current = current;
    return () => { current.mounted = false; };
  }, [companyId, userId]);
  return useCallback(async (agent: Agent, signal?: AbortSignal) => {
    if (!companyId || agent.companyId !== companyId) throw new Error("Choose an agent from this company.");
    const current = scope.current;
    const chat = await agentChatsApi.ensure(companyId, agent.id);
    client.setQueryData(queryKeys.agentChats.detail(companyId, userId, agent.id), chat);
    client.setQueryData(queryKeys.issues.detail(chat.id), chat);
    client.setQueryData<Issue[]>(queryKeys.agentChats.list(companyId, userId), previous =>
      [chat, ...(previous ?? []).filter(item => item.id !== chat.id)]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || b.id.localeCompare(a.id)));
    if (!current.mounted || scope.current !== current || signal?.aborted) return;
    navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}`);
    if (isMobile) setSidebarOpen(false);
  }, [client, companyId, userId, navigate, isMobile, setSidebarOpen]);
}

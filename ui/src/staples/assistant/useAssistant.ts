import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { assistantApi, type AssistantSetup, type AssistantSummary } from "@/api/assistant";
import { authApi } from "@/api/auth";
import { ApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export interface UseAssistantResult {
  /** The full Assistant agent record, once loaded. */
  agent: Agent | null;
  summary: AssistantSummary | null;
  /** Whether the Assistant can answer yet (ready when the server predates setup). */
  setup: AssistantSetup | null;
  conversationIssueId: string | null;
  conversationIssue: Issue | null;
  /** Creates the caller's conversation with the Assistant if needed. */
  ensureConversation: () => Promise<string>;
  ensureIssue: () => Promise<Issue>;
  loading: boolean;
  /** GET /assistant succeeded: the Assistant exists for this company. */
  available: boolean;
  error: Error | null;
  retry: () => void;
  userId: string | null;
}

/**
 * The company Assistant and the current person's conversation with it.
 * `withConversation: false` only resolves availability (for shell chrome).
 */
export function useAssistant({ withConversation = true }: { withConversation?: boolean } = {}): UseAssistantResult {
  const { selectedCompanyId } = useCompany();
  const client = useQueryClient();
  const summary = useQuery({
    queryKey: queryKeys.assistant.detail(selectedCompanyId ?? null),
    queryFn: () => assistantApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
    // While the Assistant is being verified, poll until it is ready (or needs a model).
    refetchInterval: (query) => (query.state.data?.setup?.state === "starting" ? 2_000 : false),
    // A 4xx (no Assistant route, no access) won't fix itself; show the inline
    // error with its Retry button instead of spinning through backoff.
    retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
  });
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: withConversation,
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentId = summary.data?.agent.id;
  const agent = useQuery({
    queryKey: queryKeys.agents.detail(agentId ?? ""),
    queryFn: () => agentsApi.get(agentId!, selectedCompanyId!),
    enabled: withConversation && !!agentId && !!selectedCompanyId,
  });
  const chatKey = queryKeys.agentChats.detail(selectedCompanyId ?? null, userId, agentId);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => agentChatsApi.get(selectedCompanyId!, agentId!),
    enabled: withConversation && !!agentId && !!selectedCompanyId && session.isFetched,
  });

  const creating = useRef<Promise<Issue> | null>(null);
  useEffect(() => {
    creating.current = null;
  }, [selectedCompanyId, userId, agentId]);
  const ensureIssue = useCallback(async () => {
    if (!agentId || !selectedCompanyId) throw new Error("Assistant not available");
    if (chat.data) return chat.data;
    const promise = (creating.current ??= agentChatsApi.ensure(selectedCompanyId, agentId));
    try {
      const issue = await promise;
      client.setQueryData(queryKeys.issues.detail(issue.id), issue);
      client.setQueryData(chatKey, issue);
      client.setQueryData<AssistantSummary>(queryKeys.assistant.detail(selectedCompanyId), (current) =>
        current ? { ...current, conversationIssueId: issue.id } : current);
      void client.invalidateQueries({ queryKey: queryKeys.agentChats.list(selectedCompanyId, userId) });
      return issue;
    } catch (error) {
      creating.current = null;
      throw error;
    }
    // chatKey is derived from the listed values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, selectedCompanyId, chat.data, client, userId]);
  const ensureConversation = useCallback(async () => (await ensureIssue()).id, [ensureIssue]);

  const retry = useCallback(() => {
    void summary.refetch();
    if (withConversation) {
      if (agent.isError) void agent.refetch();
      if (chat.isError) void chat.refetch();
    }
  }, [summary, agent, chat, withConversation]);

  const error = (summary.error ?? (withConversation ? agent.error ?? chat.error : null)) as Error | null;
  const loading = !error && (
    summary.isPending
    || (withConversation && (session.isPending || agent.isPending || chat.isPending))
  );

  return {
    agent: agent.data ?? null,
    summary: summary.data ?? null,
    setup: summary.data ? (summary.data.setup ?? { state: "ready", adapterType: summary.data.agent.adapterType }) : null,
    conversationIssueId: chat.data?.id ?? summary.data?.conversationIssueId ?? null,
    conversationIssue: chat.data ?? null,
    ensureConversation,
    ensureIssue,
    loading,
    available: summary.isSuccess,
    error,
    retry,
    userId,
  };
}

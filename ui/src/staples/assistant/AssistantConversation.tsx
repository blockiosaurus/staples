import { useCallback, useEffect, useMemo } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { TaskDetailSurface } from "@/pages/IssueDetail";
import { useAssistantShell } from "./AssistantProvider";
import { useAssistant } from "./useAssistant";
import { AssistantOpening } from "./AssistantOpening";
import { AssistantSetupCard } from "./AssistantSetupCard";

export function AssistantUnavailable({ message, onRetry }: { message?: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
      <p className="font-medium text-foreground">The Assistant isn't available right now.</p>
      {message ? <p className="text-muted-foreground">{message}</p> : null}
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="h-3.5 w-3.5" />
        Retry
      </Button>
    </div>
  );
}

/** Page title while the conversation surface (which sets its own) isn't mounted. */
function AssistantPageCrumb() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Assistant" }]);
  }, [setBreadcrumbs]);
  return null;
}

/**
 * The Assistant conversation, shared by the full page and the dock. It is the
 * same `TaskDetailSurface` Agent Chat uses (so proposed-action cards and their
 * Confirm/Cancel handlers come along); the dock renders it `embedded`.
 */
export function AssistantConversation({
  embedded = false,
  opening = !embedded,
}: {
  embedded?: boolean;
  /** Show the client-rendered opening bubble while the thread is empty (page and stage 0, not the dock). */
  opening?: boolean;
}) {
  const assistant = useAssistant();
  const { selectedCompanyId } = useCompany();
  const shell = useAssistantShell();
  const shellCommentMetadata = shell?.commentMetadata;
  const shellCommentSent = shell?.commentSent;
  const commentMetadata = useCallback(() => shellCommentMetadata?.(), [shellCommentMetadata]);
  const onCommentSent = useCallback(() => shellCommentSent?.(), [shellCommentSent]);
  const setup = assistant.setup;
  const setupReady = !setup || setup.state === "ready";
  const emptyState = useMemo(
    () => (opening
      ? ({ fill }: { fill: (text: string) => void }) => (
        <AssistantOpening onSuggestion={fill} suggestionsDisabled={!setupReady} />
      )
      : undefined),
    [opening, setupReady],
  );

  if (assistant.error) {
    return (
      <>
        {embedded ? null : <AssistantPageCrumb />}
        <AssistantUnavailable message={assistant.error.message} onRetry={assistant.retry} />
      </>
    );
  }
  if (assistant.loading || !assistant.agent) {
    return (
      <>
        {embedded ? null : <AssistantPageCrumb />}
        <p className="p-4 text-sm text-muted-foreground">Loading Assistant…</p>
      </>
    );
  }
  return (
    <TaskDetailSurface
      key={`${assistant.agent.id}:${assistant.userId}`}
      conversation={{
        agent: assistant.agent,
        issue: assistant.conversationIssue,
        ensureIssue: assistant.ensureIssue,
        commentMetadata,
        onCommentSent,
        embedded,
        focusComposerRequest: embedded ? shell?.dockFocusRequest : undefined,
        emptyState,
        composerReplacement: !setupReady && setup && selectedCompanyId
          ? <AssistantSetupCard companyId={selectedCompanyId} agentId={assistant.agent.id} setup={setup} />
          : undefined,
      }}
    />
  );
}

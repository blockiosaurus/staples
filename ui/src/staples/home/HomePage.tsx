import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ASSISTANT_BUILT_IN_AGENT_KEY,
  ASSISTANT_WEEKLY_UPDATE_ROUTINE_KEY,
  weeklyUpdateDismissalKey,
  type BriefingItem,
  type RoutineRun,
} from "@paperclipai/shared";
import { Loader2, Newspaper, RotateCw, Send } from "lucide-react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { artifactsApi } from "@/api/artifacts";
import { briefingApi } from "@/api/briefing";
import { budgetsApi } from "@/api/budgets";
import { builtInAgentsApi } from "@/api/builtInAgents";
import { inboxDismissalsApi } from "@/api/inboxDismissals";
import { issuesApi } from "@/api/issues";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useActiveCompanyPrefix } from "@/lib/router";
import { useAskAssistant } from "@/staples/assistant/AssistantProvider";
import { assistantUnavailableNotice } from "@/staples/assistant/unavailableNotice";
import { BriefingCompactRow, BriefingRow, canAcceptInline } from "./BriefingRow";
import { spendLineText } from "./spendLine";
import { WeeklyUpdateCard } from "./WeeklyUpdateCard";

export const BRIEFING_REFETCH_INTERVAL_MS = 30_000;
/**
 * While the document is hidden, Home still polls, but slowly. Real tabs catch
 * up the moment they become visible (live updates reconcile every active
 * query); this only keeps a page that stays hidden, like an embedded browser
 * pane, from showing its first load forever.
 */
export const BRIEFING_HIDDEN_REFETCH_INTERVAL_MS = 300_000;

const MADE_RECENTLY_LIMIT = 6;

export function briefingRefetchInterval(): number {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
    ? BRIEFING_HIDDEN_REFETCH_INTERVAL_MS
    : BRIEFING_REFETCH_INTERVAL_MS;
}

/** Kinds whose row is about something that went wrong rather than a decision. */
const FIX_KINDS = new Set<BriefingItem["kind"]>(["failed_run", "agent_error", "budget_incident"]);

function needsYouSummary(count: number): string {
  if (count === 0) return "Nothing needs you";
  return count === 1 ? "1 thing needs you" : `${count} things need you`;
}

/** Rows are keyed by kind and id: ids from different sources may collide. */
export function briefingItemKey(item: Pick<BriefingItem, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

function inProgressSummary(count: number): string {
  return count === 0 ? "Nothing in progress" : `${count} in progress`;
}

function acceptErrorMessage(error: unknown): string {
  const reason = error instanceof Error && error.message ? error.message : "Something went wrong.";
  return `Couldn't accept the recommendation: ${reason} Open it to answer there.`;
}

/** Plain copy for the fix failures the server explains; its own text is the fallback. */
const KNOWN_FIX_FAILURES: Array<[RegExp, string]> = [
  [/resolve unpriced usage/i, "Some recent usage has no price yet. Check it on the Costs page, then try again."],
  [/completed runs must finish accounting/i, "Recent runs are still being added up. Try again in a minute."],
  [/new budget must exceed current observed spend/i, "The new limit has to be more than what's already been spent."],
  [/budget incident not found/i, "This limit was already handled. Refresh to see the latest."],
  [/hosted limit is already at its maximum/i, "This hosted limit is already as high as it can go."],
];

function fixErrorMessage(item: BriefingItem, error: unknown): string {
  const raw = error instanceof Error && error.message ? error.message : "";
  const reason = KNOWN_FIX_FAILURES.find(([pattern]) => pattern.test(raw))?.[1] ?? (raw || "Something went wrong.");
  const verb = item.action?.label ?? "fix this";
  return `Couldn't ${verb.toLowerCase()}: ${reason} Ask the Assistant for help.`;
}

/** Runs a row's fix with the same endpoints the agent and Costs pages use. */
function runFix(companyId: string, item: BriefingItem, amountCents?: number): Promise<unknown> {
  const action = item.action;
  switch (action?.kind) {
    case "retry_run":
      if (action.agentId && action.runId) return agentsApi.retryFailedRun(action.agentId, action.runId, companyId);
      break;
    case "resume_agent":
      if (action.agentId) return agentsApi.resume(action.agentId, companyId);
      break;
    case "clear_agent_error":
      if (action.agentId) return agentsApi.clearError(action.agentId, companyId);
      break;
    case "raise_budget":
      if (action.budget && amountCents !== undefined) {
        return budgetsApi.resolveIncident(companyId, action.budget.incidentId, {
          action: "raise_budget_and_resume",
          amount: amountCents,
        });
      }
      break;
    default:
      break;
  }
  return Promise.reject(new Error("This can't be fixed from Home."));
}

/** Resolves a briefing item with its recommendation, using the same endpoints as the task thread. */
function acceptRecommendation(item: BriefingItem): Promise<unknown> {
  const recommendation = item.recommendation;
  if (!item.issueId || !recommendation || !canAcceptInline(item)) {
    return Promise.reject(new Error("This item must be answered from its page."));
  }
  if (item.kind === "question") {
    return issuesApi.respondToInteraction(item.issueId, item.id, {
      answers: (recommendation.answers ?? []).map((answer) => ({
        questionId: answer.questionId,
        optionIds: answer.optionIds ?? [],
        ...(answer.text !== undefined ? { otherText: answer.text } : {}),
      })),
    });
  }
  return issuesApi.acceptInteraction(item.issueId, item.id);
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Same wording the Assistant composer uses when it can't take a message. */
export const ASK_UNAVAILABLE_NOTICE = assistantUnavailableNotice("your message is in the box to send later.");

/** What "Update me now" says once the Assistant has started (or was already writing) the update. */
export const UPDATE_NOW_STARTED_NOTICE = "Writing your update now. It shows here when it's ready.";
export const UPDATE_NOW_ALREADY_RUNNING_NOTICE = "An update is already being written.";

/** "Update me now" runs the weekly update routine; a skipped or coalesced run means one is already underway. */
export function updateNowNotice(run: Pick<RoutineRun, "status"> | null | undefined): string {
  return run?.status === "skipped" || run?.status === "coalesced"
    ? UPDATE_NOW_ALREADY_RUNNING_NOTICE
    : UPDATE_NOW_STARTED_NOTICE;
}

/**
 * Whether this person can change things in the company (not a viewer). Viewers
 * can read, but get no "Update me now" and no fixes (Resume, Dismiss error,
 * Raise limit): the server would refuse them.
 */
export function canRequestWeeklyUpdate(companyId: string, access: CurrentBoardAccess | undefined): boolean {
  if (!companyId || !access) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  if (!access.memberships || access.memberships.length === 0) return access.companyIds.includes(companyId);
  const membership = access.memberships.find((item) => item.companyId === companyId && item.status === "active");
  return Boolean(membership && membership.membershipRole !== "viewer");
}

function AskComposer({ companyId, canUpdateNow }: { companyId: string; canUpdateNow: boolean }) {
  const askAssistant = useAskAssistant();
  const [text, setText] = useState("");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const trimmed = text.trim();
  // Runs the Assistant's weekly update routine now: a weekly update run that
  // reads only company-visible work, never a chat with this person's access.
  const updateNow = useMutation({
    mutationFn: () =>
      builtInAgentsApi.runRoutine(companyId, ASSISTANT_BUILT_IN_AGENT_KEY, ASSISTANT_WEEKLY_UPDATE_ROUTINE_KEY) as Promise<RoutineRun>,
    onMutate: () => setUpdateNotice(null),
    onSuccess: (run) => setUpdateNotice({ text: updateNowNotice(run), failed: false }),
    onError: (error) => {
      const reason = error instanceof Error && error.message ? error.message : "Something went wrong.";
      setUpdateNotice({ text: `Couldn't start the update: ${reason}`, failed: true });
    },
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed) return;
    // Clear only once the Assistant took the message; otherwise keep it here.
    if (askAssistant({ text: trimmed, send: true })) {
      setText("");
      setUnavailable(null);
    } else {
      setUnavailable(ASK_UNAVAILABLE_NOTICE);
    }
  };
  return (
    <Section
      title="Ask the Assistant"
      action={
        canUpdateNow ? (
          <Button type="button" variant="ghost" size="xs" disabled={updateNow.isPending} onClick={() => updateNow.mutate()}>
            {updateNow.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Newspaper aria-hidden="true" />}
            Update me now
          </Button>
        ) : undefined
      }
    >
      {unavailable ? (
        <p role="alert" className="text-sm text-destructive">
          {unavailable}
        </p>
      ) : null}
      {updateNotice ? (
        <p
          role={updateNotice.failed ? "alert" : "status"}
          className={updateNotice.failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          data-testid="update-now-notice"
        >
          {updateNotice.text}
        </p>
      ) : null}
      <form className="flex items-end gap-2" onSubmit={submit}>
        <Textarea
          aria-label="Ask the Assistant"
          placeholder="Ask about your company, or tell the Assistant what to do next"
          rows={1}
          className="min-h-9 resize-none"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={!trimmed}>
          <Send aria-hidden="true" />
          Send
        </Button>
      </form>
    </Section>
  );
}

/** `/:prefix/home`: what needs the person, what is moving, and what finished recently. */
export function HomePage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyPrefix = useActiveCompanyPrefix();
  const queryClient = useQueryClient();
  const askAssistant = useAskAssistant();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Home" }]);
  }, [setBreadcrumbs]);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });

  const briefingQuery = useQuery({
    queryKey: queryKeys.briefing(companyId),
    queryFn: ({ signal }) => briefingApi.get(companyId, signal),
    enabled: Boolean(selectedCompanyId),
    // Live updates pause while the document is hidden (a background tab, or
    // an embedded browser pane the person isn't looking at), and so does a
    // plain interval. Poll there too, but only at the slow hidden rate, or a
    // page that stays hidden keeps whatever it first loaded, e.g. "Nothing in
    // progress" while agents are running.
    refetchInterval: briefingRefetchInterval,
    refetchIntervalInBackground: true,
  });

  // Latest outputs. Same slow cadence as the briefing; the section only shows
  // once something exists, whatever the signals say.
  const artifactsQuery = useQuery({
    queryKey: queryKeys.artifacts.home(companyId),
    queryFn: () => artifactsApi.list(companyId, { limit: MADE_RECENTLY_LIMIT }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: briefingRefetchInterval,
    refetchIntervalInBackground: true,
  });
  const madeRecently = artifactsQuery.data?.artifacts ?? []; // the request already limits to 6, newest first

  // Rows accepted from Home disappear right away; a failure brings the row back with its error.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const accept = useMutation({
    mutationFn: acceptRecommendation,
    onMutate: (item) => {
      const key = briefingItemKey(item);
      setRemoved((current) => new Set(current).add(key));
      setErrors(({ [key]: _cleared, ...rest }) => rest);
    },
    onError: (error, item) => {
      const key = briefingItemKey(item);
      setRemoved((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setErrors((current) => ({ ...current, [key]: acceptErrorMessage(error) }));
    },
    onSuccess: (_result, item) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      if (item.issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(item.issueId) });
    },
  });

  // Per row: fixes on different rows can run at once.
  const [fixing, setFixing] = useState<ReadonlySet<string>>(() => new Set());
  const fix = useMutation({
    mutationFn: ({ item, amountCents }: { item: BriefingItem; amountCents?: number }) =>
      runFix(companyId, item, amountCents),
    onMutate: ({ item }) => {
      const key = briefingItemKey(item);
      setFixing((current) => new Set(current).add(key));
      setErrors(({ [key]: _cleared, ...rest }) => rest);
    },
    onSettled: (_result, _error, { item }) => {
      const key = briefingItemKey(item);
      setFixing((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    onError: (error, { item }) => {
      setErrors((current) => ({ ...current, [briefingItemKey(item)]: fixErrorMessage(item, error) }));
    },
    onSuccess: (_result, { item }) => {
      setRemoved((current) => new Set(current).add(briefingItemKey(item)));
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["costs", companyId] });
    },
  });

  // The weekly update card hides as soon as it is dismissed; a failure brings it back with the error.
  const [dismissedUpdateId, setDismissedUpdateId] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const dismissUpdate = useMutation({
    mutationFn: (documentId: string) => inboxDismissalsApi.dismiss(companyId, weeklyUpdateDismissalKey(documentId)),
    onMutate: (documentId) => {
      setDismissedUpdateId(documentId);
      setDismissError(null);
    },
    onError: (error) => {
      setDismissedUpdateId(null);
      const reason = error instanceof Error && error.message ? error.message : "Something went wrong.";
      setDismissError(`Couldn't dismiss the update: ${reason}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing(companyId) });
    },
  });

  const askAbout = useCallback(
    (item: BriefingItem) =>
      askAssistant({
        text: FIX_KINDS.has(item.kind)
          ? `Help me fix this: ${item.title}${item.reason ? `. ${item.reason}` : ""}`
          : `Help me decide: ${item.title}`,
        context: { label: item.title, href: applyCompanyPrefix(item.href, companyPrefix) },
      }),
    [askAssistant, companyPrefix],
  );

  const briefing = briefingQuery.data;
  const canAct = canRequestWeeklyUpdate(companyId, boardAccessQuery.data);

  if (briefingQuery.isError && !briefing) {
    return (
      <div role="alert" className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 p-4 text-sm">
        <p className="font-medium text-foreground">Your briefing couldn't be loaded.</p>
        <p className="text-muted-foreground">
          {briefingQuery.error instanceof Error ? briefingQuery.error.message : "Try again in a moment."}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void briefingQuery.refetch()}>
          <RotateCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }
  if (!briefing) {
    return <p className="p-4 text-sm text-muted-foreground">Loading your briefing…</p>;
  }

  // A failed background refresh keeps the cached briefing on screen, but says so.
  const refreshFailed = briefingQuery.isError;

  const needsYou = briefing.needsYou.filter((item) => !removed.has(briefingItemKey(item)));
  const hiddenCount = briefing.needsYou.length - needsYou.length;
  const needsYouCount = Math.max(0, briefing.counts.needsYou - hiddenCount);
  const summary = `${needsYouSummary(needsYouCount)} · ${inProgressSummary(briefing.counts.inProgress)}`;
  const weeklyUpdate = briefing.weeklyUpdate && briefing.weeklyUpdate.documentId !== dismissedUpdateId
    ? briefing.weeklyUpdate
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">{selectedCompany?.name ?? "Home"}</h1>
        <p className="text-sm text-muted-foreground" data-testid="briefing-summary">
          {summary}
        </p>
        {briefing.spend ? (
          <Link to="/activity/costs" className="self-start text-sm text-muted-foreground hover:text-foreground hover:underline" data-testid="briefing-spend">
            {spendLineText(briefing.spend)}
          </Link>
        ) : null}
        {refreshFailed ? (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="briefing-refresh-error">
            <span>Couldn't refresh — showing what we had.</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={briefingQuery.isFetching}
              onClick={() => void briefingQuery.refetch()}
            >
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : null}
      </header>

      {weeklyUpdate ? (
        <WeeklyUpdateCard
          update={weeklyUpdate}
          dismissing={dismissUpdate.isPending}
          error={dismissError}
          onDismiss={() => dismissUpdate.mutate(weeklyUpdate.documentId)}
        />
      ) : null}

      <Section title="Needs you">
        {needsYou.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing needs you right now.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {needsYou.map((item) => (
              <BriefingRow
                key={briefingItemKey(item)}
                item={item}
                accepting={accept.isPending && accept.variables !== undefined && briefingItemKey(accept.variables) === briefingItemKey(item)}
                error={errors[briefingItemKey(item)] ?? null}
                onAccept={(target) => accept.mutate(target)}
                onAsk={askAbout}
                fixing={fixing.has(briefingItemKey(item))}
                onFix={canAct ? (target, amountCents) => fix.mutate({ item: target, amountCents }) : undefined}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="In progress">
        {briefing.inProgress.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing in progress.</p>
        ) : (
          <ul className="flex flex-col">
            {briefing.inProgress.map((item) => (
              <BriefingCompactRow key={briefingItemKey(item)} item={item} />
            ))}
          </ul>
        )}
      </Section>

      {briefing.doneRecently.length > 0 ? (
        <Section title="Done recently">
          <ul className="flex flex-col">
            {briefing.doneRecently.map((item) => (
              <BriefingCompactRow key={briefingItemKey(item)} item={item} />
            ))}
          </ul>
        </Section>
      ) : null}

      {madeRecently.length > 0 ? (
        <Section
          title="What we've made"
          action={
            <Link to="/artifacts" className="text-xs text-muted-foreground hover:text-foreground">
              See all
            </Link>
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {madeRecently.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </Section>
      ) : null}

      <AskComposer companyId={companyId} canUpdateNow={canAct} />
    </div>
  );
}

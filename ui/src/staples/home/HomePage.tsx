import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BriefingItem } from "@paperclipai/shared";
import { RotateCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { briefingApi } from "@/api/briefing";
import { issuesApi } from "@/api/issues";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useActiveCompanyPrefix } from "@/lib/router";
import { useAskAssistant } from "@/staples/assistant/AssistantProvider";
import { BriefingCompactRow, BriefingRow, canAcceptInline } from "./BriefingRow";

export const BRIEFING_REFETCH_INTERVAL_MS = 30_000;

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function AskComposer() {
  const askAssistant = useAskAssistant();
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed) return;
    askAssistant({ text: trimmed, send: true });
    setText("");
  };
  return (
    <Section title="Ask the Assistant">
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

  const briefingQuery = useQuery({
    queryKey: queryKeys.briefing(companyId),
    queryFn: () => briefingApi.get(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: BRIEFING_REFETCH_INTERVAL_MS,
  });

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

  const askAbout = useCallback(
    (item: BriefingItem) =>
      askAssistant({
        text: `Help me decide: ${item.title}`,
        context: { label: item.title, href: applyCompanyPrefix(item.href, companyPrefix) },
      }),
    [askAssistant, companyPrefix],
  );

  const briefing = briefingQuery.data;

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

  const needsYou = briefing.needsYou.filter((item) => !removed.has(briefingItemKey(item)));
  const hiddenCount = briefing.needsYou.length - needsYou.length;
  const needsYouCount = Math.max(0, briefing.counts.needsYou - hiddenCount);
  const summary = `${needsYouSummary(needsYouCount)} · ${inProgressSummary(briefing.counts.inProgress)}`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">{selectedCompany?.name ?? "Home"}</h1>
        <p className="text-sm text-muted-foreground" data-testid="briefing-summary">
          {summary}
        </p>
      </header>

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
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="In progress">
        {briefing.inProgress.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing running.</p>
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

      <AskComposer />
    </div>
  );
}

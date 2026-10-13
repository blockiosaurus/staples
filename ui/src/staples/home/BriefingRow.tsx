import { useState, type FormEvent } from "react";
import type { BriefingItem, BriefingItemKind } from "@paperclipai/shared";
import {
  Clock,
  Hourglass,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  Eye,
  Loader2,
  MessageCircleQuestion,
  OctagonAlert,
  Play,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";
import { formatDollars, relativeTime } from "@/lib/utils";

const KIND_ICONS: Record<BriefingItemKind, LucideIcon> = {
  approval: ShieldCheck,
  question: MessageCircleQuestion,
  confirmation: CircleCheckBig,
  blocked_task: OctagonAlert,
  budget_incident: Wallet,
  review: Eye,
  failed_run: CircleX,
  agent_error: TriangleAlert,
  active_task: CircleDot,
  live_run: Play,
  queued_task: Clock,
  waiting_task: Hourglass,
  done_task: CircleCheck,
  agent_actions: Zap,
};

const KIND_LABELS: Record<BriefingItemKind, string> = {
  approval: "Approval",
  question: "Question",
  confirmation: "Confirmation",
  blocked_task: "Blocked task",
  budget_incident: "Budget",
  review: "Review",
  failed_run: "Failed run",
  agent_error: "Agent error",
  active_task: "Task in progress",
  live_run: "Running now",
  queued_task: "Up next",
  waiting_task: "Waiting",
  done_task: "Done",
  agent_actions: "Agent actions",
};

const FAILURE_KINDS = new Set<BriefingItemKind>(["failed_run", "agent_error", "budget_incident"]);

/** True when Home can resolve the item in one click with its recommendation. */
export function canAcceptInline(item: BriefingItem): boolean {
  const recommendation = item.recommendation;
  if (!recommendation?.inline || !item.issueId) return false;
  if (item.kind === "question") return (recommendation.answers?.length ?? 0) > 0;
  if (item.kind === "confirmation") return recommendation.accept === true;
  return false;
}

function KindIcon({ kind }: { kind: BriefingItemKind }) {
  const Icon = KIND_ICONS[kind];
  return (
    <span className="mt-0.5 shrink-0 text-muted-foreground" title={KIND_LABELS[kind]}>
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{KIND_LABELS[kind]}</span>
    </span>
  );
}

function LiveDot() {
  return (
    <span className="relative mt-1.5 flex size-2 shrink-0" aria-label="Running now" role="img">
      <span className="absolute inline-flex size-full animate-pulse rounded-full bg-(--status-agent-running) opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-(--status-agent-running)" />
    </span>
  );
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

/** Whole cents from a dollar amount the person typed; null when it isn't one. */
export function parseDollars(value: string): number | null {
  const trimmed = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/** The small "Raise limit" form: a new amount, then Cancel (left) and Raise limit (right) in one row. */
function RaiseLimitForm({
  limitCents,
  observedCents,
  suggestedCents,
  maxCents,
  hosted,
  pending,
  onCancel,
  onSubmit,
}: {
  limitCents: number;
  observedCents: number;
  suggestedCents: number;
  /** The most it can be raised to (a hosted limit's ceiling); null when there is none. */
  maxCents: number | null;
  hosted: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (amountCents: number) => void;
}) {
  const [draft, setDraft] = useState(() => centsToInput(suggestedCents));
  const cents = parseDollars(draft);
  const tooLow = cents !== null && cents <= observedCents;
  const tooHigh = cents !== null && maxCents !== null && cents > maxCents;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cents === null || tooLow || tooHigh || pending) return;
    onSubmit(cents);
  };
  return (
    <form className="flex flex-col gap-2 rounded-md bg-muted p-3" onSubmit={submit} aria-label="Raise limit">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>{hosted ? "New monthly hosted limit (USD)" : "New limit (USD)"}</span>
        <Input
          aria-label="New limit in dollars"
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Now {formatDollars(limitCents)} · {formatDollars(observedCents)} spent
        {maxCents !== null ? ` · up to ${formatDollars(maxCents)}` : ""}
      </p>
      {cents === null ? (
        <p role="alert" className="text-xs text-destructive">Enter an amount in dollars, like 100.</p>
      ) : tooLow ? (
        <p role="alert" className="text-xs text-destructive">
          The new limit has to be more than the {formatDollars(observedCents)} already spent.
        </p>
      ) : tooHigh && maxCents !== null ? (
        <p role="alert" className="text-xs text-destructive">
          The most this limit can be is {formatDollars(maxCents)}.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={pending || cents === null || tooLow || tooHigh}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Raise limit
        </Button>
      </div>
    </form>
  );
}

/** A "Needs you" row: what it is, why, the recommendation or fix, and what to do about it. */
export function BriefingRow({
  item,
  accepting,
  error,
  onAccept,
  onAsk,
  fixing = false,
  onFix,
}: {
  /** `item.href` is company-relative; the router `Link` adds the company prefix. */
  item: BriefingItem;
  accepting: boolean;
  error: string | null;
  onAccept: (item: BriefingItem) => void;
  onAsk: (item: BriefingItem) => void;
  fixing?: boolean;
  /**
   * Runs the row's fix; `amountCents` is the new limit for "raise_budget".
   * Left out for people who can't make changes (viewers): the fix button is hidden.
   */
  onFix?: (item: BriefingItem, amountCents?: number) => void;
}) {
  const inline = canAcceptInline(item);
  const action = item.action;
  const [raising, setRaising] = useState(false);
  const canRunFix = Boolean(action && (action.kind === "open_settings" || onFix));
  // Something went wrong and Home has no fix this person can run: asking the Assistant is the next step.
  const askLeads = !inline && !canRunFix && FAILURE_KINDS.has(item.kind);
  return (
    <li data-testid="briefing-row" data-item-id={item.id} className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-3">
        <KindIcon kind={item.kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Link to={item.href} className="min-w-0 text-sm font-medium text-foreground hover:underline">
              {item.title}
            </Link>
            <time dateTime={item.createdAt} className="shrink-0 text-xs text-muted-foreground">
              {relativeTime(item.createdAt)}
            </time>
          </div>
          {item.subtitle ? <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p> : null}
          {item.reason ? (
            <p className="text-sm text-muted-foreground" data-testid="briefing-reason">
              {item.reason}
            </p>
          ) : null}
          {item.recommendation ? (
            <p className="self-start rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Recommended: <span className="text-foreground">{item.recommendation.label}</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Actions">
        <Button type="button" variant={askLeads ? "default" : "ghost"} size="xs" onClick={() => onAsk(item)}>
          <Sparkles aria-hidden="true" />
          Ask Assistant
        </Button>
        <Button asChild type="button" variant="outline" size="xs">
          <Link to={item.href}>Open</Link>
        </Button>
        {action?.kind === "open_settings" && action.href ? (
          <Button asChild type="button" size="xs">
            <Link to={action.href}>{action.label}</Link>
          </Button>
        ) : action && onFix && !(action.kind === "raise_budget" && raising) ? (
          <Button
            type="button"
            size="xs"
            disabled={fixing}
            onClick={() => (action.kind === "raise_budget" ? setRaising(true) : onFix(item))}
          >
            {fixing ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {action.label}
          </Button>
        ) : null}
        {inline ? (
          <Button type="button" size="xs" disabled={accepting} onClick={() => onAccept(item)}>
            {accepting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {(item.recommendation?.answers?.length ?? 0) > 1 ? "Accept recommendations" : "Accept recommendation"}
          </Button>
        ) : null}
      </div>
      {action?.kind === "raise_budget" && action.budget && raising && onFix ? (
        <RaiseLimitForm
          limitCents={action.budget.limitCents}
          observedCents={action.budget.observedCents}
          suggestedCents={action.budget.suggestedCents}
          maxCents={action.budget.maxCents ?? null}
          hosted={action.budget.metric === "hosted_billed_cents"}
          pending={fixing}
          onCancel={() => setRaising(false)}
          onSubmit={(amountCents) => onFix(item, amountCents)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** A compact "In progress" / "Done recently" row. */
export function BriefingCompactRow({ item }: { item: BriefingItem }) {
  return (
    <li data-testid="briefing-compact-row" data-item-id={item.id}>
      <Link to={item.href} className="flex items-start gap-3 rounded-md py-2 hover:bg-accent/50">
        {item.kind === "live_run" ? <LiveDot /> : <KindIcon kind={item.kind} />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{item.title}</span>
          {item.label || item.subtitle ? (
            <span className="truncate text-xs text-muted-foreground">
              {[item.label, item.subtitle].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </span>
        <time dateTime={item.createdAt} className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(item.createdAt)}
        </time>
      </Link>
    </li>
  );
}

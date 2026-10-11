import type { BriefingItem, BriefingItemKind } from "@paperclipai/shared";
import {
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
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { relativeTime } from "@/lib/utils";

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
  done_task: CircleCheck,
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
  done_task: "Done",
};

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

/** A "Needs you" row: what it is, the recommendation, and what to do about it. */
export function BriefingRow({
  item,
  accepting,
  error,
  onAccept,
  onAsk,
}: {
  /** `item.href` is company-relative; the router `Link` adds the company prefix. */
  item: BriefingItem;
  accepting: boolean;
  error: string | null;
  onAccept: (item: BriefingItem) => void;
  onAsk: (item: BriefingItem) => void;
}) {
  const inline = canAcceptInline(item);
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
          {item.recommendation ? (
            <p className="self-start rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Recommended: <span className="text-foreground">{item.recommendation.label}</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Actions">
        <Button type="button" variant="ghost" size="xs" onClick={() => onAsk(item)}>
          <Sparkles aria-hidden="true" />
          Ask Assistant
        </Button>
        <Button asChild type="button" variant="outline" size="xs">
          <Link to={item.href}>Open</Link>
        </Button>
        {inline ? (
          <Button type="button" size="xs" disabled={accepting} onClick={() => onAccept(item)}>
            {accepting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Accept recommendation
          </Button>
        ) : null}
      </div>
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
          {item.subtitle ? <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span> : null}
        </span>
        <time dateTime={item.createdAt} className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(item.createdAt)}
        </time>
      </Link>
    </li>
  );
}

import type { BriefingWeeklyUpdate } from "@paperclipai/shared";
import { Newspaper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

/**
 * The Assistant's latest weekly update at the top of Home: its date, the first
 * few lines, and a link to read it. The server only sends one that is under a
 * week old and not dismissed by this person.
 */
export function WeeklyUpdateCard({
  update,
  dismissing,
  error,
  onDismiss,
}: {
  update: BriefingWeeklyUpdate;
  dismissing: boolean;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Weekly update"
      data-testid="weekly-update-card"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Newspaper className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {update.title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss weekly update"
          title="Dismiss"
          disabled={dismissing}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {update.excerpt ? <p className="line-clamp-3 text-sm text-muted-foreground">{update.excerpt}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Link to={update.href} className="self-start text-sm font-medium text-foreground hover:underline">
        Read
      </Link>
    </section>
  );
}

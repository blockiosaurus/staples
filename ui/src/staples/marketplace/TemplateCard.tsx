import type { AgentTemplateSummary } from "@paperclipai/shared";
import { asksText, needsText, templateIcon } from "./templateText";

/** One hireable template: icon, name, tagline, what it needs and what it asks before doing. Opens the detail sheet. */
export function TemplateCard({ template, onOpen }: { template: AgentTemplateSummary; onOpen: (slug: string) => void }) {
  const Icon = templateIcon(template.icon);
  const asks = asksText(template);
  return (
    <li className="flex">
      <button
        type="button"
        onClick={() => onOpen(template.slug)}
        className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${template.name}: ${template.tagline}`}
        data-testid={`template-card-${template.slug}`}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-foreground">{template.name}</span>
          <span className="text-sm text-muted-foreground">{template.tagline}</span>
          <span className="text-xs text-muted-foreground">{needsText(template)}</span>
          {asks ? <span className="text-xs text-muted-foreground">{asks}</span> : null}
        </span>
      </button>
    </li>
  );
}

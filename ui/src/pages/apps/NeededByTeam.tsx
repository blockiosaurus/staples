import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import type { SectionRow, TeamNeed } from "./connector-sections";

export function NeededByTeam<T extends SectionRow>({ needs, renderCard }: { needs: TeamNeed<T>[]; renderCard: (row: T) => ReactNode }) {
  if (needs.length === 0) return null;
  return (
    <section aria-labelledby="connectors-needed-heading" className="space-y-3">
      <h2 id="connectors-needed-heading" className="text-base font-semibold">Needed by your team</h2>
      <div className="space-y-3" role="list" aria-label="Needed connectors">
        {needs.map((need) => (
          <div key={need.kind === "template" ? need.row.key : need.issueHref} role="listitem" className="space-y-1">
            {need.row ? renderCard(need.row) : null}
            <p className="px-1 text-sm text-muted-foreground">
              {need.kind === "template"
                ? `${need.agentName} needs it.${need.why ? ` ${need.why}` : ""}${need.alternatives.length > 0 ? ` Or connect ${need.alternatives.map((row) => row.name).join(" or ")} instead.` : ""}`
                : <>{need.agentName} asked to connect {need.serviceName}. <Link to={need.issueHref} className="underline underline-offset-2">Open the task</Link></>}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

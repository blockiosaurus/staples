import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { briefingApi } from "@/api/briefing";
import { agentsApi } from "@/api/agents";
import { budgetsApi } from "@/api/budgets";
import { queryKeys } from "@/lib/queryKeys";
import { formatDollars } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RaiseLimitForm } from "@/staples/home/BriefingRow";
import { projectedMonthEndCents } from "./projection";

/** The owner's view of spend: one meter, the projection, who spent what, and the limit control. */
export function CostsOverview({ companyId, now = new Date() }: { companyId: string; now?: Date }) {
  const queryClient = useQueryClient();
  const [raising, setRaising] = useState(false);
  const briefing = useQuery({ queryKey: queryKeys.briefing(companyId), queryFn: ({ signal }) => briefingApi.get(companyId, signal) });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const budgets = useQuery({ queryKey: queryKeys.budgets.overview(companyId), queryFn: () => budgetsApi.overview(companyId) });
  const spend = briefing.data?.spend ?? null;
  const hosted = spend !== null && spend.companyBudgetCents === null && spend.hosted !== null;
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.briefing(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  };
  const raise = useMutation({
    mutationFn: async (amount: number) => {
      const incident = budgets.data?.activeIncidents.find((candidate) => candidate.scopeType === "company");
      if (incident) return budgetsApi.resolveIncident(companyId, incident.id, { action: "raise_budget_and_resume", amount });
      return budgetsApi.upsertPolicy(companyId, {
        scopeType: "company",
        scopeId: companyId,
        metric: hosted ? "hosted_billed_cents" : "billed_cents",
        windowKind: "calendar_month_utc",
        amount,
      });
    },
    onSuccess: () => {
      setRaising(false);
      invalidate();
    },
  });

  if (!spend) return null;
  const limitCents = spend.companyBudgetCents ?? spend.hosted?.capCents ?? null;
  const spentCents = hosted ? spend.hosted!.spentCents : spend.monthSpendCents;
  const hostedMax = hosted ? spend.hosted!.maxCents : null;
  const atCeiling = hostedMax !== null && limitCents !== null && limitCents >= hostedMax;
  const percent = limitCents ? Math.min(100, Math.round((spentCents / limitCents) * 100)) : null;
  const projected = projectedMonthEndCents(spend.monthSpendCents, now);
  const rows = [...(agents.data ?? [])]
    .filter((agent) => agent.status !== "terminated")
    .sort((a, b) => b.spentMonthlyCents - a.spentMonthlyCents);

  return (
    <Card data-testid="costs-overview" className="gap-3 py-4">
      <CardHeader className="gap-1 px-5">
        <CardTitle className="text-base">This month</CardTitle>
        <p className="text-sm text-foreground">
          {limitCents !== null
            ? `${formatDollars(spentCents)} of ${formatDollars(limitCents)} this month`
            : `${formatDollars(spentCents)} this month · no limit set`}
        </p>
        {percent !== null ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Spend against limit"
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={percent >= 100 ? "h-full w-(--meter) bg-destructive" : "h-full w-(--meter) bg-primary"}
              style={{ "--meter": `${percent}%` } as CSSProperties}
            />
          </div>
        ) : null}
        {projected !== null ? (
          <p className="text-sm text-muted-foreground">About {formatDollars(Math.round(projected / 100) * 100)} by month end at this pace.</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {rows.length > 0 ? (
          <ul className="divide-y divide-border" aria-label="Spend by agent">
            {rows.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">{agent.name}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  {agent.status === "paused" && agent.pauseReason === "budget" ? <Badge variant="outline">Paused by limit</Badge> : null}
                  {formatDollars(agent.spentMonthlyCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No agents have spent anything yet.</p>
        )}
        {raising ? (
          <RaiseLimitForm
            limitCents={limitCents ?? 0}
            observedCents={spentCents}
            suggestedCents={Math.max(spentCents + 1, (limitCents ?? 0) * 2 || 5000)}
            maxCents={hosted ? spend.hosted!.maxCents : null}
            hosted={hosted}
            pending={raise.isPending}
            onCancel={() => setRaising(false)}
            onSubmit={(amount) => raise.mutate(amount)}
          />
        ) : atCeiling ? (
          <p className="text-sm text-muted-foreground">This limit is as high as it can go.</p>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setRaising(true)}>
              {limitCents !== null ? "Raise limit" : "Set a limit"}
            </Button>
          </div>
        )}
        {raise.isError ? (
          <p role="alert" className="text-sm text-destructive">Couldn't change the limit. Try again in a minute.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

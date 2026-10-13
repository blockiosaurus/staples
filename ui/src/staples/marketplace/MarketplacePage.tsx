import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentTemplateCategory, AgentTemplateSummary } from "@paperclipai/shared";
import { RotateCw, Wrench } from "lucide-react";
import { agentTemplatesApi } from "@/api/agentTemplates";
import { NEW_AGENT_FORM_PARAM_KEYS } from "@/components/new-agent/form-params";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, Navigate, useLocation } from "@/lib/router";
import { TemplateCard } from "./TemplateCard";
import { TemplateDetailSheet } from "./TemplateDetailSheet";
import { MARKETPLACE_CATEGORY_LABELS, MARKETPLACE_CATEGORY_ORDER } from "./templateText";

/** The custom new-agent form (the pre-marketplace `/agents/new`). */
export const CUSTOM_AGENT_PATH = "/agents/new/custom";


/** Templates grouped into marketplace sections, in section order, empty sections dropped. */
export function groupTemplates(
  templates: readonly AgentTemplateSummary[],
): { category: AgentTemplateCategory; templates: AgentTemplateSummary[] }[] {
  return MARKETPLACE_CATEGORY_ORDER.map((category) => ({
    category,
    templates: templates.filter((template) => template.marketplaceCategory === category),
  })).filter((group) => group.templates.length > 0);
}

/** `/:prefix/agents/new`: hire a ready-made agent through the Assistant, or build your own. */
export function MarketplacePage() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  // Old `/agents/new?name=…` links meant the custom form: send them on to it.
  if (NEW_AGENT_FORM_PARAM_KEYS.some((key) => params.has(key))) {
    return <Navigate to={`${CUSTOM_AGENT_PATH}${search}`} replace />;
  }
  return <Marketplace />;
}

function Marketplace() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents", href: "/agents" }, { label: "Hire an agent" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.agentTemplates.list(companyId),
    queryFn: () => agentTemplatesApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
  });
  const groups = useMemo(() => groupTemplates(listQuery.data ?? []), [listQuery.data]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">Hire an agent</h1>
          <p className="text-sm text-muted-foreground">
            Pick a ready-made agent. The Assistant asks a few questions and sets it up with you.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={CUSTOM_AGENT_PATH}>
            <Wrench aria-hidden="true" />
            Build your own
          </Link>
        </Button>
      </header>

      {listQuery.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p className="font-medium text-foreground">The agent list couldn't be loaded.</p>
          <p className="text-muted-foreground">
            {listQuery.error instanceof Error ? listQuery.error.message : "Try again in a moment."}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : !listQuery.data ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No ready-made agents are available yet. <Link to={CUSTOM_AGENT_PATH} className="underline">Build your own</Link>{" "}
          instead.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.category} aria-label={MARKETPLACE_CATEGORY_LABELS[group.category]} className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {MARKETPLACE_CATEGORY_LABELS[group.category]}
            </h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.templates.map((template) => (
                <TemplateCard key={template.ref} template={template} onOpen={setOpenSlug} />
              ))}
            </ul>
          </section>
        ))
      )}

      {companyId ? <TemplateDetailSheet companyId={companyId} slug={openSlug} onClose={() => setOpenSlug(null)} /> : null}
    </div>
  );
}

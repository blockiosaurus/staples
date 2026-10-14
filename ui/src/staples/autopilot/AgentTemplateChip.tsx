import { useQuery } from "@tanstack/react-query";
import { agentTemplatesApi } from "@/api/agentTemplates";
import { queryKeys } from "@/lib/queryKeys";
import { agentTemplateRecord } from "./templateRecord";

/** "Ready-made: <name>" for agents hired from a template (version in the tooltip); nothing otherwise. */
export function AgentTemplateChip({ agent, companyId }: { agent: { metadata?: unknown }; companyId: string | null | undefined }) {
  const record = agentTemplateRecord(agent.metadata);
  const templates = useQuery({
    queryKey: queryKeys.agentTemplates.list(companyId ?? ""),
    queryFn: () => agentTemplatesApi.list(companyId!),
    enabled: Boolean(record && companyId),
    staleTime: 5 * 60 * 1000,
  });
  if (!record) return null;
  // Preview or retired templates are not listed: fall back to the ref's slug.
  const name = templates.data?.find((template) => template.ref === record.ref)?.name ?? record.slug;
  return (
    <span
      data-testid="agent-template-chip"
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      title={record.version ? `Template version ${record.version}` : undefined}
    >
      Ready-made: {name}
    </span>
  );
}

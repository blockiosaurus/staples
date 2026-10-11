import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentAutopilotCategory, AgentAutopilotMode, AgentAutopilotState } from "@paperclipai/shared";
import { agentAutopilotApi } from "@/api/agentAutopilot";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { appChoices } from "@/staples/marketplace/templateText";
import { agentTemplateRecord } from "./templateRecord";

export const AUTOPILOT_MODE_LABELS: Record<AgentAutopilotMode, string> = {
  ask: "Ask first",
  auto: "Send without asking",
};

const MODES: readonly AgentAutopilotMode[] = ["ask", "auto"];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** "Ask first / Send without asking" as a two-option radio group. */
function ModeControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: AgentAutopilotMode;
  disabled: boolean;
  onChange: (mode: AgentAutopilotMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn("inline-flex shrink-0 rounded-md border border-border bg-muted p-0.5", disabled && "opacity-60")}
    >
      {MODES.map((mode) => {
        const checked = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(mode);
            }}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
              checked ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {AUTOPILOT_MODE_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}

function CategoryRow({
  category,
  anyOf,
  pending,
  error,
  onChange,
}: {
  category: AgentAutopilotCategory;
  anyOf: string[];
  pending: boolean;
  error: string | null;
  onChange: (mode: AgentAutopilotMode) => void;
}) {
  const connectLabel = anyOf.length ? appChoices(anyOf) : "an app";
  // A stale marker never applies: the control shows what the agent actually does.
  const mode: AgentAutopilotMode = category.stale ? "ask" : category.mode;
  return (
    <li data-testid={`autopilot-row-${category.capability}`} className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-foreground">{category.label}</span>
          {category.connection ? (
            <span className="text-xs text-muted-foreground">Using {category.connection.displayName}</span>
          ) : (
            <Link to="/apps" className="text-xs text-foreground underline underline-offset-4 hover:text-muted-foreground">
              Connect {connectLabel} first
            </Link>
          )}
          {category.stale ? (
            <span className="text-xs text-muted-foreground">
              {category.connection
                ? `Autopilot needs to be turned on again for ${category.connection.displayName}`
                : `Autopilot needs to be turned on again once ${connectLabel} is connected`}
            </span>
          ) : null}
        </div>
        <ModeControl
          label={category.label}
          value={mode}
          disabled={!category.canToggle || pending}
          onChange={onChange}
        />
      </div>
      {category.destructiveLabel ? (
        <div data-testid={`autopilot-destructive-${category.capability}`} className="flex flex-wrap items-center justify-between gap-3 pl-3">
          <span className="text-xs text-muted-foreground">{category.destructiveLabel}</span>
          <span className="text-xs font-medium text-muted-foreground">Always asks</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Autopilot for a templated agent: per outward category, whether the agent
 * asks first or acts on its own. Destructive actions always ask.
 */
export function AutopilotPanel({ agent }: { agent: { id: string; name: string; metadata?: unknown } }) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agentAutopilot(agent.id);
  const record = agentTemplateRecord(agent.metadata);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [pendingCapabilities, setPendingCapabilities] = useState<ReadonlySet<string>>(() => new Set());
  const setPending = (capability: string, pending: boolean) =>
    setPendingCapabilities((current) => {
      const next = new Set(current);
      if (pending) next.add(capability);
      else next.delete(capability);
      return next;
    });

  const state = useQuery({
    queryKey,
    queryFn: () => agentAutopilotApi.get(agent.id),
    enabled: record !== null,
  });

  const updateCategory = (capability: string, update: (category: AgentAutopilotCategory) => AgentAutopilotCategory) => {
    queryClient.setQueryData<AgentAutopilotState>(queryKey, (current) => current && {
      ...current,
      categories: current.categories.map((category) => (category.capability === capability ? update(category) : category)),
    });
  };

  const mutationKey = ["agent-autopilot-set", agent.id] as const;
  const toggle = useMutation({
    mutationKey,
    mutationFn: ({ capability, mode }: { capability: string; mode: AgentAutopilotMode }) =>
      agentAutopilotApi.setMode(agent.id, capability, mode),
    onMutate: async ({ capability, mode }) => {
      setPending(capability, true);
      setErrors((current) => ({ ...current, [capability]: null }));
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<AgentAutopilotState>(queryKey)
        ?.categories.find((category) => category.capability === capability);
      updateCategory(capability, (category) => ({ ...category, mode, stale: false }));
      return { previous };
    },
    onError: (error, { capability }, context) => {
      // Roll back only this category; other toggles may be in flight.
      const previous = context?.previous;
      if (previous) updateCategory(capability, () => previous);
      setErrors((current) => ({ ...current, [capability]: errorText(error, "Autopilot could not be changed. Try again.") }));
    },
    onSettled: (_data, _error, { capability }) => {
      setPending(capability, false);
      // Refetch once the last in-flight change settles, so a refetch never
      // overwrites another category's optimistic value.
      if (queryClient.isMutating({ mutationKey }) <= 1) void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (!record) {
    return (
      <p className="text-sm text-muted-foreground">
        Autopilot is available for agents hired from a template.
      </p>
    );
  }

  if (state.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading Autopilot…</p>;
  }

  if (state.isError || !state.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {errorText(state.error, "Autopilot settings could not be loaded.")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void state.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const categories = state.data.categories;
  return (
    <section className="flex max-w-3xl flex-col gap-2" aria-label="Autopilot">
      <p className="text-sm text-muted-foreground">
        Choose what {agent.name} may do without asking you first. Destructive actions always ask.
      </p>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {agent.name} has no outward actions to put on Autopilot.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {categories.map((category) => (
            <CategoryRow
              key={category.capability}
              category={category}
              anyOf={record.requiredApps.find((app) => app.capability === category.capability)?.anyOf ?? []}
              pending={pendingCapabilities.has(category.capability)}
              error={errors[category.capability] ?? null}
              onChange={(mode) => toggle.mutate({ capability: category.capability, mode })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

import { useState, type ReactNode } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, RotateCw } from "lucide-react";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { AdapterMark } from "@/components/AdapterMark";
import { AgentProviderConnection, type ProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { Button } from "@/components/ui/button";
import { agentsApi } from "@/api/agents";
import {
  ASSISTANT_RUNTIME_ADAPTER_TYPES,
  assistantApi,
  type AssistantRuntimeAdapterType,
  type AssistantSetup,
  type AssistantSummary,
} from "@/api/assistant";
import { queryKeys } from "@/lib/queryKeys";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { cn } from "@/lib/utils";

const LABELS: Record<AssistantRuntimeAdapterType, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  kimi_local: "Kimi",
};

/** Adapters whose CLI engine still gives the Assistant its tools (server: ASSISTANT_CLI_ENGINE_ADAPTER_TYPES). */
const CLI_ENGINE_TYPES: readonly string[] = ["claude_local", "codex_local"];
/** Adapters with a login/API-key flow in AgentProviderConnection. */
const PROVIDER_CONNECTION_TYPES = ["claude_local", "codex_local"] as const;
type ProviderConnectionType = (typeof PROVIDER_CONNECTION_TYPES)[number];

export interface AssistantAdapterProbe {
  installed: boolean;
  /** The ACP prerequisites are missing, so this adapter runs on its CLI engine. */
  acpUnavailable: boolean;
  /** A short reason when it is not installed. */
  detail: string | null;
}

function hasCheck(result: AdapterEnvironmentTestResult, test: (code: string) => boolean) {
  return result.checks.some((check) => test(check.code));
}

/** Whether the host can run an adapter, using its environment test (CLI engine when ACP is missing). */
export async function probeAssistantAdapter(companyId: string, adapterType: AssistantRuntimeAdapterType): Promise<AssistantAdapterProbe> {
  let result = await agentsApi.testEnvironment(companyId, adapterType, { adapterConfig: {} });
  let acpUnavailable = false;
  if (hasCheck(result, (code) => code === "adapter_engine_unavailable") && CLI_ENGINE_TYPES.includes(adapterType)) {
    acpUnavailable = true;
    result = await agentsApi.testEnvironment(companyId, adapterType, { adapterConfig: { engine: "cli" } });
  }
  const installed = !hasCheck(result, (code) => /_command_unresolvable$/.test(code) || code === "adapter_engine_unavailable");
  const problem = result.checks.find((check) => check.level === "error");
  return { installed, acpUnavailable, detail: installed ? null : problem?.message ?? null };
}

function blockingCheckMessage(result: AdapterEnvironmentTestResult) {
  return (
    result.checks.find((check) => check.level === "error")
    ?? result.checks.find((check) => check.code.includes("hello_probe") && check.level === "warn")
  )?.message ?? null;
}

function SetupFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      data-testid="assistant-setup-card"
      aria-label="Set up the Assistant"
      className={cn("mx-auto w-full max-w-(--tc-shell-max-w) rounded-xl border border-border bg-card p-4 text-sm", className)}
    >
      {children}
    </section>
  );
}

/**
 * Shown in the Assistant conversation instead of the composer until the
 * Assistant can answer: connect a model, wait for it to start, or retry.
 */
export function AssistantSetupCard({
  companyId,
  agentId,
  setup,
}: {
  companyId: string;
  agentId: string;
  setup: AssistantSetup;
}) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const summaryKey = queryKeys.assistant.detail(companyId);

  if (setup.state === "starting") {
    return (
      <SetupFrame>
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Getting the Assistant ready…
        </p>
      </SetupFrame>
    );
  }

  if (setup.state === "error") {
    const retry = async () => {
      setRetrying(true);
      setRetryError(null);
      try {
        await agentsApi.retryLifecycle(agentId, companyId);
        await queryClient.invalidateQueries({ queryKey: summaryKey });
      } catch (cause) {
        setRetryError(cause instanceof Error ? cause.message : "Could not retry.");
      } finally {
        setRetrying(false);
      }
    };
    return (
      <SetupFrame>
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="font-medium text-foreground">The Assistant couldn't start.</p>
          {setup.message ? <p className="text-muted-foreground">{setup.message}</p> : null}
          {retryError ? <p className="text-destructive">{retryError}</p> : null}
          <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
            Retry
          </Button>
        </div>
      </SetupFrame>
    );
  }

  if (setup.state !== "needs_model") return null;
  return (
    <SetupFrame>
      <ConnectModel
        companyId={companyId}
        onConfigured={(result) => {
          queryClient.setQueryData<AssistantSummary>(summaryKey, (current) =>
            current ? { ...current, agent: { ...current.agent, ...result.agent }, setup: result.setup } : current);
          void queryClient.invalidateQueries({ queryKey: summaryKey });
        }}
      />
    </SetupFrame>
  );
}

function ConnectModel({
  companyId,
  onConfigured,
}: {
  companyId: string;
  onConfigured: (result: Pick<AssistantSummary, "agent" | "setup">) => void;
}) {
  const [selected, setSelected] = useState<AssistantRuntimeAdapterType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const probes = useQueries({
    queries: ASSISTANT_RUNTIME_ADAPTER_TYPES.map((adapterType) => ({
      queryKey: ["assistant", "adapter-probe", companyId, adapterType] as const,
      queryFn: () => probeAssistantAdapter(companyId, adapterType),
      staleTime: Infinity,
      retry: false,
    })),
  });
  const probeFor = (adapterType: AssistantRuntimeAdapterType) =>
    probes[ASSISTANT_RUNTIME_ADAPTER_TYPES.indexOf(adapterType)];

  const engineConfig = (adapterType: AssistantRuntimeAdapterType) =>
    probeFor(adapterType)?.data?.acpUnavailable ? { engine: "cli" as const } : {};

  async function submit(adapterType: AssistantRuntimeAdapterType, connection?: ProviderConnection) {
    setSubmitting(true);
    setError(null);
    try {
      const env = connection?.env && Object.keys(connection.env).length > 0 ? connection.env : undefined;
      const adapterConfig = { ...engineConfig(adapterType), ...(env ? { env } : {}) };
      const result = await assistantApi.setup(companyId, {
        adapterType,
        ...(Object.keys(adapterConfig).length > 0 ? { adapterConfig } : {}),
        ...(connection?.aiConnection ? { aiConnection: connection.aiConnection } : {}),
        ...(connection?.applyStoredClaudeLogin ? { applyStoredClaudeLogin: true } : {}),
      });
      onConfigured(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect the model.");
    } finally {
      setSubmitting(false);
    }
  }

  async function testConnection(adapterType: ProviderConnectionType, connection: ProviderConnection) {
    setTestError(null);
    const result = await testAgentSetup({
      companyId,
      adapterType,
      providerAdapter: adapterType,
      adapterConfig: { ...engineConfig(adapterType), env: connection.env },
      aiConnection: connection.aiConnection,
      testCredentials: connection.credentials,
      environmentId: null,
    });
    const passed = result.status !== "fail" && result.checks.some((check) => /hello_probe_(passed|succeeded)$/.test(check.code));
    if (!passed) setTestError(blockingCheckMessage(result));
    return passed;
  }

  if (selected && (PROVIDER_CONNECTION_TYPES as readonly string[]).includes(selected)) {
    const adapterType = selected as ProviderConnectionType;
    return (
      <div className="flex flex-col gap-3">
        <AgentProviderConnection
          companyId={companyId}
          adapterType={adapterType}
          environmentId={null}
          canLogin={false}
          localEnvironment
          onBack={() => setSelected(null)}
          testConnection={(connection) => testConnection(adapterType, connection)}
          testError={testError}
          onConnected={(connection) => void submit(adapterType, connection)}
        />
        {submitting ? (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Connecting…
          </p>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setSelected(null)}>
          <ArrowLeft className="size-3.5" /> Choose another model
        </Button>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-foreground">
          The Assistant will use {LABELS[selected]} with the sign-in already set up on this computer.
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={submitting} onClick={() => void submit(selected)}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Use {LABELS[selected]}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => setSelected(null)}>
            Back
          </Button>
        </div>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-foreground">Connect a model to start</p>
        <p className="text-muted-foreground">The Assistant runs on an AI model installed on this computer. Choose one to connect.</p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ASSISTANT_RUNTIME_ADAPTER_TYPES.map((adapterType) => {
          const probe = probeFor(adapterType);
          const status = probe?.isPending ? "Checking…" : probe?.isError ? "Couldn't check" : probe?.data?.installed ? "Installed" : "Not installed";
          const available = probe?.data?.installed === true;
          return (
            <li key={adapterType}>
              <button
                type="button"
                disabled={!available}
                onClick={() => setSelected(adapterType)}
                title={probe?.data?.detail ?? undefined}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <AdapterMark type={adapterType} className="size-5" />
                <span className="min-w-0 flex-1 font-medium">{LABELS[adapterType]}</span>
                <span className={cn("text-xs", available ? "text-foreground" : "text-muted-foreground")}>{status}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

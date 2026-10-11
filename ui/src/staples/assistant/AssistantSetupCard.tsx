import { Fragment, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, RefreshCw, RotateCw } from "lucide-react";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { AdapterMark } from "@/components/AdapterMark";
import { AgentProviderConnection, type ProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { Button } from "@/components/ui/button";
import { agentsApi } from "@/api/agents";
import {
  assistantApi,
  type AssistantAdapterAvailability,
  type AssistantRuntimeAdapterType,
  type AssistantSetup,
  type AssistantSummary,
} from "@/api/assistant";
import { queryKeys } from "@/lib/queryKeys";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { cn } from "@/lib/utils";
import { ASSISTANT_ADAPTER_LABELS, connectionFailureReason, connectionTestPassed } from "./setup-reasons";

/** Adapters with a login/API-key flow in AgentProviderConnection. */
const PROVIDER_CONNECTION_TYPES = ["claude_local", "codex_local"] as const;
type ProviderConnectionType = (typeof PROVIDER_CONNECTION_TYPES)[number];
/** Adapters whose CLI engine still gives the Assistant its tools (server: ASSISTANT_CLI_ENGINE_ADAPTER_TYPES). */
const CLI_ENGINE_TYPES: readonly string[] = ["claude_local", "codex_local"];

const label = (adapterType: string) => ASSISTANT_ADAPTER_LABELS[adapterType] ?? adapterType;
const codesOf = (result: AdapterEnvironmentTestResult) => result.checks.map((check) => check.code);

/** Renders `code` spans from the server's fixed hint copy. */
function HintText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.startsWith("`") && part.endsWith("`")
          ? <code key={index} className="rounded bg-muted px-1 font-mono text-[0.85em]">{part.slice(1, -1)}</code>
          : <Fragment key={index}>{part}</Fragment>,
      )}
    </>
  );
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
 * Viewers only see what is wrong and who can fix it.
 */
export function AssistantSetupCard({
  companyId,
  agentId,
  setup,
  canConfigure = true,
}: {
  companyId: string;
  agentId: string;
  setup: AssistantSetup;
  canConfigure?: boolean;
}) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const summaryKey = queryKeys.assistant.detail(companyId);

  if (setup.state === "ready") return null;
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

  const reason = setup.reason ? <p className="text-muted-foreground">{setup.reason}</p> : null;
  if (!canConfigure) {
    return (
      <SetupFrame>
        <div role="status" className="flex flex-col gap-1">
          <p className="font-medium text-foreground">
            {setup.state === "needs_model" ? "The Assistant needs a model." : setup.message ?? "The Assistant couldn't start."}
          </p>
          {reason}
          <p className="text-muted-foreground">Ask an owner to connect a model.</p>
        </div>
      </SetupFrame>
    );
  }

  const connect = (
    <ConnectModel
      companyId={companyId}
      onConfigured={(result) => {
        queryClient.setQueryData<AssistantSummary>(summaryKey, (current) =>
          current ? { ...current, agent: { ...current.agent, ...result.agent }, setup: result.setup } : current);
        void queryClient.invalidateQueries({ queryKey: summaryKey });
      }}
    />
  );

  if (setup.state === "needs_model") {
    return (
      <SetupFrame>
        <div className="flex flex-col gap-3">
          {reason}
          {connect}
        </div>
      </SetupFrame>
    );
  }

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
  // A failed connection test comes with a fixed-copy reason: offer to connect a model too.
  const harnessFailure = Boolean(setup.reason);
  return (
    <SetupFrame>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-start gap-2">
          <p className="font-medium text-foreground">{setup.message ?? "The Assistant couldn't start."}</p>
          {reason}
          {retryError ? <p role="alert" className="text-destructive">{retryError}</p> : null}
          <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
            Retry
          </Button>
        </div>
        {harnessFailure ? connect : null}
      </div>
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
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  // Set when the chosen adapter's full test found the ACP engine unavailable. A
  // ref: AgentProviderConnection calls onConnected from the closure that ran the test.
  const engineOverride = useRef<"cli" | null>(null);
  const adapters = useQuery({
    queryKey: ["assistant", "adapters", companyId] as const,
    queryFn: () => assistantApi.adapters(companyId),
    retry: false,
  });
  const entry = (adapterType: string): AssistantAdapterAvailability | undefined =>
    adapters.data?.adapters.find((item) => item.adapterType === adapterType);
  const engineFor = (adapterType: AssistantRuntimeAdapterType) =>
    engineOverride.current ?? entry(adapterType)?.engine ?? null;

  const choose = (adapterType: AssistantRuntimeAdapterType | null) => {
    setSelected(adapterType);
    engineOverride.current = null;
    setError(null);
    setTestError(null);
  };

  async function submit(adapterType: AssistantRuntimeAdapterType, connection?: ProviderConnection, engine = engineFor(adapterType)) {
    setSubmitting(true);
    setError(null);
    try {
      const env = connection?.env && Object.keys(connection.env).length > 0 ? connection.env : undefined;
      const adapterConfig = { ...(engine ? { engine } : {}), ...(env ? { env } : {}) };
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

  /**
   * The full test (hello probe), for the chosen adapter only. Retries on the
   * CLI engine when the ACP engine is unavailable and that engine carries the
   * Assistant's tools. Returns the engine that passed, or null on failure.
   */
  async function fullTest(
    adapterType: AssistantRuntimeAdapterType,
    run: (engine: "cli" | null) => Promise<AdapterEnvironmentTestResult>,
  ): Promise<{ passed: boolean; engine: "cli" | null; codes: string[] }> {
    let engine = engineFor(adapterType);
    let result = await run(engine);
    if (!engine && CLI_ENGINE_TYPES.includes(adapterType) && codesOf(result).includes("adapter_engine_unavailable")) {
      engine = "cli";
      engineOverride.current = "cli";
      result = await run(engine);
    }
    return { passed: connectionTestPassed(result), engine, codes: codesOf(result) };
  }

  async function testConnection(adapterType: ProviderConnectionType, connection: ProviderConnection) {
    setTestError(null);
    const outcome = await fullTest(adapterType, (engine) => testAgentSetup({
      companyId,
      adapterType,
      providerAdapter: adapterType,
      adapterConfig: { ...(engine ? { engine } : {}), env: connection.env },
      aiConnection: connection.aiConnection,
      testCredentials: connection.credentials,
      environmentId: null,
    }));
    if (!outcome.passed) setTestError(connectionFailureReason(adapterType, outcome.codes));
    return outcome.passed;
  }

  async function checkAndUse(adapterType: AssistantRuntimeAdapterType) {
    setChecking(true);
    setError(null);
    try {
      const outcome = await fullTest(adapterType, (engine) =>
        agentsApi.testEnvironment(companyId, adapterType, { adapterConfig: engine ? { engine } : {} }));
      if (!outcome.passed) {
        setError(connectionFailureReason(adapterType, outcome.codes));
        return;
      }
      await submit(adapterType, undefined, outcome.engine);
    } catch {
      setError(`Couldn't test ${label(adapterType)}. Check again.`);
    } finally {
      setChecking(false);
    }
  }

  const chooseAnother = (
    <Button type="button" variant="ghost" size="sm" className="self-start" disabled={submitting || checking} onClick={() => choose(null)}>
      <ArrowLeft className="size-3.5" /> Choose another model
    </Button>
  );

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
          hideBack
          onBack={() => choose(null)}
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
        {chooseAnother}
      </div>
    );
  }

  if (selected) {
    const hint = entry(selected)?.hint;
    const busy = submitting || checking;
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-foreground">
          The Assistant will use {label(selected)} with the sign-in already set up on this computer.
        </p>
        {hint ? <p className="text-muted-foreground"><HintText text={hint} /></p> : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void checkAndUse(selected)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : error ? <RefreshCw className="size-3.5" /> : null}
            {error ? "Check again" : `Use ${label(selected)}`}
          </Button>
        </div>
        {chooseAnother}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">Connect a model to start</p>
          <p className="text-muted-foreground">The Assistant runs on an AI model installed on this computer. Choose one to connect.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={adapters.isFetching}
          onClick={() => void adapters.refetch()}
        >
          <RefreshCw className={cn("size-3.5", adapters.isFetching && "animate-spin")} /> Check again
        </Button>
      </div>
      {adapters.isError ? <p role="alert" className="text-destructive">Couldn't check which models are installed.</p> : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        {(["claude_local", "codex_local", "gemini_local", "kimi_local"] as const).map((adapterType) => {
          const item = entry(adapterType);
          const status = adapters.isPending ? "Checking…"
            : !item ? "Couldn't check"
            : !item.installed ? "Not installed"
            : !item.available ? "Unavailable"
            : item.signedIn ? "Signed in"
            : "Installed";
          return (
            <li key={adapterType}>
              <button
                type="button"
                disabled={!item?.available}
                onClick={() => choose(adapterType)}
                className="flex w-full flex-col gap-1 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <span className="flex w-full items-center gap-3">
                  <AdapterMark type={adapterType} className="size-5" />
                  <span className="min-w-0 flex-1 font-medium">{label(adapterType)}</span>
                  <span className={cn("text-xs", item?.available ? "text-foreground" : "text-muted-foreground")}>{status}</span>
                </span>
                {item?.hint ? (
                  <span className="text-xs text-muted-foreground"><HintText text={item.hint} /></span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

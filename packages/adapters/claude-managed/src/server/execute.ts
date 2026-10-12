import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterUsageCheckpoint,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asString,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;
import { ManagedAgentsApiError, ManagedAgentsClient, budgetFromUsd } from "../client.js";
import {
  DEFAULT_MANAGED_AGENTS_BASE_URL,
  type AgentTool,
  type BudgetLimit,
  type CloudEnvironmentConfig,
  type CloudNetworking,
  type ContentBlock,
  type ManagedAgentsEvent,
  type SessionUsageTotals,
} from "../types.js";
import { readSessionParams, type ClaudeManagedSessionParams } from "./session.js";
import { ToolsProxy, type ToolCallOutcome } from "./tools-proxy.js";

export const ADAPTER_TYPE = "claude_managed";
/** Default model (the current model id used throughout the Managed Agents docs, 2026-10-12). */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const AGENT_TOOLSET_TYPE = "agent_toolset_20260401";
const DEFAULT_CANCEL_GRACE_MS = 3_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Test seams; production calls `execute(ctx)`. */
export interface ExecuteDeps {
  /** fetch for Staples MCP servers (tools proxy). */
  mcpFetch?: FetchLike;
  /** fetch for the Managed Agents API. */
  apiFetch?: FetchLike;
  /** How long a cancelled run waits for the session to go idle after `user.interrupt`. */
  cancelGraceMs?: number;
  /** Server environment (defaults to process.env) for the ANTHROPIC_API_KEY fallback. */
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function readConfigEnvValue(config: Record<string, unknown>, key: string): string {
  const entry = parseObject(config.env)[key];
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") return record.value.trim();
  }
  return "";
}

/** Resolves the Anthropic API key: adapter env (plain or resolved secret) first, then the server env. */
export function resolveApiKey(
  config: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; source: "adapter_config" | "server_env" } | null {
  const fromConfig = readConfigEnvValue(config, "ANTHROPIC_API_KEY");
  if (fromConfig) return { apiKey: fromConfig, source: "adapter_config" };
  const fromEnv = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (fromEnv) return { apiKey: fromEnv, source: "server_env" };
  return null;
}

export function resolveApiBaseUrl(config: Record<string, unknown>): string {
  return asString(config.apiBaseUrl, "").trim() || DEFAULT_MANAGED_AGENTS_BASE_URL;
}

/**
 * Environment networking. Default: `unrestricted`, set explicitly.
 *
 * Why not `limited`: with `limited` networking, `allowed_hosts` also gates the
 * built-in `web_search` / `web_fetch` tools, and an empty list makes both return
 * nothing. A general-purpose agent cannot list its sites in advance, so the most
 * restrictive setting that keeps the built-in web tools working is `unrestricted`.
 * The sandbox holds no Staples credentials (tools are proxied from the Staples host),
 * which limits what an unrestricted sandbox can leak. Operators can opt into
 * `limited` via `adapterConfig.networking = { type: "limited", allowedHosts, allowPackageManagers }`.
 */
export function resolveNetworking(config: Record<string, unknown>): CloudNetworking {
  const raw = parseObject(config.networking);
  if (raw.type === "limited") {
    const allowedHosts = Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0).map((h) => h.trim())
      : [];
    return {
      type: "limited",
      allowed_hosts: allowedHosts,
      allow_package_managers: raw.allowPackageManagers === true,
      allow_mcp_servers: false,
    };
  }
  return { type: "unrestricted" };
}

/**
 * Remaining monthly budget for this agent, in USD, if the run context exposes one.
 * As of 2026-10-12 the host does not put budget data in AdapterExecutionContext, so
 * this reads an optional `context.paperclipBudgetRemainingUsd` number that nothing
 * sets yet; when absent, no session cap is applied.
 */
export function resolveRemainingBudgetUsd(context: Record<string, unknown>): number | null {
  const value = context.paperclipBudgetRemainingUsd;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function agentFingerprint(input: { model: string; system: string | null; tools: AgentTool[] }): string {
  return sha256({ v: 1, model: input.model, system: input.system, tools: input.tools });
}

function environmentFingerprint(config: CloudEnvironmentConfig): string {
  return sha256({ v: 1, config });
}

async function readInstructions(config: Record<string, unknown>, onLog: AdapterExecutionContext["onLog"]): Promise<string> {
  const filePath = asString(config.instructionsFilePath, "").trim();
  if (!filePath) return "";
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await onLog("stderr", `[staples] Warning: could not read agent instructions file "${filePath}": ${reason}\n`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cents: number;
}

const ZERO_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cents: 0 };

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function totalsFromSessionUsage(usage: SessionUsageTotals | null | undefined): UsageTotals {
  if (!usage) return { ...ZERO_USAGE };
  const cacheWrite = num(usage.cache_creation?.ephemeral_5m_input_tokens) + num(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite,
    cents: num(usage.list_cost?.amount),
  };
}

function deltaTotals(current: UsageTotals, baseline: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    cents: Math.max(0, current.cents - baseline.cents),
  };
}

function centsToUsdExact(cents: number): string {
  const whole = Math.round(cents * 1000) / 1000;
  if (Number.isInteger(whole)) return `${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
  return (whole / 100).toFixed(5);
}

function usageSummary(run: UsageTotals): UsageSummary {
  return {
    // UsageSummary.inputTokens = uncached input + cache writes (excludes cache reads).
    inputTokens: run.input + run.cacheWrite,
    outputTokens: run.output,
    cachedInputTokens: run.cacheRead,
    cacheWriteTokens: run.cacheWrite,
  };
}

const PRICING_PROVENANCE = {
  source: "provider_reported" as const,
  evidence: "Managed Agents session.usage list_cost (session totals, delta for this run)",
};

// ---------------------------------------------------------------------------
// Log lines (one JSON object per line on stdout, like cursor_cloud)
// ---------------------------------------------------------------------------

export type ClaudeManagedLogEvent =
  | { type: "claude_managed.init"; sessionId: string; agentId: string; agentVersion: number; environmentId: string; model: string; resumed: boolean; toolCount: number }
  | { type: "claude_managed.status"; status: string; message?: string }
  | { type: "claude_managed.message"; text: string }
  | { type: "claude_managed.tool_use"; id: string; kind: "builtin" | "mcp" | "custom"; name: string; input: unknown; server?: string }
  | { type: "claude_managed.tool_result"; id: string; name: string; isError: boolean; content: string; truncated?: boolean }
  | { type: "claude_managed.usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }
  | { type: "claude_managed.error"; message: string; errorType?: string; retrying?: boolean }
  | {
      type: "claude_managed.result";
      status: "succeeded" | "failed" | "budget_reached" | "cancelled";
      stopReason?: string;
      summary?: string;
      costUsd?: number | null;
      error?: string;
    };

function line(event: ClaudeManagedLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function textOf(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

function errorFamilyFor(error: unknown): AdapterExecutionErrorFamily | null {
  if (error instanceof ManagedAgentsApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 400 || error.status === 404) return "configuration";
    if (error.status === 429 || error.status >= 500 || error.status === 0) return "transient_upstream";
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext, deps: ExecuteDeps = {}): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog } = ctx;
  const model = asString(config.model, "").trim() || DEFAULT_MODEL;
  const base = {
    provider: "anthropic",
    biller: "anthropic",
    billingType: "api" as const,
    model,
  };
  const prior = readSessionParams(runtime.sessionParams);
  const priorResult = prior ? { sessionParams: { ...prior }, sessionDisplayId: prior.sessionId, sessionId: prior.sessionId } : {};

  const key = resolveApiKey(config, deps.env ?? process.env);
  if (!key) {
    return {
      ...base,
      ...priorResult,
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_managed_api_key_missing",
      errorFamily: "configuration",
      errorMessage: "ANTHROPIC_API_KEY is required for claude_managed. Add it to this agent's environment variables (or set it on the Staples server).",
      costUsd: 0,
      costStatus: "reported",
      clearSession: false,
    };
  }

  const client = new ManagedAgentsClient({ apiKey: key.apiKey, baseUrl: resolveApiBaseUrl(config), fetch: deps.apiFetch });
  const signal = ctx.signal;
  await ctx.onCancellationReady?.();
  if (signal?.aborted) {
    return {
      ...base,
      ...priorResult,
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "cancelled",
      errorMessage: "Run cancelled before it started.",
      costUsd: 0,
      costStatus: "reported",
      clearSession: false,
    };
  }

  // ---- Tools (proxied from the Staples host; tokens stay here) --------------
  const servers = ctx.runtimeMcp?.getServers() ?? [];
  let proxy: ToolsProxy;
  try {
    proxy = await ToolsProxy.discover(servers, {
      fetch: deps.mcpFetch,
      signal,
      onWarning: (message) => onLog("stderr", `[staples] ${message}\n`),
    });
  } catch (error) {
    return {
      ...base,
      ...priorResult,
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: signal?.aborted ? "cancelled" : "claude_managed_tools_failed",
      errorMessage: signal?.aborted ? "Run cancelled while loading tools." : `Could not load tools: ${messageOf(error)}`,
      costUsd: 0,
      costStatus: "reported",
      clearSession: false,
    };
  }

  const tools: AgentTool[] = [{ type: AGENT_TOOLSET_TYPE }, ...proxy.definitions()];
  const instructions = await readInstructions(config, onLog);
  const system = instructions || null;
  const fingerprint = agentFingerprint({ model, system, tools });
  const networking = resolveNetworking(config);
  const envConfig: CloudEnvironmentConfig = { type: "cloud", networking };
  const envFingerprint = environmentFingerprint(envConfig);
  const configuredEnvironmentId = asString(config.environmentId, "").trim() || null;
  const remainingBudgetUsd = resolveRemainingBudgetUsd(context);
  const sessionBudget: BudgetLimit | null = remainingBudgetUsd !== null ? budgetFromUsd(remainingBudgetUsd) : null;

  let managedAgentId: string | null = null;
  let managedAgentVersion = 0;
  let environmentId: string | null = null;
  let sessionId: string | null = null;
  let resumed = false;
  let baseline: UsageTotals = { ...ZERO_USAGE };
  let latest: UsageTotals | null = null;
  const notes: string[] = [];

  const currentSessionParams = (): ClaudeManagedSessionParams | null =>
    managedAgentId && environmentId && sessionId
      ? {
          managedAgentId,
          managedAgentVersion,
          fingerprint,
          environmentId,
          ...(configuredEnvironmentId ? {} : { environmentFingerprint: envFingerprint }),
          sessionId,
        }
      : null;

  const runUsage = (): UsageTotals => (latest ? deltaTotals(latest, baseline) : { ...ZERO_USAGE });
  const accounting = (complete: boolean) => {
    const run = runUsage();
    return {
      ...base,
      usage: usageSummary(run),
      usageBasis: "per_run" as const,
      costUsd: run.cents / 100,
      costUsdExact: centsToUsdExact(run.cents),
      costStatus: "reported" as const,
      pricingProvenance: PRICING_PROVENANCE,
      usageComplete: complete,
    };
  };
  const reportUsage = async (complete: boolean) => {
    if (!ctx.onUsage) return;
    const a = accounting(complete);
    const checkpoint: AdapterUsageCheckpoint = {
      usage: a.usage,
      usageBasis: a.usageBasis,
      provider: a.provider,
      biller: a.biller,
      model: a.model,
      billingType: a.billingType,
      costUsd: a.costUsd,
      costUsdExact: a.costUsdExact,
      costStatus: a.costStatus,
      pricingProvenance: a.pricingProvenance,
      complete,
    };
    try {
      await ctx.onUsage(checkpoint);
    } catch (error) {
      await onLog("stderr", `[staples] Warning: usage checkpoint failed: ${messageOf(error)}\n`);
    }
  };

  const failure = async (
    error: unknown,
    extra: Partial<AdapterExecutionResult> = {},
  ): Promise<AdapterExecutionResult> => {
    const message = messageOf(error);
    await onLog("stdout", line({ type: "claude_managed.result", status: "failed", error: message }));
    const params = currentSessionParams();
    return {
      ...accounting(true),
      ...(params ? { sessionParams: { ...params }, sessionDisplayId: params.sessionId, sessionId: params.sessionId } : priorResult),
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorFamily: errorFamilyFor(error),
      clearSession: false,
      ...extra,
    };
  };

  // Everything past this point talks to Managed Agents.
  ctx.onDispatch?.();

  // ---- Environment ----------------------------------------------------------
  try {
    if (configuredEnvironmentId) {
      environmentId = configuredEnvironmentId;
    } else if (prior && prior.environmentFingerprint === envFingerprint) {
      try {
        const env = await client.getEnvironment(prior.environmentId, { signal });
        if (!env.archived_at) environmentId = env.id;
      } catch (error) {
        if (!(error instanceof ManagedAgentsApiError && error.status === 404)) throw error;
      }
    }
    if (!environmentId) {
      const env = await client.createEnvironment(
        {
          name: `staples-${agent.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "agent"}`,
          description: `Cloud environment for the Staples agent "${agent.name}".`,
          config: envConfig,
          metadata: { staples_agent_id: agent.id, staples_company_id: agent.companyId },
        },
        { signal },
      );
      environmentId = env.id;
      notes.push(`Created cloud environment ${env.id} (networking: ${networking.type}).`);
    }

    // ---- Agent definition ---------------------------------------------------
    const definition = {
      name: `Staples: ${agent.name}`,
      model,
      system,
      tools,
      metadata: { staples_agent_id: agent.id, staples_company_id: agent.companyId },
    };
    if (prior && prior.fingerprint === fingerprint) {
      managedAgentId = prior.managedAgentId;
      managedAgentVersion = prior.managedAgentVersion;
    } else if (prior) {
      try {
        let current = await client.getAgent(prior.managedAgentId, { signal });
        if (current.archived_at) throw new ManagedAgentsApiError({ message: "archived", status: 404, errorType: "not_found_error" });
        try {
          current = await client.updateAgent(current.id, { ...definition, version: current.version }, { signal });
        } catch (error) {
          if (!(error instanceof ManagedAgentsApiError && error.status === 409)) throw error;
          const fresh = await client.getAgent(current.id, { signal });
          current = await client.updateAgent(fresh.id, { ...definition, version: fresh.version }, { signal });
        }
        managedAgentId = current.id;
        managedAgentVersion = current.version;
        notes.push(`Agent definition changed; updated Managed Agents agent ${current.id} to version ${current.version}.`);
      } catch (error) {
        if (!(error instanceof ManagedAgentsApiError && error.status === 404)) throw error;
      }
    }
    if (!managedAgentId) {
      const created = await client.createAgent(definition, { signal });
      managedAgentId = created.id;
      managedAgentVersion = created.version;
      notes.push(`Created Managed Agents agent ${created.id}.`);
    }

    // ---- Session ------------------------------------------------------------
    const canResume =
      prior !== null &&
      prior.fingerprint === fingerprint &&
      prior.managedAgentId === managedAgentId &&
      prior.managedAgentVersion === managedAgentVersion &&
      prior.environmentId === environmentId;
    if (canResume && prior) {
      try {
        const existing = await client.getSession(prior.sessionId, { signal });
        if (!existing.archived_at && existing.status !== "terminated") {
          sessionId = existing.id;
          resumed = true;
          baseline = totalsFromSessionUsage(existing.usage);
          latest = { ...baseline };
          notes.push(`Resuming session ${existing.id}.`);
        }
      } catch (error) {
        if (!(error instanceof ManagedAgentsApiError && error.status === 404)) throw error;
      }
    }
    if (!sessionId) {
      const created = await client.createSession(
        {
          agent: { type: "agent", id: managedAgentId, version: managedAgentVersion },
          environment_id: environmentId,
          ...(sessionBudget ? { budget: sessionBudget } : {}),
          title: `${agent.name} (Staples)`,
          metadata: { staples_agent_id: agent.id, staples_company_id: agent.companyId, staples_run_id: runId },
        },
        { signal },
      );
      sessionId = created.id;
      baseline = totalsFromSessionUsage(created.usage);
      latest = { ...baseline };
      notes.push(
        sessionBudget
          ? `Created session ${created.id} with a spending cap of $${(Number(sessionBudget.max_list_cost.amount) / 100).toFixed(2)}.`
          : `Created session ${created.id} (no spending cap: the remaining budget is not known to the adapter).`,
      );
    }
  } catch (error) {
    if (signal?.aborted) return failure(new Error("Run cancelled while preparing the Managed Agents session."), { errorCode: "cancelled" });
    return failure(error);
  }

  // ---- Prompt -----------------------------------------------------------------
  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  await hydrateFreshSessionHandoff(ctx, { resumedSession: resumed });
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: resumed,
    includeCommunicationGuidance: false,
  });
  const renderedBootstrap = !resumed && bootstrapPromptTemplate.trim() ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
  const renderedPrompt =
    (resumed && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData).trim();
  const prompt = joinPromptSections([
    joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      renderedBootstrap,
      wakePrompt,
      taskContextNote,
      renderedPrompt,
    ]),
    asString(context.paperclipSessionHandoffMarkdown, "").trim(),
  ]) || "Continue with your assigned work.";

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: ADAPTER_TYPE,
      command: "managed-agents-api",
      commandNotes: [
        ...notes,
        `Tools: built-in toolset + ${proxy.tools().length} proxied Staples tool(s).`,
      ],
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        systemChars: system?.length ?? 0,
        bootstrapPromptChars: renderedBootstrap.length,
        wakePromptChars: wakePrompt.length,
        taskContextChars: taskContextNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context: {
        claudeManaged: {
          managedAgentId,
          managedAgentVersion,
          environmentId,
          sessionId,
          resumed,
          networking: networking.type,
          sessionBudgetCents: sessionBudget ? Number(sessionBudget.max_list_cost.amount) : null,
          tools: proxy.tools().map((t) => ({ name: t.name, server: t.serverName, tool: t.toolName })),
        },
      },
    });
  }

  await onLog(
    "stdout",
    line({
      type: "claude_managed.init",
      sessionId: sessionId!,
      agentId: managedAgentId!,
      agentVersion: managedAgentVersion,
      environmentId: environmentId!,
      model,
      resumed,
      toolCount: proxy.tools().length,
    }),
  );
  await ctx.onEvent?.({
    eventType: "claude_managed.session",
    stream: "system",
    level: "info",
    message: resumed ? `Resumed Managed Agents session ${sessionId}` : `Started Managed Agents session ${sessionId}`,
    payload: { sessionId, managedAgentId, managedAgentVersion, environmentId, resumed },
  });

  // ---- Turn -----------------------------------------------------------------
  return runTurn({
    ctx,
    client,
    proxy,
    sessionId: sessionId!,
    prompt,
    cancelGraceMs: deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    onUsageTotals: async (totals) => {
      latest = totals;
      const run = runUsage();
      await onLog(
        "stdout",
        line({
          type: "claude_managed.usage",
          inputTokens: run.input + run.cacheWrite,
          outputTokens: run.output,
          cachedInputTokens: run.cacheRead,
          costUsd: run.cents / 100,
        }),
      );
      await reportUsage(false);
    },
    refreshUsage: async () => {
      const session = await client.getSession(sessionId!, { signal: AbortSignal.timeout(5_000) });
      latest = totalsFromSessionUsage(session.usage);
    },
    hasUsage: () => latest !== null,
    finish: async (outcome) => {
      await reportUsage(true);
      const params = currentSessionParams()!;
      const a = accounting(true);
      const sessionFields = { sessionParams: { ...params }, sessionDisplayId: params.sessionId, sessionId: params.sessionId };
      const resultJson = {
        status: outcome.status,
        stopReason: outcome.stopReason ?? null,
        managedAgentId,
        managedAgentVersion,
        environmentId,
        sessionId,
        resumed,
        ...(outcome.status === "budget_reached" ? { budgetStopped: true } : {}),
        ...(outcome.lastMessage ? { result: outcome.lastMessage } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      await onLog(
        "stdout",
        line({
          type: "claude_managed.result",
          status: outcome.status,
          ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.summary ? { summary: outcome.summary } : {}),
          costUsd: a.costUsd,
          ...(outcome.error ? { error: outcome.error } : {}),
        }),
      );
      await ctx.onEvent?.({
        eventType: "claude_managed.stop",
        stream: "system",
        level: outcome.status === "succeeded" ? "info" : outcome.status === "cancelled" ? "warn" : "error",
        message: outcome.summary ?? outcome.error ?? outcome.status,
        payload: { status: outcome.status, stopReason: outcome.stopReason ?? null, costUsd: a.costUsd },
      });
      if (outcome.status === "succeeded") {
        return { ...a, ...sessionFields, exitCode: 0, signal: null, timedOut: false, summary: outcome.summary ?? null, resultJson, clearSession: false };
      }
      return {
        ...a,
        ...sessionFields,
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: outcome.errorCode ?? null,
        errorFamily: outcome.errorFamily ?? null,
        errorMessage: outcome.error ?? null,
        summary: outcome.summary ?? null,
        resultJson,
        clearSession: outcome.clearSession ?? false,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

interface TurnOutcome {
  status: "succeeded" | "failed" | "budget_reached" | "cancelled";
  stopReason?: string;
  summary?: string;
  lastMessage?: string;
  error?: string;
  errorCode?: string;
  errorFamily?: AdapterExecutionErrorFamily;
  clearSession?: boolean;
}

async function runTurn(input: {
  ctx: AdapterExecutionContext;
  client: ManagedAgentsClient;
  proxy: ToolsProxy;
  sessionId: string;
  prompt: string;
  cancelGraceMs: number;
  onUsageTotals: (totals: UsageTotals) => Promise<void>;
  refreshUsage: () => Promise<void>;
  hasUsage: () => boolean;
  finish: (outcome: TurnOutcome) => Promise<AdapterExecutionResult>;
}): Promise<AdapterExecutionResult> {
  const { ctx, client, proxy, sessionId } = input;
  const { onLog } = ctx;
  const streamAbort = new AbortController();
  const toolAbort = new AbortController();
  const pendingTools = new Set<Promise<void>>();
  let cancelled = false;
  let sawUsage = false;
  let lastMessage = "";
  let lastError: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = () => {
    if (cancelled) return;
    cancelled = true;
    toolAbort.abort();
    void onLog("stdout", line({ type: "claude_managed.status", status: "cancelling", message: "Interrupting the Managed Agents session." }));
    // Interrupt is idempotent: retry it on transient failures, but never longer than the grace period.
    void client
      .sendEvents(sessionId, [{ type: "user.interrupt" }], { retry: "all", signal: AbortSignal.timeout(Math.max(1_000, input.cancelGraceMs)) })
      .catch((error) => onLog("stderr", `[staples] Warning: could not interrupt session ${sessionId}: ${messageOf(error)}\n`));
    graceTimer = setTimeout(() => streamAbort.abort(), input.cancelGraceMs);
  };

  let outcome: TurnOutcome | null = null;
  try {
    let stream: AsyncIterable<ManagedAgentsEvent>;
    try {
      // Open the stream BEFORE sending: the API does not replay earlier events.
      stream = await client.openEventStream(sessionId, { signal: streamAbort.signal });
      if (ctx.signal?.aborted) throw new Error("cancelled");
      // A user.message is never retried on 5xx (it may already have been accepted).
      await client.sendEvents(sessionId, [{ type: "user.message", content: [{ type: "text", text: input.prompt }] }], {
        retry: "safe",
        signal: ctx.signal,
      });
    } catch (error) {
      streamAbort.abort();
      if (ctx.signal?.aborted) {
        return await input.finish({ status: "cancelled", error: "Run cancelled before the task was sent.", errorCode: "cancelled" });
      }
      return await input.finish({ status: "failed", error: messageOf(error), errorFamily: errorFamilyFor(error) ?? undefined });
    }
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
    await onLog("stdout", line({ type: "claude_managed.status", status: "running", message: "Task sent to the Managed Agents session." }));

    try {
      for await (const event of stream) {
        outcome = await handleEvent(event);
        if (outcome) break;
      }
    } catch (error) {
      if (!cancelled) {
        outcome = { status: "failed", error: `Event stream failed: ${messageOf(error)}`, errorFamily: "transient_upstream" };
      }
    }
    if (!outcome) {
      outcome = cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: lastError ?? "The Managed Agents event stream closed before the session went idle.", errorFamily: "transient_upstream" };
    }
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    streamAbort.abort();
    toolAbort.abort();
  }

  if (cancelled) {
    outcome = {
      status: "cancelled",
      stopReason: outcome.stopReason,
      lastMessage: lastMessage || undefined,
      error: "Run cancelled. The Managed Agents session was interrupted and kept for the next run.",
      errorCode: "cancelled",
    };
  }
  await Promise.race([Promise.allSettled([...pendingTools]), new Promise((r) => setTimeout(r, 1_000))]);
  if (!sawUsage) {
    try {
      await input.refreshUsage();
    } catch (error) {
      await onLog("stderr", `[staples] Warning: could not read final session usage: ${messageOf(error)}\n`);
    }
  }
  return input.finish({ ...outcome, lastMessage: outcome.lastMessage ?? (lastMessage || undefined) });

  async function handleEvent(event: ManagedAgentsEvent): Promise<TurnOutcome | null> {
    switch (event.type) {
      case "agent.message": {
        const text = textOf(event.content);
        if (text) {
          lastMessage = text;
          await onLog("stdout", line({ type: "claude_managed.message", text }));
        }
        return null;
      }
      case "agent.tool_use":
        await onLog("stdout", line({ type: "claude_managed.tool_use", id: event.id, kind: "builtin", name: event.name, input: event.input }));
        return null;
      case "agent.mcp_tool_use":
        await onLog("stdout", line({ type: "claude_managed.tool_use", id: event.id, kind: "mcp", name: event.name, server: event.mcp_server_name, input: event.input }));
        return null;
      case "agent.custom_tool_use": {
        const tool = proxy.get(event.name);
        await onLog(
          "stdout",
          line({ type: "claude_managed.tool_use", id: event.id, kind: "custom", name: tool?.toolName ?? event.name, ...(tool ? { server: tool.serverName } : {}), input: event.input }),
        );
        const task = runCustomTool(event.id, event.name, event.input);
        pendingTools.add(task);
        void task.finally(() => pendingTools.delete(task));
        return null;
      }
      case "session.usage":
        sawUsage = true;
        await input.onUsageTotals(totalsFromSessionUsage(event.usage));
        return null;
      case "session.status_running":
        return null;
      case "session.error": {
        const retrying = event.error?.retry_status?.type === "retrying";
        const message = event.error?.message || event.error?.type || "Managed Agents session error";
        await onLog("stdout", line({ type: "claude_managed.error", message, errorType: event.error?.type, retrying }));
        if (retrying) return null;
        lastError = message;
        if (event.error?.retry_status?.type === "terminal") {
          return { status: "failed", stopReason: "error", error: message, errorFamily: "transient_upstream" };
        }
        return null;
      }
      case "session.status_idle": {
        const reason = event.stop_reason?.type ?? "unknown";
        if (reason === "requires_action") return null; // waiting on our custom tool results
        if (cancelled) return { status: "cancelled", stopReason: reason };
        if (reason === "end_turn") {
          if (lastError) return { status: "failed", stopReason: reason, error: lastError };
          return { status: "succeeded", stopReason: reason, summary: firstNonEmptyLine(lastMessage) || undefined };
        }
        if (reason === "budget_reached") {
          return {
            status: "budget_reached",
            stopReason: reason,
            summary: "Stopped: this session reached its spending cap. Raise the agent's budget to continue.",
            error: "The Managed Agents session reached its spending cap (budget_reached).",
            errorCode: "budget_reached",
            errorFamily: "provider_quota",
          };
        }
        if (reason === "retries_exhausted") {
          return { status: "failed", stopReason: reason, error: lastError ?? "The Managed Agents session stopped after exhausting its retries.", errorFamily: "transient_upstream" };
        }
        return { status: "failed", stopReason: reason, error: lastError ?? `The Managed Agents session stopped (${reason}).` };
      }
      case "session.status_terminated":
      case "session.deleted":
        return {
          status: "failed",
          stopReason: event.type,
          error: lastError ?? `The Managed Agents session ended (${event.type === "session.deleted" ? "deleted" : "terminated"}); the next run starts a new session.`,
          clearSession: true,
        };
      default:
        return null;
    }
  }

  async function runCustomTool(toolUseId: string, name: string, toolInput: Record<string, unknown>): Promise<void> {
    let outcome: ToolCallOutcome;
    try {
      outcome = await proxy.call(name, toolInput, { signal: toolAbort.signal });
    } catch (error) {
      outcome = { content: [{ type: "text", text: `Tool failed: ${messageOf(error)}` }], isError: true, truncated: false, preview: "Tool failed" };
    }
    const tool = proxy.get(name);
    await onLog(
      "stdout",
      line({ type: "claude_managed.tool_result", id: toolUseId, name: tool?.toolName ?? name, isError: outcome.isError, content: outcome.preview, ...(outcome.truncated ? { truncated: true } : {}) }),
    );
    await ctx.onEvent?.({
      eventType: "claude_managed.tool_call",
      stream: "system",
      level: outcome.isError ? "warn" : "info",
      message: `${tool?.toolName ?? name}${outcome.isError ? " failed" : " completed"}`,
      payload: { toolUseId, tool: tool?.toolName ?? name, server: tool?.serverName ?? null, isError: outcome.isError, truncated: outcome.truncated },
    });
    if (cancelled) return;
    try {
      // Duplicate custom tool results have no effect, so this batch may be retried.
      await client.sendEvents(
        sessionId,
        [{ type: "user.custom_tool_result", custom_tool_use_id: toolUseId, content: outcome.content, is_error: outcome.isError }],
        { retry: "all", signal: streamAbort.signal },
      );
    } catch (error) {
      if (!cancelled) await onLog("stderr", `[staples] Warning: could not send the result of ${name}: ${messageOf(error)}\n`);
    }
  }
}

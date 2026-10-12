/**
 * Live smoke test for the claude_managed adapter.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @paperclipai/adapter-claude-managed smoke [--scenario <name>]... [--json]
 *   pnpm --filter @paperclipai/adapter-claude-managed smoke --fake --scenario all   # no key, local fake server
 *
 * Runs the real adapter `execute()` against minimal fake run contexts. In-process
 * fake Staples MCP servers expose the tools each scenario needs. Scenarios
 * (`--scenario` is repeatable, accepts comma lists, and `all`; default `basic`):
 *
 *   basic               one turn, one proxied custom tool call (echo_note)
 *   resume              two runs on the same session; checks `resumed` and the per-run cost delta
 *   cancel              aborts a long task after the first tool call (or 8s); checks the cancelled result
 *   budget              remaining budget $0.01; checks the session cap and the budget_reached result
 *   tool-error          the MCP tool returns an error result; the run must still complete
 *   big-result          the MCP tool returns ~250 KB; checks the truncation note reaches the agent
 *   multi-tool          two tools on two MCP servers; checks both are called and names map back
 *   networking-limited  limited networking (allowedHosts example.com); informational web_fetch check
 *   models              basic once per model in MANAGED_AGENTS_MODELS (default sonnet + haiku 5.5)
 *   test-environment    the adapter's testEnvironment() check codes
 *   skills              attaches a tiny runtime skill (staples-smoke-codeword) and asks for its code word
 *
 * Each scenario prints its own PASS/FAIL (or INFO) line, a cost line and its ids,
 * and archives every session it started. Agents and environments are left in place
 * (the adapter reuses them). `--json` prints a machine-readable summary at the end.
 *
 * Environment: ANTHROPIC_API_KEY (required unless --fake), MANAGED_AGENTS_BASE_URL,
 * MANAGED_AGENTS_MODEL, MANAGED_AGENTS_MODELS (comma list, `models` scenario). The
 * key is never printed.
 *
 * Safety: each scenario is cancelled after SMOKE_TIMEOUT_MS (default 5 minutes);
 * Ctrl-C cancels the current scenario, archives its sessions and skips the rest
 * (a second Ctrl-C exits immediately). Session ids are printed as soon as sessions
 * start. SMOKE_FAKE_SCENARIO=never_idle (with --fake) makes `basic` hang, to exercise
 * the timeout path.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { ManagedAgentsClient } from "../src/client.js";
import { execute } from "../src/server/execute.js";
import { readSessionParams } from "../src/server/session.js";
import { testEnvironment } from "../src/server/test-environment.js";
import {
  fakeEvents,
  startFakeManagedAgentsServer,
  type FakeManagedAgentsServer,
  type TurnScript,
} from "../src/testing/fake-managed-agents-server.js";
import { startFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from "../src/testing/fake-mcp-server.js";

export const MISSING_KEY_MESSAGE =
  "Set ANTHROPIC_API_KEY to run the live smoke test. It creates a small agent, environment and session on your Anthropic account and archives the session afterwards (a few cents).";

export const SCENARIOS = [
  "basic",
  "resume",
  "cancel",
  "budget",
  "tool-error",
  "big-result",
  "multi-tool",
  "networking-limited",
  "models",
  "test-environment",
  "skills",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_EXTRA_MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const NOTE = "staples-smoke-note";
const RESUME_NOTE = "staples-resume-note-7319";
const RUN_TOKEN = "smoke-run-token";
const SMOKE_AGENT_ID = "smoke-agent-0001";
const SMOKE_COMPANY_ID = "smoke-company";
const SKILLS_AGENT_ID = "smoke-agent-skills";
const SMOKE_SKILL_NAME = "staples-smoke-codeword";
const SMOKE_CODE_WORD = "BANANA-7";
const SMOKE_SKILL_MD = [
  "---",
  `name: ${SMOKE_SKILL_NAME}`,
  "description: Knows the Staples code word. Use it whenever someone asks for the Staples code word.",
  "---",
  "",
  "# Staples code word",
  "",
  `When asked for the Staples code word, answer ${SMOKE_CODE_WORD}.`,
  "",
].join("\n");
const SKILLS_PROMPT = "What is the Staples code word? Check your skills for it. Reply with only the code word.";
const MAIN_SERVER = "Staples smoke";
const EXTRA_SERVER = "Staples extra";
/** Proxied custom tool names (server slug + "__" + tool), used by the fake turn scripts. */
const fakeToolName = (server: string, tool: string) => `${server.toLowerCase().replace(/[^a-z0-9]+/g, "-")}__${tool}`;
const BIG_RESULT_CHARS = 250_000;
const CANCEL_FALLBACK_MS = 8_000;
/** Cost comparisons tolerate one cent of rounding / reporting lag. */
const COST_TOLERANCE_USD = 0.01;

const BASIC_PROMPT =
  `This is a connectivity check. Call the tool whose name ends in "echo_note" exactly once, with the argument note set to "${NOTE}". ` +
  "Then reply with one short sentence confirming what the tool returned. Do not call any other tool.";

export interface SmokeIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type LogEvent = Record<string, unknown> & { type?: unknown };

export type ScenarioStatus = "pass" | "fail" | "info" | "skipped";

export interface ScenarioSummary {
  status: ScenarioStatus;
  message: string;
  costUsd: number;
  sessionIds: string[];
  agentIds: string[];
  environmentIds: string[];
  details?: Record<string, unknown>;
}

export interface SmokeSummary {
  mode: "fake" | "live";
  passed: boolean;
  totalCostUsd: number;
  scenarios: Partial<Record<ScenarioName, ScenarioSummary>>;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface SmokeArgs {
  fake: boolean;
  json: boolean;
  scenarios: ScenarioName[];
}

export function parseSmokeArgs(argv: string[]): SmokeArgs | { error: string } {
  const requested: string[] = [];
  let fake = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--fake") fake = true;
    else if (arg === "--json") json = true;
    else if (arg === "--scenario") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: "--scenario needs a value." };
      requested.push(value);
      i += 1;
    } else if (arg.startsWith("--scenario=")) requested.push(arg.slice("--scenario=".length));
    else return { error: `Unknown argument: ${arg}` };
  }
  const names = requested.flatMap((value) => value.split(",")).map((v) => v.trim()).filter(Boolean);
  const scenarios: ScenarioName[] = [];
  for (const name of names.length > 0 ? names : ["basic"]) {
    if (name === "all") {
      scenarios.push(...SCENARIOS);
      continue;
    }
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      return { error: `Unknown scenario "${name}". Valid: ${SCENARIOS.join(", ")}, all.` };
    }
    scenarios.push(name as ScenarioName);
  }
  return { fake, json, scenarios: [...new Set(scenarios)] };
}

function resolveTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.SMOKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SMOKE_TIMEOUT_MS;
}

function resolveExtraModels(env: Record<string, string | undefined>): string[] {
  const list = (env.MANAGED_AGENTS_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_EXTRA_MODELS;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  io: SmokeIo;
  env: Record<string, string | undefined>;
  fake: FakeManagedAgentsServer | null;
  apiKey: string;
  baseUrl: string | undefined;
  model: string | undefined;
  client: ManagedAgentsClient;
  timeoutMs: number;
  /** Environment created by a default-networking scenario; the `models` agents reuse it. */
  defaultEnvironmentId: string | null;
  /** Sessions started and not yet archived (printed on a hard exit). */
  unarchived: Set<string>;
  allAgentIds: Set<string>;
  allEnvironmentIds: Set<string>;
}

interface Scope {
  name: ScenarioName;
  signal: AbortSignal;
  costUsd: number;
  sessionIds: Set<string>;
  agentIds: Set<string>;
  environmentIds: Set<string>;
  cleanups: Array<() => Promise<void>>;
  details: Record<string, unknown>;
}

interface Verdict {
  status: "pass" | "fail" | "info";
  message: string;
}

interface RunOptions {
  prompt: string;
  servers: FakeMcpServerRef[];
  agentId?: string;
  model?: string;
  sessionParams?: Record<string, unknown> | null;
  context?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Extra abort signal (combined with the scenario's timeout/Ctrl-C signal). */
  signal?: AbortSignal;
  onEvent?: (event: LogEvent) => void;
}

interface RunOutput {
  result: AdapterExecutionResult;
  events: LogEvent[];
  init: LogEvent | null;
  sessionId: string | null;
  agentId: string | null;
  environmentId: string | null;
  messages: string[];
  lastApiError: { status: number; type: string; message: string } | null;
}

interface FakeMcpServerRef {
  name: string;
  server: FakeMcpServer;
}

async function startMcp(scope: Scope, name: string, tools: FakeMcpTool[]): Promise<FakeMcpServerRef> {
  const server = await startFakeMcpServer({ token: RUN_TOKEN, tools });
  scope.cleanups.push(() => server.close());
  return { name, server };
}

const echoTool: FakeMcpTool = {
  name: "echo_note",
  description: "Echoes the note it is given. Used by the Staples smoke test.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  handler: (args) => ({ content: [{ type: "text", text: `echo: ${String(args.note)}` }] }),
};

async function runAdapter(h: Harness, scope: Scope, options: RunOptions): Promise<RunOutput> {
  const events: LogEvent[] = [];
  const messages: string[] = [];
  const transcript: string[] = [];
  let init: LogEvent | null = null;
  let lastApiError: RunOutput["lastApiError"] = null;
  const apiFetch: FetchLike = async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      let type = "unknown";
      let message = "";
      try {
        const body = (await response.clone().json()) as { error?: { type?: unknown; message?: unknown } };
        type = typeof body.error?.type === "string" ? body.error.type : type;
        message = typeof body.error?.message === "string" ? body.error.message : "";
      } catch {
        // not a JSON error body
      }
      lastApiError = { status: response.status, type, message: redact(message, h.apiKey) };
    }
    return response;
  };
  const signal = options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
  const sessionParams = options.sessionParams ?? null;
  const ctx: AdapterExecutionContext = {
    runId: `smoke-${scope.name}-${Date.now()}`,
    agent: {
      id: options.agentId ?? SMOKE_AGENT_ID,
      companyId: SMOKE_COMPANY_ID,
      name: options.agentId ? `Smoke ${options.agentId}` : "Smoke",
      adapterType: "claude_managed",
      adapterConfig: {},
    },
    runtime: {
      sessionId: readSessionParams(sessionParams)?.sessionId ?? null,
      sessionParams,
      sessionDisplayId: readSessionParams(sessionParams)?.sessionId ?? null,
      taskKey: null,
    },
    config: {
      env: { ANTHROPIC_API_KEY: h.apiKey },
      ...(h.baseUrl ? { apiBaseUrl: h.baseUrl } : {}),
      ...((options.model ?? h.model) ? { model: options.model ?? h.model } : {}),
      promptTemplate: options.prompt,
      ...options.config,
    },
    context: { ...options.context },
    signal,
    runtimeMcp: {
      getServers: () => options.servers.map((s, i) => ({ name: s.name, url: s.server.url, token: RUN_TOKEN, connectionId: `smoke-${i}` })),
    },
    onLog: async (_stream, chunk) => {
      for (const raw of chunk.split("\n")) {
        if (!raw.startsWith("{")) continue;
        let event: LogEvent;
        try {
          event = JSON.parse(raw) as LogEvent;
        } catch {
          continue;
        }
        events.push(event);
        if (event.type === "claude_managed.init" && typeof event.sessionId === "string") {
          init = event;
          scope.sessionIds.add(event.sessionId);
          h.unarchived.add(event.sessionId);
          h.io.out(`Session started: ${event.sessionId} (if this script is killed, archive it in the Anthropic Console).`);
        }
        if (event.type === "claude_managed.message" && typeof event.text === "string") messages.push(event.text);
        const text = formatEvent(event);
        if (text) transcript.push(text);
        options.onEvent?.(event);
      }
    },
    onUsage: async () => undefined,
    onEvent: async () => undefined,
    onDispatch: () => undefined,
    onCancellationReady: async () => undefined,
  };

  let result: AdapterExecutionResult;
  try {
    result = await execute(ctx, { apiFetch });
  } finally {
    for (const line of transcript) h.io.out(`  ${line}`);
  }
  const initEvent = init as LogEvent | null;
  const params = readSessionParams(result.sessionParams);
  const sessionId = params?.sessionId ?? (typeof initEvent?.sessionId === "string" ? initEvent.sessionId : null);
  const agentId = params?.managedAgentId ?? (typeof initEvent?.agentId === "string" ? initEvent.agentId : null);
  const environmentId = params?.environmentId ?? (typeof initEvent?.environmentId === "string" ? initEvent.environmentId : null);
  if (sessionId) {
    scope.sessionIds.add(sessionId);
    h.unarchived.add(sessionId);
  }
  if (agentId) {
    scope.agentIds.add(agentId);
    h.allAgentIds.add(agentId);
  }
  if (environmentId) {
    scope.environmentIds.add(environmentId);
    h.allEnvironmentIds.add(environmentId);
  }
  scope.costUsd += typeof result.costUsd === "number" ? result.costUsd : 0;
  h.io.out(
    `  -> ${result.exitCode === 0 ? "succeeded" : `exit ${String(result.exitCode)} (${result.errorCode ?? "no error code"}: ${redact(result.errorMessage ?? "-", h.apiKey)})`}, cost $${result.costUsd ?? "unknown"}`,
  );
  return { result, events, init: initEvent, sessionId, agentId, environmentId, messages, lastApiError };
}

function toolUses(run: RunOutput, name?: string): LogEvent[] {
  return run.events.filter((e) => e.type === "claude_managed.tool_use" && (name === undefined || e.name === name));
}

function toolResults(run: RunOutput, name?: string): LogEvent[] {
  return run.events.filter((e) => e.type === "claude_managed.tool_result" && (name === undefined || e.name === name));
}

function sessionCostUsd(session: { usage?: { list_cost?: { amount?: unknown } | null } | null }): number {
  const cents = Number(session.usage?.list_cost?.amount ?? 0);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

function queueFake(h: Harness, ...turns: TurnScript[]): void {
  h.fake?.queueTurns(...turns);
}

function fakeToolTurn(calls: Array<{ server?: string; tool: string; input?: Record<string, unknown> }>, message: string, listCostCents: number): TurnScript {
  return [
    { kind: "emit", event: fakeEvents.running() },
    ...calls.map((c) => ({ kind: "custom_tool_call" as const, name: fakeToolName(c.server ?? MAIN_SERVER, c.tool), input: c.input ?? {} })),
    { kind: "emit", event: fakeEvents.agentMessage(message) },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 120, outputTokens: 30, listCostCents }) },
    { kind: "emit", event: fakeEvents.idle() },
  ];
}

function rememberDefaultEnvironment(h: Harness, run: RunOutput): void {
  if (!h.defaultEnvironmentId && run.environmentId && run.result.exitCode === 0) h.defaultEnvironmentId = run.environmentId;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function basicRun(h: Harness, scope: Scope, opts: { agentId?: string; model?: string; config?: Record<string, unknown> } = {}): Promise<{ run: RunOutput; verdict: Verdict }> {
  const mcp = await startMcp(scope, MAIN_SERVER, [echoTool]);
  if (h.fake && h.env.SMOKE_FAKE_SCENARIO === "never_idle" && scope.name === "basic") {
    queueFake(h, [
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage("Thinking...") },
      { kind: "hang" },
    ]);
  } else {
    queueFake(h, fakeToolTurn([{ tool: "echo_note", input: { note: NOTE } }], `The tool echoed: ${NOTE}`, 1));
  }
  const run = await runAdapter(h, scope, { prompt: BASIC_PROMPT, servers: [mcp], ...opts });
  const called = mcp.server.calls().filter((c) => c.name === "echo_note");
  h.io.out(`  echo_note calls: ${called.length}`);
  if (run.result.exitCode !== 0) return { run, verdict: { status: "fail", message: "the run did not succeed." } };
  if (called.length < 1) return { run, verdict: { status: "fail", message: "the agent never called echo_note." } };
  return { run, verdict: { status: "pass", message: "the run succeeded and echo_note was called through the Staples tools proxy." } };
}

async function scenarioBasic(h: Harness, scope: Scope): Promise<Verdict> {
  const { run, verdict } = await basicRun(h, scope);
  rememberDefaultEnvironment(h, run);
  return verdict;
}

async function scenarioResume(h: Harness, scope: Scope): Promise<Verdict> {
  const mcp = await startMcp(scope, MAIN_SERVER, [echoTool]);
  queueFake(
    h,
    fakeToolTurn([{ tool: "echo_note", input: { note: RESUME_NOTE } }], `The tool echoed: ${RESUME_NOTE}`, 1),
    [
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage(RESUME_NOTE) },
      // Session totals are cumulative: 1 cent from the first run + 2 cents now.
      { kind: "emit", event: fakeEvents.usage({ inputTokens: 300, outputTokens: 40, listCostCents: 3 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ],
  );
  const first = await runAdapter(h, scope, {
    prompt:
      `Call the tool whose name ends in "echo_note" exactly once, with the argument note set to "${RESUME_NOTE}". ` +
      "Then reply with one short sentence confirming what the tool returned. Do not call any other tool.",
    servers: [mcp],
  });
  if (first.result.exitCode !== 0 || !first.sessionId) return { status: "fail", message: "the first run did not succeed." };
  rememberDefaultEnvironment(h, first);
  const second = await runAdapter(h, scope, {
    prompt:
      "Do not call any tool. Earlier in this conversation you called echo_note with a note value. " +
      "Reply with exactly that note value and nothing else.",
    servers: [mcp],
    sessionParams: (first.result.sessionParams as Record<string, unknown> | null | undefined) ?? null,
  });
  const firstCost = first.result.costUsd ?? 0;
  const secondCost = second.result.costUsd ?? 0;
  const session = await h.client.getSession(first.sessionId, { signal: AbortSignal.timeout(15_000) });
  const total = sessionCostUsd(session);
  scope.details = { firstCostUsd: firstCost, secondCostUsd: secondCost, sessionTotalCostUsd: total };
  h.io.out(`  first run cost $${firstCost}, second run cost $${secondCost}, session total (getSession) $${total}`);
  const resumedFlag = second.init?.resumed === true;
  const sameSession = second.init?.sessionId === first.sessionId;
  h.io.out(`  second run: resumed ${String(second.init?.resumed)}, session ${String(second.init?.sessionId)} (first ${first.sessionId})`);
  if (second.result.exitCode !== 0) return { status: "fail", message: "the second run did not succeed." };
  if (!resumedFlag || !sameSession) return { status: "fail", message: "the second run did not resume the first run's session." };
  if (!second.messages.join("\n").includes(RESUME_NOTE)) {
    return { status: "fail", message: `the resumed agent did not repeat the note ${RESUME_NOTE}.` };
  }
  if (secondCost > total - firstCost + COST_TOLERANCE_USD) {
    return { status: "fail", message: `the second run's cost $${secondCost} exceeds the session delta $${(total - firstCost).toFixed(4)} (+$${COST_TOLERANCE_USD}).` };
  }
  if (firstCost > 0 && secondCost >= total) {
    return { status: "fail", message: `the second run's cost $${secondCost} looks cumulative (session total $${total}), not a per-run delta.` };
  }
  return { status: "pass", message: "the second run resumed the same session and reported a per-run cost delta." };
}

async function scenarioCancel(h: Harness, scope: Scope): Promise<Verdict> {
  const mcp = await startMcp(scope, MAIN_SERVER, [echoTool]);
  queueFake(h, [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "custom_tool_call", name: fakeToolName(MAIN_SERVER, "echo_note"), input: { note: "step-1" } },
    { kind: "emit", event: fakeEvents.agentMessage("Step 1 done; continuing...") },
    { kind: "hang" },
  ]);
  const cancel = new AbortController();
  let reason = "";
  const fallback = setTimeout(() => {
    if (!cancel.signal.aborted) {
      reason = `${CANCEL_FALLBACK_MS / 1000}s elapsed`;
      cancel.abort();
    }
  }, CANCEL_FALLBACK_MS);
  let run: RunOutput;
  try {
    run = await runAdapter(h, scope, {
      prompt:
        `Do a long multi-step task. Call the tool whose name ends in "echo_note" 10 times, one call at a time, with notes "step-1" through "step-10". ` +
        "Between calls, run `sleep 5` in bash. After all ten calls, write a 1500-word essay about the history of the stapler.",
      servers: [mcp],
      signal: cancel.signal,
      onEvent: (event) => {
        if (event.type === "claude_managed.tool_use" && !cancel.signal.aborted) {
          reason = `first tool call (${String(event.name)})`;
          cancel.abort();
        }
      },
    });
  } finally {
    clearTimeout(fallback);
  }
  h.io.out(`  cancelled after: ${reason || "-"}`);
  const r = run.result;
  const cancellation = (r.resultJson as { executionCancellation?: { state?: unknown } } | null | undefined)?.executionCancellation;
  const idleObserved = /was interrupted and kept/.test(r.errorMessage ?? "");
  h.io.out(`  exitCode ${String(r.exitCode)}, errorCode ${String(r.errorCode)}, cancellation ${String(cancellation?.state)}, idle observed ${idleObserved}, executionRecovery ${JSON.stringify(r.executionRecovery ?? null)}`);
  let status = "unknown";
  if (run.sessionId) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      status = (await h.client.getSession(run.sessionId, { signal: AbortSignal.timeout(10_000) })).status;
      if (status !== "running" && status !== "rescheduling") break;
      if (Date.now() > deadline || scope.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  h.io.out(`  session status after cancel: ${status}`);
  scope.details = { cancelledAfter: reason, idleObserved, sessionStatus: status };
  if (!reason) return { status: "fail", message: "the run finished before it could be cancelled." };
  if (r.exitCode !== null || r.errorCode !== "cancelled") return { status: "fail", message: "the result is not a cancelled result (exitCode null, errorCode cancelled)." };
  if (cancellation?.state !== "acknowledged") return { status: "fail", message: "resultJson.executionCancellation.state is not acknowledged." };
  if (idleObserved && (r.executionRecovery as { kind?: unknown } | undefined)?.kind !== "interrupted") {
    return { status: "fail", message: "the session went idle but executionRecovery is missing." };
  }
  if (status !== "idle") return { status: "fail", message: `the session is ${status} after the cancel, not idle.` };
  return { status: "pass", message: `the run was cancelled, acknowledged${idleObserved ? " with executionRecovery" : ""}, and the session is idle.` };
}

async function scenarioBudget(h: Harness, scope: Scope): Promise<Verdict> {
  const mcp = await startMcp(scope, MAIN_SERVER, [echoTool]);
  queueFake(h, [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "custom_tool_call", name: fakeToolName(MAIN_SERVER, "echo_note"), input: { note: "budget-1" } },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 1000, outputTokens: 200, listCostCents: 2 }) },
    { kind: "emit", event: fakeEvents.idle({ type: "budget_reached" }) },
  ]);
  const run = await runAdapter(h, scope, {
    prompt:
      `Call the tool whose name ends in "echo_note" 8 times, one call at a time, with notes "budget-1" through "budget-8". ` +
      "After each call, write a paragraph explaining what it returned. Then write a 1000-word summary.",
    servers: [mcp],
    context: { paperclipBudgetRemainingUsd: 0.01 },
  });
  let cap = "none";
  let total = 0;
  if (run.sessionId) {
    const session = await h.client.getSession(run.sessionId, { signal: AbortSignal.timeout(15_000) });
    const amount = session.budget?.max_list_cost?.amount;
    cap = amount !== undefined ? `$${(Number(amount) / 100).toFixed(2)} (${amount} cents)` : "none";
    total = sessionCostUsd(session);
  }
  const r = run.result;
  const status = (r.resultJson as { status?: unknown } | null | undefined)?.status;
  h.io.out(`  session budget cap: ${cap}; session total cost $${total} (the API may overshoot the cap by about one request)`);
  h.io.out(`  exitCode ${String(r.exitCode)}, errorCode ${String(r.errorCode)}, resultJson.status ${String(status)}, echo_note calls ${mcp.server.calls().length}`);
  scope.details = { budgetCap: cap, sessionTotalCostUsd: total };
  if (cap === "none") return { status: "fail", message: "the session was created without a budget cap." };
  if (r.exitCode !== 1 || r.errorCode !== "budget_reached" || status !== "budget_reached") {
    return { status: "fail", message: "the run did not stop with budget_reached (exitCode 1, errorCode budget_reached)." };
  }
  return { status: "pass", message: `the session had a ${cap} cap and the run stopped with budget_reached.` };
}

async function scenarioToolError(h: Harness, scope: Scope): Promise<Verdict> {
  const mcp = await startMcp(scope, MAIN_SERVER, [
    {
      name: "fail_note",
      description: "Stores a note. Used by the Staples smoke test.",
      inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      handler: () => ({ content: [{ type: "text", text: "fail_note: the note store is unavailable (simulated error)." }], isError: true }),
    },
  ]);
  queueFake(h, fakeToolTurn([{ tool: "fail_note", input: { note: NOTE } }], "The tool returned an error: the note store is unavailable.", 1));
  const run = await runAdapter(h, scope, {
    prompt:
      `Call the tool whose name ends in "fail_note" exactly once, with the argument note set to "${NOTE}". Do not retry it. ` +
      "Then reply with one short sentence saying whether the tool succeeded or returned an error, and the error text if any.",
    servers: [mcp],
  });
  const results = toolResults(run, "fail_note");
  h.io.out(`  fail_note calls: ${mcp.server.calls().length}; tool results: ${results.map((e) => (e.isError ? "error" : "ok")).join(", ") || "-"}`);
  if (results.length < 1) return { status: "fail", message: "the agent never called fail_note." };
  if (!results.every((e) => e.isError === true)) return { status: "fail", message: "the tool result was not sent as an error." };
  if (run.result.exitCode !== 0) return { status: "fail", message: "the run did not complete after the tool error." };
  return { status: "pass", message: "the agent received an error tool result and the run completed." };
}

async function scenarioBigResult(h: Harness, scope: Scope): Promise<Verdict> {
  const big = `${"lorem ipsum dolor sit amet ".repeat(Math.ceil(BIG_RESULT_CHARS / 27))}`.slice(0, BIG_RESULT_CHARS);
  const mcp = await startMcp(scope, MAIN_SERVER, [
    {
      name: "big_note",
      description: "Returns a very large text document. Used by the Staples smoke test.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ content: [{ type: "text", text: big }] }),
    },
  ]);
  queueFake(h, fakeToolTurn([{ tool: "big_note" }], "SAW_TRUNCATION_NOTE", 2));
  const run = await runAdapter(h, scope, {
    prompt:
      'Call the tool whose name ends in "big_note" exactly once. Look at the very end of its result. ' +
      'If the result ends with a note saying Staples truncated it, reply with exactly SAW_TRUNCATION_NOTE; otherwise reply with exactly NO_TRUNCATION_NOTE. Do not call any other tool.',
    servers: [mcp],
  });
  const truncated = toolResults(run, "big_note").some((e) => e.truncated === true);
  const reply = run.messages.join("\n");
  const agentSaw = reply.includes("SAW_TRUNCATION_NOTE") && !reply.includes("NO_TRUNCATION_NOTE");
  let fakeSent: boolean | null = null;
  if (h.fake && run.sessionId) {
    fakeSent = h.fake.receivedEvents(run.sessionId).some((e) => e.type === "user.custom_tool_result" && JSON.stringify(e.content).includes("[Staples truncated"));
  }
  h.io.out(`  result size ${BIG_RESULT_CHARS} chars; adapter truncated ${truncated}; agent reply: ${clip(reply || "-", 80)}${fakeSent === null ? "" : `; note sent to fake ${fakeSent}`}`);
  scope.details = { truncated, agentSawNote: agentSaw };
  if (run.result.exitCode !== 0) return { status: "fail", message: "the run did not complete." };
  if (!truncated) return { status: "fail", message: "the adapter did not truncate the 250 KB result." };
  if (fakeSent === false) return { status: "fail", message: "the truncation note was not in the tool result sent to the session." };
  if (!agentSaw) return { status: "fail", message: "the agent did not report the truncation note." };
  return { status: "pass", message: "the result was truncated, the note reached the agent, and the run completed." };
}

async function scenarioMultiTool(h: Harness, scope: Scope): Promise<Verdict> {
  const main = await startMcp(scope, MAIN_SERVER, [echoTool]);
  const extra = await startMcp(scope, EXTRA_SERVER, [
    {
      name: "add_numbers",
      description: "Adds two numbers. Used by the Staples smoke test.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      handler: (args) => ({ content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] }),
    },
  ]);
  queueFake(
    h,
    fakeToolTurn(
      [
        { tool: "echo_note", input: { note: NOTE } },
        { server: EXTRA_SERVER, tool: "add_numbers", input: { a: 2, b: 3 } },
      ],
      `echo: ${NOTE}; 2 + 3 = 5`,
      2,
    ),
  );
  const run = await runAdapter(h, scope, {
    prompt:
      `Call the tool whose name ends in "echo_note" once with note "${NOTE}", and the tool whose name ends in "add_numbers" once with a=2 and b=3. ` +
      "Then reply with one short sentence reporting both results. Do not call any other tool.",
    servers: [main, extra],
  });
  const echoCalls = main.server.calls().filter((c) => c.name === "echo_note").length;
  const addCalls = extra.server.calls().filter((c) => c.name === "add_numbers").length;
  const mapped = (tool: string, server: string) => toolUses(run, tool).some((e) => e.server === server && e.kind === "custom");
  const echoMapped = mapped("echo_note", MAIN_SERVER);
  const addMapped = mapped("add_numbers", EXTRA_SERVER);
  h.io.out(`  echo_note calls ${echoCalls} (mapped to "${MAIN_SERVER}": ${echoMapped}); add_numbers calls ${addCalls} (mapped to "${EXTRA_SERVER}": ${addMapped})`);
  if (run.result.exitCode !== 0) return { status: "fail", message: "the run did not succeed." };
  if (echoCalls < 1 || addCalls < 1) return { status: "fail", message: "the agent did not call both tools." };
  if (!echoMapped || !addMapped) return { status: "fail", message: "the tool calls were not mapped back to their servers and names." };
  return { status: "pass", message: "both tools on both servers were called and mapped back correctly." };
}

async function scenarioNetworkingLimited(h: Harness, scope: Scope): Promise<Verdict> {
  queueFake(h, [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "emit", event: fakeEvents.agentToolUse("web_fetch", { url: "https://example.com" }) },
    { kind: "emit", event: fakeEvents.agentToolUse("web_fetch", { url: "https://www.wikipedia.org" }) },
    { kind: "emit", event: fakeEvents.agentMessage("example.com: OK\nwikipedia.org: FAILED (blocked)") },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 300, outputTokens: 40, listCostCents: 2 }) },
    { kind: "emit", event: fakeEvents.idle() },
  ]);
  const run = await runAdapter(h, scope, {
    prompt:
      "Use your web fetch tool (not bash) to fetch https://example.com, then https://www.wikipedia.org. " +
      'Then reply with exactly two lines: "example.com: OK" or "example.com: FAILED (<short reason>)", and ' +
      '"wikipedia.org: OK" or "wikipedia.org: FAILED (<short reason>)".',
    servers: [],
    config: { networking: { type: "limited", allowedHosts: ["example.com"] } },
  });
  let networking = "unknown";
  if (run.environmentId) {
    const env = await h.client.getEnvironment(run.environmentId, { signal: AbortSignal.timeout(15_000) });
    networking = JSON.stringify((env.config as { networking?: unknown } | undefined)?.networking ?? null);
  }
  const reply = run.messages.join("\n");
  const builtin = toolUses(run).map((e) => `${String(e.name)} ${clip(JSON.stringify(e.input ?? {}), 60)}`);
  h.io.out(`  environment ${run.environmentId ?? "-"} networking ${networking}`);
  h.io.out(`  built-in tool calls: ${builtin.join("; ") || "-"}`);
  h.io.out(`  agent reply: ${clip(reply || "-", 200)}`);
  const exampleOk = /example\.com:\s*OK/i.test(reply);
  const wikipediaFailed = /wikipedia\.org:\s*FAILED/i.test(reply);
  scope.details = { networking, exampleOk, wikipediaFailed, reply: clip(reply, 300) };
  if (run.result.exitCode !== 0) return { status: "fail", message: "the run did not succeed." };
  if (exampleOk && wikipediaFailed) return { status: "pass", message: "(informational) example.com was fetched and wikipedia.org was blocked or failed." };
  return { status: "info", message: `(informational) unexpected networking result: example.com ${exampleOk ? "OK" : "not OK"}, wikipedia.org ${wikipediaFailed ? "failed" : "not reported as failed"}.` };
}

async function scenarioModels(h: Harness, scope: Scope): Promise<Verdict> {
  const models = resolveExtraModels(h.env);
  const perModel: Record<string, string> = {};
  let failed = 0;
  let unsupported = 0;
  for (const model of models) {
    if (scope.signal.aborted) break;
    h.io.out(` model ${model}:`);
    if (h.fake && model.includes("unsupported")) {
      h.fake.failNext({ method: "POST", path: "/v1/agents", status: 400, errorType: "invalid_request_error", message: `model: ${model} is not supported` });
    }
    const agentId = `smoke-agent-${model.replace(/[^a-zA-Z0-9]/g, "").slice(-24)}`;
    const { run, verdict } = await basicRun(h, scope, {
      agentId,
      model,
      ...(h.defaultEnvironmentId ? { config: { environmentId: h.defaultEnvironmentId } } : {}),
    });
    if (verdict.status === "pass") {
      rememberDefaultEnvironment(h, run);
      perModel[model] = "pass";
      h.io.out(`  PASS ${model}: ${verdict.message}`);
    } else if (!run.init && run.lastApiError) {
      unsupported += 1;
      perModel[model] = `unsupported (${run.lastApiError.type})`;
      h.io.out(`  FAIL ${model}: the API refused it before a session started (${run.lastApiError.status} ${run.lastApiError.type}: ${clip(run.lastApiError.message, 160)}).`);
    } else {
      failed += 1;
      perModel[model] = "fail";
      h.io.out(`  FAIL ${model}: ${verdict.message}`);
    }
  }
  scope.details = { models: perModel };
  if (failed > 0) return { status: "fail", message: `${failed} of ${models.length} model(s) failed after starting a session.` };
  if (unsupported > 0) return { status: "info", message: `${models.length - unsupported} of ${models.length} model(s) passed; ${unsupported} refused by the API (see above).` };
  return { status: "pass", message: `all ${models.length} model(s) passed: ${models.join(", ")}.` };
}

async function scenarioTestEnvironment(h: Harness, scope: Scope): Promise<Verdict> {
  const result = await testEnvironment(
    {
      companyId: SMOKE_COMPANY_ID,
      adapterType: "claude_managed",
      config: { env: { ANTHROPIC_API_KEY: h.apiKey }, ...(h.baseUrl ? { apiBaseUrl: h.baseUrl } : {}) },
    },
    { env: {} },
  );
  for (const check of result.checks) h.io.out(`  check ${check.code} (${check.level}): ${redact(check.message, h.apiKey)}`);
  h.io.out(`  status: ${result.status}`);
  scope.details = { status: result.status, checks: result.checks.map((c) => c.code) };
  if (result.status !== "pass" || !result.checks.some((c) => c.code === "claude_managed_auth_ok")) {
    return { status: "fail", message: `testEnvironment returned ${result.status}.` };
  }
  return { status: "pass", message: "testEnvironment connected to Managed Agents." };
}

async function scenarioSkills(h: Harness, scope: Scope): Promise<Verdict> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "staples-smoke-skill-"));
  scope.cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, SMOKE_SKILL_NAME);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), SMOKE_SKILL_MD);
  const key = `staples/smoke/${SMOKE_SKILL_NAME}`;
  // Fake: answer with the code word only when the skill reached the agent
  // (attached natively, or inlined into the system prompt on fallback).
  if (h.fake) {
    h.fake.queueTurns(({ agent, attachedSkillFiles }) => {
      const attached = [...attachedSkillFiles.values()].some((files) => files.some((f) => f.content.includes(SMOKE_CODE_WORD)));
      const inlined = String(agent.system ?? "").includes(SMOKE_CODE_WORD);
      return [
        { kind: "emit", event: fakeEvents.running() },
        { kind: "emit", event: fakeEvents.agentMessage(attached || inlined ? SMOKE_CODE_WORD : "I do not know a Staples code word.") },
        { kind: "emit", event: fakeEvents.usage({ inputTokens: 200, outputTokens: 5, listCostCents: 1 }) },
        { kind: "emit", event: fakeEvents.idle() },
      ];
    });
  }
  const run = await runAdapter(h, scope, {
    prompt: SKILLS_PROMPT,
    servers: [],
    agentId: SKILLS_AGENT_ID,
    config: {
      ...(h.defaultEnvironmentId ? { environmentId: h.defaultEnvironmentId } : {}),
      paperclipRuntimeSkills: [{ key, runtimeName: SMOKE_SKILL_NAME, source }],
      paperclipSkillSync: { desiredSkills: [key] },
    },
  });
  const reply = run.result.summary ?? "";
  let attachedCount: number | null = null;
  if (run.agentId) {
    try {
      const agent = await h.client.getAgent(run.agentId, { signal: AbortSignal.timeout(15_000) });
      attachedCount = Array.isArray(agent.skills) ? agent.skills.length : null;
    } catch {
      attachedCount = null;
    }
  }
  h.io.out(`  reply: ${clip(reply)}`);
  h.io.out(`  skills on the agent: ${attachedCount ?? "unknown"} (0 means the skill was inlined into the system prompt)`);
  scope.details = { reply: clip(reply), attachedSkills: attachedCount };
  if (run.result.exitCode !== 0) return { status: "fail", message: "the run did not succeed." };
  if (!reply.includes(SMOKE_CODE_WORD)) return { status: "fail", message: `the reply does not contain the code word ${SMOKE_CODE_WORD}.` };
  return {
    status: "pass",
    message: `the agent answered with the skill's code word (${attachedCount ? "attached as a custom skill" : "skill inlined or attachment not reported"}).`,
  };
}

const SCENARIO_FNS: Record<ScenarioName, (h: Harness, scope: Scope) => Promise<Verdict>> = {
  basic: scenarioBasic,
  resume: scenarioResume,
  cancel: scenarioCancel,
  budget: scenarioBudget,
  "tool-error": scenarioToolError,
  "big-result": scenarioBigResult,
  "multi-tool": scenarioMultiTool,
  "networking-limited": scenarioNetworkingLimited,
  models: scenarioModels,
  "test-environment": scenarioTestEnvironment,
  skills: scenarioSkills,
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runSmoke(argv: string[], env: Record<string, string | undefined>, io: SmokeIo): Promise<number> {
  const args = parseSmokeArgs(argv);
  if ("error" in args) {
    io.err(args.error);
    return 1;
  }
  let apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!args.fake && !apiKey) {
    io.err(MISSING_KEY_MESSAGE);
    return 1;
  }

  const fake = args.fake ? await startFakeManagedAgentsServer() : null;
  if (fake) apiKey = fake.apiKey;
  const baseUrl = fake ? fake.baseUrl : env.MANAGED_AGENTS_BASE_URL?.trim() || undefined;
  const h: Harness = {
    io,
    env,
    fake,
    apiKey,
    baseUrl,
    model: env.MANAGED_AGENTS_MODEL?.trim() || undefined,
    client: new ManagedAgentsClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    timeoutMs: resolveTimeoutMs(env),
    defaultEnvironmentId: null,
    unarchived: new Set(),
    allAgentIds: new Set(),
    allEnvironmentIds: new Set(),
  };

  const summary: SmokeSummary = { mode: fake ? "fake" : "live", passed: true, totalCostUsd: 0, scenarios: {} };
  let current: AbortController | null = null;
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      const left = [...h.unarchived];
      io.err(`Interrupted again; exiting without cleanup.${left.length > 0 ? ` Archive these sessions in the Anthropic Console: ${left.join(", ")}.` : ""}`);
      process.exit(130);
    }
    interrupted = true;
    io.err("Ctrl-C: cancelling the current scenario (its sessions will be interrupted and archived); remaining scenarios are skipped. Press Ctrl-C again to exit immediately.");
    current?.abort();
  };
  process.on("SIGINT", onSigint);

  io.out(`Running the claude_managed adapter against ${fake ? "the local fake server (--fake)" : baseUrl ?? "the Anthropic API"}; scenarios: ${args.scenarios.join(", ")}.`);
  try {
    for (const name of args.scenarios) {
      if (interrupted) {
        summary.scenarios[name] = { status: "skipped", message: "skipped after Ctrl-C", costUsd: 0, sessionIds: [], agentIds: [], environmentIds: [] };
        continue;
      }
      current = new AbortController();
      summary.scenarios[name] = await runScenario(h, name, current);
      current = null;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await fake?.close();
  }

  const entries = Object.entries(summary.scenarios) as Array<[ScenarioName, ScenarioSummary]>;
  summary.totalCostUsd = roundUsd(entries.reduce((sum, [, s]) => sum + s.costUsd, 0));
  summary.passed = entries.every(([, s]) => s.status === "pass" || s.status === "info");
  io.out("");
  io.out("Summary:");
  for (const [name, s] of entries) io.out(`  ${s.status.toUpperCase().padEnd(7)} ${name.padEnd(19)} $${s.costUsd}`);
  io.out(`Total cost (USD): ${summary.totalCostUsd} across ${entries.length} scenario(s).`);
  if (!fake && (h.allAgentIds.size > 0 || h.allEnvironmentIds.size > 0)) {
    io.out("The agents and environments were left in place (the adapter reuses them). To remove them, archive or delete them in");
    io.out(`the Anthropic Console: agents ${[...h.allAgentIds].join(", ") || "-"}; environments ${[...h.allEnvironmentIds].join(", ") || "-"}.`);
  }
  if (args.json) io.out(JSON.stringify(summary, null, 2));
  return summary.passed ? 0 : 1;
}

async function runScenario(h: Harness, name: ScenarioName, controller: AbortController): Promise<ScenarioSummary> {
  const { io } = h;
  io.out("");
  io.out(`== ${name} ==`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    io.err(`Timed out after ${Math.round(h.timeoutMs / 1000)}s; cancelling the run (the session will be interrupted and archived).`);
    controller.abort();
  }, h.timeoutMs);
  const scope: Scope = {
    name,
    signal: controller.signal,
    costUsd: 0,
    sessionIds: new Set(),
    agentIds: new Set(),
    environmentIds: new Set(),
    cleanups: [],
    details: {},
  };
  let verdict: Verdict;
  try {
    verdict = await SCENARIO_FNS[name](h, scope);
  } catch (error) {
    verdict = { status: "fail", message: redact(error instanceof Error ? error.message : String(error), h.apiKey) };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) verdict = { status: "fail", message: `the scenario did not finish within ${Math.round(h.timeoutMs / 1000)}s.` };
  else if (controller.signal.aborted && verdict.status !== "fail") verdict = { status: "fail", message: "interrupted (Ctrl-C)." };

  for (const sessionId of scope.sessionIds) {
    try {
      await h.client.archiveSession(sessionId, { signal: AbortSignal.timeout(15_000) });
      h.unarchived.delete(sessionId);
      io.out(`Archived session ${sessionId}.`);
    } catch (error) {
      io.err(`Could not archive session ${sessionId}: ${redact(error instanceof Error ? error.message : String(error), h.apiKey)}`);
    }
  }
  for (const cleanup of scope.cleanups) await cleanup().catch(() => undefined);

  const costUsd = roundUsd(scope.costUsd);
  const ids = {
    sessionIds: [...scope.sessionIds],
    agentIds: [...scope.agentIds],
    environmentIds: [...scope.environmentIds],
  };
  io.out(`ids: sessions ${ids.sessionIds.join(", ") || "-"}; agents ${ids.agentIds.join(", ") || "-"}; environments ${ids.environmentIds.join(", ") || "-"}`);
  io.out(`cost (USD) ${name}: ${costUsd}`);
  const line = `${verdict.status === "pass" ? "PASS" : verdict.status === "info" ? "INFO" : "FAIL"} ${name}: ${verdict.message}`;
  if (verdict.status === "fail") io.err(line);
  else io.out(line);
  return { status: verdict.status, message: verdict.message, costUsd, ...ids, ...(Object.keys(scope.details).length > 0 ? { details: scope.details } : {}) };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function formatEvent(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "claude_managed.init":
      return `[init] session ${String(event.sessionId)} model ${String(event.model)} tools ${String(event.toolCount)} resumed ${String(event.resumed)}`;
    case "claude_managed.message":
      return `[message] ${clip(String(event.text))}`;
    case "claude_managed.tool_use":
      return `[tool call] ${String(event.name)}${event.server ? ` (${String(event.server)})` : ""} ${clip(JSON.stringify(event.input ?? {}), 120)}`;
    case "claude_managed.tool_result":
      return `[tool result] ${String(event.name)}${event.isError ? " (error)" : ""}${event.truncated ? " (truncated)" : ""}: ${clip(String(event.content), 120)}`;
    case "claude_managed.usage":
      return `[usage] in ${String(event.inputTokens)} out ${String(event.outputTokens)} cost $${String(event.costUsd)}`;
    case "claude_managed.error":
      return `[error] ${String(event.errorType ?? "")} ${clip(String(event.message))}${event.retrying ? " (retrying)" : ""}`;
    case "claude_managed.result":
      return `[result] ${String(event.status)}${event.error ? `: ${clip(String(event.error))}` : ""}`;
    default:
      return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

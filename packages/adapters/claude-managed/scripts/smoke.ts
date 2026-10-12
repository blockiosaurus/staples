/**
 * Live smoke test for the claude_managed adapter.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @paperclipai/adapter-claude-managed smoke
 *   pnpm --filter @paperclipai/adapter-claude-managed smoke --fake   # no key, local fake server
 *
 * Runs the real adapter `execute()` once against a minimal fake run context. A
 * single in-process fake Staples MCP server exposes the tool `echo_note`; the
 * prompt asks the agent to call it once. The script prints a compact transcript
 * and fails unless the tool was called. The session is archived at the end.
 *
 * Environment: ANTHROPIC_API_KEY (required unless --fake), MANAGED_AGENTS_BASE_URL
 * and MANAGED_AGENTS_MODEL (optional). The key is never printed.
 *
 * Safety: the run is cancelled after SMOKE_TIMEOUT_MS (default 5 minutes) or on
 * Ctrl-C; the adapter then interrupts the session and the script still archives it.
 * The session id is printed as soon as the session starts, so it is known even if
 * the process is killed hard. SMOKE_FAKE_SCENARIO=never_idle (with --fake) simulates
 * a session that never goes idle, to exercise the timeout path.
 */
import { pathToFileURL } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { ManagedAgentsClient } from "../src/client.js";
import { execute } from "../src/server/execute.js";
import { readSessionParams } from "../src/server/session.js";
import { fakeEvents, startFakeManagedAgentsServer } from "../src/testing/fake-managed-agents-server.js";
import { startFakeMcpServer } from "../src/testing/fake-mcp-server.js";

export const MISSING_KEY_MESSAGE =
  "Set ANTHROPIC_API_KEY to run the live smoke test. It creates a small agent, environment and session on your Anthropic account and archives the session afterwards (a few cents).";

const NOTE = "staples-smoke-note";
export const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;
const RUN_TOKEN = "smoke-run-token";

const PROMPT =
  `This is a connectivity check. Call the tool whose name ends in "echo_note" exactly once, with the argument note set to "${NOTE}". ` +
  "Then reply with one short sentence confirming what the tool returned. Do not call any other tool.";

export interface SmokeIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function resolveTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.SMOKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SMOKE_TIMEOUT_MS;
}

export async function runSmoke(argv: string[], env: Record<string, string | undefined>, io: SmokeIo): Promise<number> {
  const useFake = argv.includes("--fake");
  let apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!useFake && !apiKey) {
    io.err(MISSING_KEY_MESSAGE);
    return 1;
  }

  const fake = useFake ? await startFakeManagedAgentsServer() : null;
  if (fake && env.SMOKE_FAKE_SCENARIO === "never_idle") {
    apiKey = fake.apiKey;
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "emit", event: fakeEvents.agentMessage("Thinking...") },
      { kind: "hang" },
    ]);
  } else if (fake) {
    apiKey = fake.apiKey;
    fake.queueTurns([
      { kind: "emit", event: fakeEvents.running() },
      { kind: "custom_tool_call", name: "staples-smoke__echo_note", input: { note: NOTE } },
      { kind: "emit", event: fakeEvents.agentMessage(`The tool echoed: ${NOTE}`) },
      { kind: "emit", event: fakeEvents.usage({ inputTokens: 120, outputTokens: 30, listCostCents: 1 }) },
      { kind: "emit", event: fakeEvents.idle() },
    ]);
  }
  const baseUrl = fake ? fake.baseUrl : env.MANAGED_AGENTS_BASE_URL?.trim() || undefined;
  const model = env.MANAGED_AGENTS_MODEL?.trim() || undefined;

  const mcp = await startFakeMcpServer({
    token: RUN_TOKEN,
    tools: [
      {
        name: "echo_note",
        description: "Echoes the note it is given. Used by the Staples smoke test.",
        inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
        handler: (args) => ({ content: [{ type: "text", text: `echo: ${String(args.note)}` }] }),
      },
    ],
  });

  let exitCode = 1;
  let client: ManagedAgentsClient | null = null;
  let sessionId: string | null = null;
  let agentId: string | null = null;
  let environmentId: string | null = null;
  /** Ids from the `claude_managed.init` line: known even if execute() never returns a result. */
  let initSessionId: string | null = null;
  let timedOut = false;
  const timeoutMs = resolveTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    io.err(`Timed out after ${Math.round(timeoutMs / 1000)}s; cancelling the run (the session will be interrupted and archived).`);
    controller.abort();
  }, timeoutMs);
  const onSigint = () => {
    if (controller.signal.aborted) {
      io.err(`Interrupted again; exiting without cleanup.${initSessionId ? ` Archive session ${initSessionId} in the Anthropic Console.` : ""}`);
      process.exit(130);
    }
    io.err("Ctrl-C: cancelling the run (the session will be interrupted and archived). Press Ctrl-C again to exit immediately.");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    client = new ManagedAgentsClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    const transcript: string[] = [];
    const ctx: AdapterExecutionContext = {
      runId: `smoke-${Date.now()}`,
      agent: { id: "smoke-agent-0001", companyId: "smoke-company", name: "Smoke", adapterType: "claude_managed", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        env: { ANTHROPIC_API_KEY: apiKey },
        ...(baseUrl ? { apiBaseUrl: baseUrl } : {}),
        ...(model ? { model } : {}),
        promptTemplate: PROMPT,
      },
      context: {},
      signal: controller.signal,
      runtimeMcp: { getServers: () => [{ name: "Staples smoke", url: mcp.url, token: RUN_TOKEN, connectionId: "smoke" }] },
      onLog: async (_stream, chunk) => {
        for (const raw of chunk.split("\n")) {
          if (!raw.startsWith("{")) continue;
          try {
            const event = JSON.parse(raw) as Record<string, unknown>;
            if (event.type === "claude_managed.init" && typeof event.sessionId === "string") {
              initSessionId = event.sessionId;
              agentId = typeof event.agentId === "string" ? event.agentId : agentId;
              environmentId = typeof event.environmentId === "string" ? event.environmentId : environmentId;
              io.out(`Session started: ${event.sessionId} (if this script is killed, archive it in the Anthropic Console).`);
            }
            const text = formatEvent(event);
            if (text) transcript.push(text);
          } catch {
            // not a JSON event line
          }
        }
      },
      onUsage: async () => undefined,
      onEvent: async () => undefined,
      onDispatch: () => undefined,
      onCancellationReady: async () => undefined,
    };

    io.out(`Running the claude_managed adapter against ${fake ? "the local fake server (--fake)" : baseUrl ?? "the Anthropic API"}...`);
    const result = await execute(ctx);
    for (const line of transcript) io.out(`  ${line}`);

    const params = readSessionParams(result.sessionParams);
    sessionId = params?.sessionId ?? initSessionId;
    agentId = params?.managedAgentId ?? agentId;
    environmentId = params?.environmentId ?? environmentId;
    const called = mcp.calls().filter((c) => c.name === "echo_note");

    io.out("");
    io.out(`status:         ${result.exitCode === 0 ? "succeeded" : `failed (${result.errorMessage ?? result.errorCode ?? "unknown error"})`}`);
    io.out(`cost (USD):     ${result.costUsd ?? "unknown"}`);
    io.out(`session id:     ${sessionId ?? "-"}`);
    io.out(`environment id: ${environmentId ?? "-"}`);
    io.out(`agent id:       ${agentId ?? "-"}`);
    io.out(`echo_note calls: ${called.length}`);

    if (timedOut) {
      io.err(`FAIL: the run did not finish within ${Math.round(timeoutMs / 1000)}s.`);
    } else if (result.exitCode !== 0) {
      io.err("FAIL: the run did not succeed.");
    } else if (called.length < 1) {
      io.err("FAIL: the agent never called echo_note.");
    } else {
      io.out("PASS: the run succeeded and echo_note was called through the Staples tools proxy.");
      exitCode = 0;
    }
  } catch (error) {
    io.err(`FAIL: ${redact(error instanceof Error ? error.message : String(error), apiKey)}`);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", onSigint);
    sessionId = sessionId ?? initSessionId;
    if (client && sessionId) {
      try {
        await client.archiveSession(sessionId, { signal: AbortSignal.timeout(15_000) });
        io.out(`Archived session ${sessionId}.`);
      } catch (error) {
        io.err(`Could not archive session ${sessionId}: ${redact(error instanceof Error ? error.message : String(error), apiKey)}`);
      }
    }
    if (!useFake && (agentId || environmentId)) {
      io.out("");
      io.out("The agent and environment were left in place (the adapter reuses them). To remove them, archive or delete them in");
      io.out(`the Anthropic Console: agent ${agentId ?? "<agent id>"}, environment ${environmentId ?? "<environment id>"}.`);
    }
    await mcp.close();
    await fake?.close();
  }
  return exitCode;
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
      return `[tool call] ${String(event.name)} ${clip(JSON.stringify(event.input ?? {}), 120)}`;
    case "claude_managed.tool_result":
      return `[tool result] ${String(event.name)}${event.isError ? " (error)" : ""}: ${clip(String(event.content), 120)}`;
    case "claude_managed.usage":
      return `[usage] in ${String(event.inputTokens)} out ${String(event.outputTokens)} cost $${String(event.costUsd)}`;
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

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Parses the `claude_managed.*` JSON log lines written by the server adapter
 * (see `ClaudeManagedLogEvent` in ../server/execute.ts) into transcript entries.
 * Non-JSON lines and unknown types are kept as plain stdout.
 */

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseClaudeManagedStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  const type = parsed ? asString(parsed.type) : "";
  if (!parsed || !type.startsWith("claude_managed.")) {
    return line.trim() ? [{ kind: "stdout", ts, text: line }] : [];
  }

  switch (type) {
    case "claude_managed.init":
      return [{ kind: "init", ts, model: asString(parsed.model, "claude_managed"), sessionId: asString(parsed.sessionId) }];

    case "claude_managed.status": {
      const message = asString(parsed.message);
      return [{ kind: "system", ts, text: `${asString(parsed.status, "status")}${message ? `: ${message}` : ""}` }];
    }

    case "claude_managed.message": {
      const text = asString(parsed.text).trim();
      return text ? [{ kind: "assistant", ts, text }] : [];
    }

    case "claude_managed.tool_use":
      return [{
        kind: "tool_call",
        ts,
        name: asString(parsed.name, "tool"),
        toolUseId: asString(parsed.id) || undefined,
        input: parsed.input ?? {},
      }];

    case "claude_managed.tool_result": {
      const truncated = parsed.truncated === true ? "\n[output truncated]" : "";
      return [{
        kind: "tool_result",
        ts,
        toolUseId: asString(parsed.id, "tool_result"),
        toolName: asString(parsed.name) || undefined,
        content: `${asString(parsed.content)}${truncated}`,
        isError: parsed.isError === true,
      }];
    }

    case "claude_managed.usage":
      // Running usage checkpoints are recorded by the host; they add nothing to the transcript.
      return [];

    case "claude_managed.error": {
      const message = asString(parsed.message, "error");
      return parsed.retrying === true
        ? [{ kind: "system", ts, text: `retrying: ${message}` }]
        : [{ kind: "stderr", ts, text: message }];
    }

    case "claude_managed.result": {
      const status = asString(parsed.status, "failed");
      const error = asString(parsed.error);
      return [{
        kind: "result",
        ts,
        text: asString(parsed.summary, error),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: asNumber(parsed.costUsd),
        subtype: status,
        isError: status !== "succeeded",
        errors: error ? [error] : [],
      }];
    }

    default:
      return [{ kind: "stdout", ts, text: line }];
  }
}

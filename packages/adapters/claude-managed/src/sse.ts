import type {
  ManagedAgentsEvent,
  MonetaryAmount,
  SessionUsageEvent,
  SessionUsageTotals,
} from "./types.js";

/** One Server-Sent Events frame (https://html.spec.whatwg.org/multipage/server-sent-events.html). */
export interface SseFrame {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Incremental SSE parser. Feed decoded text chunks; complete frames are returned.
 * Handles CRLF/LF/CR line endings, multi-line `data:` fields (joined with "\n"),
 * comment lines (`: keep-alive`), and frames split across chunk boundaries.
 */
export class SseParser {
  private buffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private lastId: string | null = null;
  private sawField = false;

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A trailing lone "\r" may be the first half of "\r\n": wait for more input.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush at end of stream; a final frame without a blank line is dispatched. */
  end(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.buffer.length > 0) {
      const frame = this.processLine(this.buffer);
      this.buffer = "";
      if (frame) frames.push(frame);
    }
    const last = this.dispatch();
    if (last) frames.push(last);
    return frames;
  }

  private processLine(line: string): SseFrame | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        this.sawField = true;
        break;
      case "data":
        this.dataLines.push(value);
        this.sawField = true;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        this.sawField = true;
        break;
      default:
        // `retry:` and unknown fields are ignored.
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    if (!this.sawField) return null;
    const frame: SseFrame | null =
      this.dataLines.length > 0 || this.eventName !== null
        ? { event: this.eventName, data: this.dataLines.join("\n"), id: this.lastId }
        : null;
    this.eventName = null;
    this.dataLines = [];
    this.sawField = false;
    return frame;
  }
}

/** Reads a byte stream and yields SSE frames. */
export async function* readSseFrames(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const parser = new SseParser();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) yield frame;
  }
  const tail = decoder.decode();
  if (tail) for (const frame of parser.push(tail)) yield frame;
  for (const frame of parser.end()) yield frame;
}

/**
 * SSE event names the stream uses for keep-alives. API ASSUMPTION: the docs only
 * show `data:` lines; the official SDK's stream decoder skips `event: ping` frames,
 * so we do the same (and also skip comment lines and empty data).
 */
export const SSE_KEEPALIVE_EVENTS = new Set(["ping"]);

/**
 * API ASSUMPTION: an in-stream failure arrives as `event: error` with an Anthropic
 * error body (`{"type":"error","error":{"type","message"}}`), mirroring the SDK's
 * stream decoder. Returns null for any other frame.
 */
export function sseErrorFromFrame(frame: SseFrame): { type: string; message: string } | null {
  if (frame.event !== "error") return null;
  let body: unknown = frame.data;
  try {
    body = JSON.parse(frame.data);
  } catch {
    // keep raw text
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return {
    type: typeof error?.type === "string" ? error.type : "stream_error",
    message: typeof error?.message === "string" ? error.message : typeof body === "string" ? body : "stream error",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Normalizes a `session.usage` payload. API ASSUMPTION: the SDK types the event as
 * `{ usage: {...snapshot}, budget }`; the docs describe the same fields without
 * showing the event JSON. We also accept the snapshot fields flattened onto the
 * event and a bare-string `list_cost`, in case the wire shape differs.
 */
export function normalizeSessionUsage(raw: Record<string, unknown>): SessionUsageTotals {
  const source = isRecord(raw.usage) ? raw.usage : raw;
  const out: SessionUsageTotals = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "active_seconds"] as const) {
    if (typeof source[key] === "number") out[key] = source[key] as number;
  }
  if (isRecord(source.cache_creation)) out.cache_creation = source.cache_creation as SessionUsageTotals["cache_creation"];
  if (isRecord(source.server_tool_use)) out.server_tool_use = source.server_tool_use as SessionUsageTotals["server_tool_use"];
  const listCost = source.list_cost;
  if (isRecord(listCost) && typeof listCost.amount === "string") {
    out.list_cost = { amount: listCost.amount, currency: str(listCost.currency) || "USD" };
  } else if (typeof listCost === "string" || typeof listCost === "number") {
    out.list_cost = { amount: String(listCost), currency: "USD" };
  }
  return out;
}

/** Converts a `list_cost` (whole cents as a string) to US dollars; null if unparseable or not USD. */
export function listCostToUsd(listCost: MonetaryAmount | null | undefined): number | null {
  if (!listCost) return null;
  if (listCost.currency && listCost.currency.toUpperCase() !== "USD") return null;
  if (!/^\d+$/.test(listCost.amount.trim())) return null;
  return Number(listCost.amount.trim()) / 100;
}

/** Decodes one stream JSON payload into a typed event; unmodeled types become `{ type: "unknown" }`. */
export function decodeManagedAgentsEvent(raw: Record<string, unknown>, fallbackType?: string | null): ManagedAgentsEvent {
  const type = str(raw.type) || fallbackType || "";
  const id = str(raw.id);
  const processed_at = typeof raw.processed_at === "string" ? raw.processed_at : undefined;
  const base = { id, processed_at, raw };
  switch (type) {
    case "agent.message":
      return { ...base, type, content: Array.isArray(raw.content) ? (raw.content as AgentContent) : [] };
    case "agent.tool_use":
    case "agent.custom_tool_use":
      return { ...base, type, name: str(raw.name), input: recordOr(raw.input) };
    case "agent.mcp_tool_use":
      return { ...base, type, name: str(raw.name), mcp_server_name: str(raw.mcp_server_name), input: recordOr(raw.input) };
    case "session.status_running":
    case "session.status_terminated":
    case "session.deleted":
      return { ...base, type };
    case "session.status_idle": {
      const stop = isRecord(raw.stop_reason)
        ? raw.stop_reason
        : { type: typeof raw.stop_reason === "string" ? raw.stop_reason : "end_turn" };
      return { ...base, type, stop_reason: stop as { type: string } };
    }
    case "session.usage": {
      const event: SessionUsageEvent = {
        ...base,
        type,
        usage: normalizeSessionUsage(raw),
        budget: isRecord(raw.budget) ? (raw.budget as unknown as SessionUsageEvent["budget"]) : null,
      };
      return event;
    }
    case "session.error": {
      const error = recordOr(raw.error);
      return {
        ...base,
        type,
        error: { ...error, type: str(error.type) || "unknown_error", message: str(error.message) },
      };
    }
    default:
      return { type: "unknown", eventType: type, id: id || null, raw };
  }
}

type AgentContent = Extract<ManagedAgentsEvent, { type: "agent.message" }>["content"];

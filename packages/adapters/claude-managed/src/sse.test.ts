import { describe, expect, it } from "vitest";
import {
  decodeManagedAgentsEvent,
  listCostToUsd,
  normalizeSessionUsage,
  readSseFrames,
  SseParser,
  sseErrorFromFrame,
} from "./sse.js";

function bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("SseParser", () => {
  it("joins multi-line data fields with newlines", () => {
    const parser = new SseParser();
    const frames = parser.push('event: agent.message\ndata: {"type":\ndata: "agent.message"}\n\n');
    expect(frames).toEqual([{ event: "agent.message", data: '{"type":\n"agent.message"}', id: null }]);
    expect(JSON.parse(frames[0]!.data)).toEqual({ type: "agent.message" });
  });

  it("ignores comment keep-alives and handles CRLF and frames split across chunks", async () => {
    const frames = await collect(
      readSseFrames(bytes(": keep-alive\r\n\r\nid: 7\r\nevent: session.status_running\r\nda", 'ta: {"type":"session.status_running","id":"e1"}\r', "\n\r\n")),
    );
    expect(frames).toEqual([{ event: "session.status_running", data: '{"type":"session.status_running","id":"e1"}', id: "7" }]);
  });

  it("splits multi-byte UTF-8 characters across chunks correctly", async () => {
    const encoded = new TextEncoder().encode('data: {"t":"héllo ✓"}\n\n');
    const cut = encoded.indexOf(0xc3) + 1; // split inside "é"
    const stream = (async function* () {
      yield encoded.slice(0, cut);
      yield encoded.slice(cut);
    })();
    const frames = await collect(readSseFrames(stream));
    expect(JSON.parse(frames[0]!.data)).toEqual({ t: "héllo ✓" });
  });

  it("dispatches a trailing frame without a final blank line at end of stream", async () => {
    const frames = await collect(readSseFrames(bytes('data: {"a":1}')));
    expect(frames).toEqual([{ event: null, data: '{"a":1}', id: null }]);
  });

  it("strips only one leading space after the colon", () => {
    const parser = new SseParser();
    expect(parser.push("data:  two\n\n")).toEqual([{ event: null, data: " two", id: null }]);
  });
});

describe("sseErrorFromFrame", () => {
  it("parses an Anthropic error envelope", () => {
    expect(sseErrorFromFrame({ event: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', id: null })).toEqual({
      type: "overloaded_error",
      message: "busy",
    });
    expect(sseErrorFromFrame({ event: "agent.message", data: "{}", id: null })).toBeNull();
  });
});

describe("decodeManagedAgentsEvent", () => {
  it("decodes custom tool use, idle stop reasons, and errors", () => {
    const tool = decodeManagedAgentsEvent({ type: "agent.custom_tool_use", id: "sevt_1", name: "create_issue", input: { title: "x" } });
    expect(tool).toMatchObject({ type: "agent.custom_tool_use", id: "sevt_1", name: "create_issue", input: { title: "x" } });

    const idle = decodeManagedAgentsEvent({ type: "session.status_idle", id: "e", stop_reason: { type: "requires_action", event_ids: ["sevt_1"] } });
    expect(idle).toMatchObject({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["sevt_1"] } });

    const err = decodeManagedAgentsEvent({ type: "session.error", id: "e2", error: { type: "model_overloaded_error", message: "m", retry_status: { type: "retrying" } } });
    expect(err).toMatchObject({ type: "session.error", error: { type: "model_overloaded_error", message: "m", retry_status: { type: "retrying" } } });
  });

  it("passes unknown events through with their original type and raw payload", () => {
    const raw = { type: "span.model_request_end", id: "e3", model_usage: { input_tokens: 5 } };
    expect(decodeManagedAgentsEvent(raw)).toEqual({ type: "unknown", eventType: "span.model_request_end", id: "e3", raw });
  });

  it("uses the SSE event name when the payload has no type", () => {
    expect(decodeManagedAgentsEvent({ id: "e4" }, "session.status_running")).toMatchObject({ type: "session.status_running" });
  });
});

describe("usage helpers", () => {
  it("normalizes nested and flattened session.usage payloads", () => {
    const nested = normalizeSessionUsage({ usage: { input_tokens: 10, output_tokens: 2, list_cost: { amount: "187", currency: "USD" } } });
    expect(nested).toEqual({ input_tokens: 10, output_tokens: 2, list_cost: { amount: "187", currency: "USD" } });
    const flat = normalizeSessionUsage({ input_tokens: 3, list_cost: "45" });
    expect(flat).toEqual({ input_tokens: 3, list_cost: { amount: "45", currency: "USD" } });
  });

  it("converts whole-cent list cost to dollars", () => {
    expect(listCostToUsd({ amount: "187", currency: "USD" })).toBe(1.87);
    expect(listCostToUsd({ amount: "1.5", currency: "USD" })).toBeNull();
    expect(listCostToUsd({ amount: "100", currency: "EUR" })).toBeNull();
    expect(listCostToUsd(null)).toBeNull();
  });
});

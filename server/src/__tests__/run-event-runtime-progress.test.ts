import { describe, expect, it } from "vitest";
import { buildRunEventRuntimeProgress } from "../services/heartbeat/run-lifecycle.js";

describe("buildRunEventRuntimeProgress", () => {
  const at = new Date("2026-10-13T12:00:00.000Z");

  it("never turns a system-stream event message into the person-facing status", () => {
    expect(buildRunEventRuntimeProgress({
      eventType: "claude_managed.session",
      stream: "system",
      message: "Started Managed Agents session sesn_123",
      payload: { sessionId: "sesn_123" },
      at,
    })).toBeNull();
  });

  it("still reports a tool in use from a system-stream event", () => {
    expect(buildRunEventRuntimeProgress({
      eventType: "tool_call",
      stream: "system",
      message: "tool call",
      payload: { toolName: "Read" },
      at,
    })?.message).toBe("Using Read");
  });

  it("keeps the event message as status for other streams", () => {
    expect(buildRunEventRuntimeProgress({
      eventType: "note",
      stream: "stdout",
      message: "Drafting the reply",
      payload: null,
      at,
    })?.message).toBe("Drafting the reply");
  });
});

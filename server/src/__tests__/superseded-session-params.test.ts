import { describe, expect, it } from "vitest";
import { shouldResetTaskSessionForWake, supersededSessionParamsForRun } from "../services/heartbeat/run-state.js";
import { isConversationAdapter } from "../services/conversation-continuation.js";

const params = { sessionId: "sesn_old", managedAgentId: "agent_1", managedAgentVersion: 1, environmentId: "env_1", fingerprint: "fp" };

describe("supersededSessionParamsForRun", () => {
  it("hands a claude_managed continuation turn the session its fresh session supersedes", () => {
    // A failed claude_managed conversation run is retried/continued with a forced fresh session.
    expect(isConversationAdapter("claude_managed")).toBe(true);
    const resetTaskSession = shouldResetTaskSessionForWake({ forceFreshSession: true, previousRunId: "run-failed" });
    expect(resetTaskSession).toBe(true);
    expect(supersededSessionParamsForRun({ adapterType: "claude_managed", resetTaskSession, sessionParams: params })).toEqual(params);
  });

  it("is null when the session is resumed, for local adapters, or without a stored session", () => {
    expect(supersededSessionParamsForRun({ adapterType: "claude_managed", resetTaskSession: false, sessionParams: params })).toBeNull();
    expect(supersededSessionParamsForRun({ adapterType: "claude_local", resetTaskSession: true, sessionParams: params })).toBeNull();
    expect(supersededSessionParamsForRun({ adapterType: "claude_managed", resetTaskSession: true, sessionParams: null })).toBeNull();
    expect(supersededSessionParamsForRun({ adapterType: "claude_managed", resetTaskSession: true, sessionParams: {} })).toBeNull();
  });
});

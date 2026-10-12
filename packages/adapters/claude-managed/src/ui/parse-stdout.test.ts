import { describe, expect, it } from "vitest";
import { parseClaudeManagedStdoutLine } from "./parse-stdout.js";
import { buildClaudeManagedConfig } from "./build-config.js";
import { getConfigSchema, resolveNetworking } from "../server/index.js";

const ts = "2026-10-12T00:00:00.000Z";
const parse = (event: Record<string, unknown>) => parseClaudeManagedStdoutLine(JSON.stringify(event), ts);

describe("parseClaudeManagedStdoutLine", () => {
  it("parses init, status, message and tool lifecycle lines", () => {
    expect(parse({ type: "claude_managed.init", sessionId: "sesn_1", agentId: "agent_1", agentVersion: 1, environmentId: "env_1", model: "claude-opus-5-5", resumed: false, toolCount: 2 }))
      .toEqual([{ kind: "init", ts, model: "claude-opus-5-5", sessionId: "sesn_1" }]);
    expect(parse({ type: "claude_managed.status", status: "running", message: "Task sent." }))
      .toEqual([{ kind: "system", ts, text: "running: Task sent." }]);
    expect(parse({ type: "claude_managed.message", text: "Working on it." }))
      .toEqual([{ kind: "assistant", ts, text: "Working on it." }]);
    expect(parse({ type: "claude_managed.tool_use", id: "tu_1", kind: "custom", name: "list_issues", server: "project-tools", input: { q: "x" } }))
      .toEqual([{ kind: "tool_call", ts, name: "list_issues", toolUseId: "tu_1", input: { q: "x" } }]);
    expect(parse({ type: "claude_managed.tool_result", id: "tu_1", name: "list_issues", isError: true, content: "boom", truncated: true }))
      .toEqual([{ kind: "tool_result", ts, toolUseId: "tu_1", toolName: "list_issues", content: "boom\n[output truncated]", isError: true }]);
  });

  it("parses errors, usage and results", () => {
    expect(parse({ type: "claude_managed.error", message: "overloaded", retrying: true })).toEqual([{ kind: "system", ts, text: "retrying: overloaded" }]);
    expect(parse({ type: "claude_managed.error", message: "fatal" })).toEqual([{ kind: "stderr", ts, text: "fatal" }]);
    expect(parse({ type: "claude_managed.usage", inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, costUsd: 0.01 })).toEqual([]);
    expect(parse({ type: "claude_managed.result", status: "succeeded", summary: "Done", costUsd: 0.07 })).toEqual([
      { kind: "result", ts, text: "Done", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0.07, subtype: "succeeded", isError: false, errors: [] },
    ]);
    expect(parse({ type: "claude_managed.result", status: "cancelled", error: "Run cancelled." })).toMatchObject([
      { kind: "result", text: "Run cancelled.", subtype: "cancelled", isError: true, errors: ["Run cancelled."] },
    ]);
  });

  it("keeps other lines as stdout", () => {
    expect(parseClaudeManagedStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
    expect(parse({ type: "other.thing" })).toEqual([{ kind: "stdout", ts, text: JSON.stringify({ type: "other.thing" }) }]);
  });
});

describe("claude_managed config", () => {
  it("builds config from schema values, prompt fields and env bindings", () => {
    const config = buildClaudeManagedConfig({
      adapterType: "claude_managed",
      model: " claude-sonnet-5-5 ",
      instructionsFilePath: "AGENTS.md",
      promptTemplate: "",
      bootstrapPrompt: "",
      envVars: "",
      envBindings: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec_1", version: "latest" } },
      adapterSchemaValues: { environmentId: "env_1", networkingMode: "limited", networkAllowedHosts: "api.github.com" },
    } as never);
    expect(config).toMatchObject({
      model: "claude-sonnet-5-5",
      instructionsFilePath: "AGENTS.md",
      environmentId: "env_1",
      networkingMode: "limited",
      env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec_1" } },
    });
  });

  it("reads networking from the flat form keys", () => {
    expect(resolveNetworking({ networkingMode: "limited", networkAllowedHosts: "api.github.com\n example.com, ", networkAllowPackageManagers: true }))
      .toEqual({ type: "limited", allowed_hosts: ["api.github.com", "example.com"], allow_package_managers: true, allow_mcp_servers: false });
    expect(resolveNetworking({ networkingMode: "unrestricted", networkAllowedHosts: "x.com" })).toEqual({ type: "unrestricted" });
    expect(resolveNetworking({})).toEqual({ type: "unrestricted" });
  });

  it("exposes model, environment, API base URL and networking fields", () => {
    const fields = getConfigSchema().fields;
    expect(fields.map((f) => f.key)).toEqual(["model", "environmentId", "apiBaseUrl", "networkingMode", "networkAllowedHosts", "networkAllowPackageManagers"]);
    expect(fields.filter((f) => f.group === "advanced").map((f) => f.key)).toEqual(["apiBaseUrl", "networkingMode", "networkAllowedHosts", "networkAllowPackageManagers"]);
  });
});

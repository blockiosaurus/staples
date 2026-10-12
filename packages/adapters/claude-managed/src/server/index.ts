import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export { execute, coreFingerprint, toolsFingerprint, resolveApiKey, resolveNetworking, resolveRemainingBudgetUsd, DEFAULT_MODEL } from "./execute.js";
export type { ClaudeManagedLogEvent, ExecuteDeps } from "./execute.js";
export { testEnvironment } from "./test-environment.js";
export { sessionCodec, readSessionParams } from "./session.js";
export type { ClaudeManagedSessionParams } from "./session.js";
export { ToolsProxy, buildToolName, mcpResultToToolContent } from "./tools-proxy.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        default: "claude-opus-5-5",
        hint: "Claude model id for this agent.",
      },
      {
        key: "environmentId",
        label: "Environment ID",
        type: "text",
        hint: "Optional. Use an existing Managed Agents cloud environment instead of letting Staples create one.",
      },
      {
        key: "apiBaseUrl",
        label: "API base URL",
        type: "text",
        hint: "Optional. Defaults to https://api.anthropic.com/v1.",
      },
    ],
  };
}

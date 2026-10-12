import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_MODEL } from "./execute.js";

export { execute, summaryPreview, coreFingerprint, toolsFingerprint, resolveApiKey, usesDefaultApiBaseUrl, resolveNetworking, resolveRemainingBudgetUsd, resolveInstanceId, resolveInactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_MODEL, HOSTED_STAPLES_API_NOTE, HOSTED_STAPLES_API_READ_ONLY_NOTE, STAPLES_API_TOOLS_SERVER_NAME } from "./execute.js";
export type { ClaudeManagedLogEvent, ExecuteDeps } from "./execute.js";
export { testEnvironment } from "./test-environment.js";
export {
  listClaudeManagedSkills,
  syncClaudeManagedSkills,
  resolveAgentSkills,
  readLocalSkill,
  buildInlineSkillsSection,
  isSkillsApiRefusal,
  resetSkillsCache,
  skillTitle,
  MAX_INLINE_SKILL_CHARS,
} from "./skills.js";
export type { SkillsResolution, LocalSkill } from "./skills.js";
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
        default: DEFAULT_MODEL,
        hint: "Claude model id for this agent.",
      },
      {
        key: "environmentId",
        label: "Environment ID",
        type: "text",
        hint: "Optional. Use an existing Anthropic cloud environment instead of letting Staples create one.",
      },
      {
        key: "apiBaseUrl",
        label: "API base URL",
        type: "text",
        group: "advanced",
        hint: "Optional. Defaults to https://api.anthropic.com/v1. A custom URL needs this agent's own ANTHROPIC_API_KEY; the server's key is only sent to the default API.",
      },
      {
        key: "networkingMode",
        label: "Sandbox networking",
        type: "select",
        default: "unrestricted",
        group: "advanced",
        options: [
          { value: "unrestricted", label: "Unrestricted" },
          { value: "limited", label: "Limited to allowed hosts" },
        ],
        hint: "Unrestricted lets the agent browse and fetch from any site. Limited blocks everything except the hosts listed below (web search and fetch are limited too).",
      },
      {
        key: "networkAllowedHosts",
        label: "Allowed hosts",
        type: "textarea",
        group: "advanced",
        hint: "One host per line, for example api.github.com.",
        meta: { visibleWhen: { key: "networkingMode", value: "limited" } },
      },
      {
        key: "networkAllowPackageManagers",
        label: "Allow package registries",
        type: "toggle",
        default: false,
        group: "advanced",
        hint: "Also allow npm, PyPI and other package registries.",
        meta: { visibleWhen: { key: "networkingMode", value: "limited" } },
      },
      {
        key: "inactivityTimeoutSec",
        label: "Inactivity timeout (seconds)",
        type: "number",
        default: 900,
        group: "advanced",
        hint: "A run fails and interrupts its session after this long with no activity from Anthropic. Default 900 (15 minutes).",
      },
    ],
  };
}

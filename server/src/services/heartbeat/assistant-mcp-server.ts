import { isAssistantAgent } from "@paperclipai/shared";

export const ASSISTANT_TOOLS_CONNECTION_ID = "staples-assistant-tools";

/**
 * The person-scoped tools server for an Assistant run. Only the Assistant gets
 * it, and only when the adapter received a run JWT to authenticate with.
 */
export function assistantRuntimeMcpServer(input: {
  agent: { metadata?: unknown };
  authToken: string | null | undefined;
  apiBaseUrl: string | null;
}) {
  if (!input.authToken || !input.apiBaseUrl || !isAssistantAgent(input.agent)) return null;
  return {
    name: "Staples assistant",
    url: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/mcp/assistant-tools`,
    token: input.authToken,
    connectionId: ASSISTANT_TOOLS_CONNECTION_ID,
  };
}

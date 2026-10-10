/** Built-in agent key for the per-company Assistant every person chats with. */
export const ASSISTANT_BUILT_IN_AGENT_KEY = "assistant";

const BUILT_IN_AGENT_METADATA_KEY = "paperclipBuiltInAgent";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the agent carries the built-in marker for the Assistant. The
 * Assistant is kept out of staff surfaces (agent lists, org chart, assignee
 * pickers, mentions) and is reachable only through its own chat surface.
 */
export function isAssistantAgent(agent: { metadata?: unknown } | null | undefined): boolean {
  if (!agent || !isPlainRecord(agent.metadata)) return false;
  const marker = agent.metadata[BUILT_IN_AGENT_METADATA_KEY];
  return isPlainRecord(marker) && marker.key === ASSISTANT_BUILT_IN_AGENT_KEY;
}

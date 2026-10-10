import { isAssistantAgent } from "@paperclipai/shared";

/**
 * Drops the built-in Assistant from a staff agent list. Use as a react-query
 * `select` on `queryKeys.agents.list` consumers that render staff surfaces
 * (Agents page, sidebar), so the shared cache still carries the Assistant for
 * name/avatar lookups elsewhere.
 */
export function excludeAssistantAgents<T extends { metadata?: unknown }>(agents: T[]): T[] {
  return agents.filter((agent) => !isAssistantAgent(agent));
}

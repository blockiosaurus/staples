/**
 * Autopilot: per templated agent and outward category, whether the agent asks
 * before acting ("ask", the default from install) or acts on its own ("auto").
 * Autopilot covers routine (write) actions only: destructive actions, and
 * the category's destructive tool names, always ask.
 */
export const AGENT_AUTOPILOT_MODES = ["ask", "auto"] as const;
export type AgentAutopilotMode = (typeof AGENT_AUTOPILOT_MODES)[number];

export interface AgentAutopilotCategory {
  /** The template's outward-action capability, e.g. "email". */
  capability: string;
  label: string;
  /** Display only: the destructive action of this category, which always asks. */
  destructiveLabel: string | null;
  /** The company connection satisfying the capability for this agent, if any. */
  connection: { id: string; appSlug: string; displayName: string } | null;
  /**
   * "auto" only when the agent's Autopilot marker for this category is
   * enabled, is for the connection shown and matches the category's current
   * patterns; otherwise "ask".
   */
  mode: AgentAutopilotMode;
  /** A marker exists but does not apply as shown (switched off, another connection, older patterns). */
  stale: boolean;
  /** False while no usable connection satisfies the capability. */
  canToggle: boolean;
}

export interface AgentAutopilotState {
  categories: AgentAutopilotCategory[];
}

export interface UpdateAgentAutopilot {
  mode: AgentAutopilotMode;
}

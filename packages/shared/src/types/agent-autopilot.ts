/**
 * Autopilot: per templated agent and outward category, whether the agent asks
 * before acting ("ask", the default from install) or acts on its own ("auto").
 * Destructive actions always ask; they are never part of Autopilot.
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
  /** "auto" when the agent's Autopilot rule for this category exists. */
  mode: AgentAutopilotMode;
  /** False while no usable connection satisfies the capability. */
  canToggle: boolean;
}

export interface AgentAutopilotState {
  categories: AgentAutopilotCategory[];
}

export interface UpdateAgentAutopilot {
  mode: AgentAutopilotMode;
}

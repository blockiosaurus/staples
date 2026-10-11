import type { AgentAutopilotCategory, AgentAutopilotMode, AgentAutopilotState } from "@paperclipai/shared";
import { api } from "./client";

/** Autopilot for templated agents (server/src/routes/agent-autopilot.ts). Board users who may configure the agent. */
export const agentAutopilotApi = {
  get: (agentId: string) => api.get<AgentAutopilotState>(`/agents/${encodeURIComponent(agentId)}/autopilot`),
  setMode: (agentId: string, capability: string, mode: AgentAutopilotMode) =>
    api.put<AgentAutopilotCategory>(
      `/agents/${encodeURIComponent(agentId)}/autopilot/${encodeURIComponent(capability)}`,
      { mode },
    ),
};

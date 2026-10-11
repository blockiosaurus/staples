import { z } from "zod";
import { AGENT_AUTOPILOT_MODES } from "../types/agent-autopilot.js";

/** PUT /agents/:agentId/autopilot/:capability. There is no way to name a risk level. */
export const updateAgentAutopilotSchema = z.object({ mode: z.enum(AGENT_AUTOPILOT_MODES) }).strict();

/** The `:capability` path segment (a template capability identifier). */
export const agentAutopilotCapabilitySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

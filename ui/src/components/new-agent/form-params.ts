/**
 * Query parameters the custom new-agent form (`/agents/new/custom`) reads.
 * The marketplace at `/agents/new` forwards links carrying any of them to the form.
 */
export const NEW_AGENT_FORM_PARAMS = {
  name: "name",
  adapterType: "adapterType",
  runnerProvider: "runnerProvider",
  createdAgentId: "createdAgentId",
} as const;

export const NEW_AGENT_FORM_PARAM_KEYS: readonly string[] = Object.values(NEW_AGENT_FORM_PARAMS);

/** Pause reason of a templated agent held until its template setup finishes. */
export const TEMPLATE_SETUP_PAUSE_REASON = "template_setup";

export const TEMPLATE_SETUP_PAUSE_MESSAGE = "Finishing setup — apply the plan again to complete it";

export function isTemplateSetupPause(agent: { status?: string | null; pauseReason?: string | null }): boolean {
  return agent.status === "paused" && agent.pauseReason === TEMPLATE_SETUP_PAUSE_REASON;
}

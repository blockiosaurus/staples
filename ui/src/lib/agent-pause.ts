/** Pause reason of a templated agent held until its template setup finishes. */
export const TEMPLATE_SETUP_PAUSE_REASON = "template_setup";

export const TEMPLATE_SETUP_PAUSE_MESSAGE = "Setup has not finished — apply the same plan again to finish setting up this agent; it resumes on its own after that";

export function isTemplateSetupPause(agent: { status?: string | null; pauseReason?: string | null }): boolean {
  return agent.status === "paused" && agent.pauseReason === TEMPLATE_SETUP_PAUSE_REASON;
}

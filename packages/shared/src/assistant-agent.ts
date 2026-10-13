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

/** The Assistant bundle's weekly update routine (`routines.originId` is `assistant:weekly-update`). */
export const ASSISTANT_WEEKLY_UPDATE_ROUTINE_KEY = "weekly-update";
/** `issues.originKind` of the company's single "Weekly updates" task, which the server creates and owns. */
export const ASSISTANT_WEEKLY_UPDATES_ISSUE_ORIGIN_KIND = "assistant_weekly_updates";
/** Weekly update documents on that task are keyed `weekly-update-YYYY-MM-DD` (the date in the update's time zone). */
export const WEEKLY_UPDATE_DOCUMENT_KEY_PREFIX = "weekly-update-";
/** Home shows the latest weekly update for this many days. */
export const WEEKLY_UPDATE_CARD_MAX_AGE_DAYS = 7;
/** Inbox-dismissal item key for one weekly update document: `weekly-update:<documentId>`. */
export const WEEKLY_UPDATE_DISMISSAL_KEY_PREFIX = "weekly-update:";
/** What "Update me now" on Home sends to the Assistant. */
export const WEEKLY_UPDATE_NOW_PROMPT =
  "Write this week's update now: what shipped, what's blocked and what you need from me, spend against budget, and next week. Save it with the weekly update tool.";

export function weeklyUpdateDismissalKey(documentId: string): string {
  return `${WEEKLY_UPDATE_DISMISSAL_KEY_PREFIX}${documentId}`;
}

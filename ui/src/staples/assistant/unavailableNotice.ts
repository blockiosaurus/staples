/**
 * What a page says when `askAssistant` refuses a message (no Assistant can take
 * it). The tail tells the person what happened to their request on that page.
 */
export function assistantUnavailableNotice(tail: string): string {
  return `The Assistant can't take messages right now — ${tail}`;
}

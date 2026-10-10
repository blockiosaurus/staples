import { assistantPageContextSchema, type AssistantPageContext } from "@paperclipai/shared";
import { formatPaperclipPageContextLine } from "@paperclipai/adapter-utils/server-utils";

/**
 * Display-only context about the page the person was viewing when they sent an
 * Assistant chat message. It is untrusted data: it must never feed authorization.
 */
export function readPageContext(metadata: unknown): AssistantPageContext | null {
  if (!metadata || typeof metadata !== "object") return null;
  const parsed = assistantPageContextSchema.safeParse((metadata as Record<string, unknown>).pageContext);
  return parsed.success ? parsed.data : null;
}

/** Prefix the page-context line (when present) immediately before a user message body. */
export function withPageContextLine(body: string, metadata: unknown): string {
  const line = formatPaperclipPageContextLine(readPageContext(metadata));
  return line ? `${line}\n${body}` : body;
}

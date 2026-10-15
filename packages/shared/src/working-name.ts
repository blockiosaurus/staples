/** A placeholder company name derived from a one-line business description. */
export const WORKING_NAME_MAX_LENGTH = 60;
const FALLBACK = "New business";
const MAX_WORDS = 4;

// Skipped at the start of a description, and ending the name once it has begun.
const FILLER = new Set([
  "i", "im", "i'm", "we", "we're", "were", "my", "our", "want", "wants", "would", "like", "to",
  "start", "starting", "launch", "launching", "open", "opening", "build", "building", "create",
  "creating", "run", "running", "make", "making", "sell", "selling", "a", "an", "the", "some",
  "new", "small", "little", "own", "business", "company", "that", "which", "for", "of", "in", "on",
  "and", "is", "it", "about",
]);

function titleCase(word: string): string {
  return word.split("-").map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part)).join("-");
}

function clip(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
  return trimmed.length > WORKING_NAME_MAX_LENGTH ? trimmed.slice(0, WORKING_NAME_MAX_LENGTH).trimEnd() : trimmed;
}

export function deriveWorkingName(description: string): string {
  const text = description.replace(/\s+/g, " ").replace(/[’]/g, "'").trim();
  if (!text) return FALLBACK;
  const explicit = /\b(?:called|named)\s+([^.,;!?\n]{1,60})/i.exec(text);
  if (explicit?.[1]) return clip(explicit[1]) || FALLBACK;
  const quoted = /["“]([^"”]{1,60})["”]/.exec(text);
  if (quoted?.[1]) return clip(quoted[1]) || FALLBACK;
  const firstClause = text.split(/[.,;!?]/)[0] ?? "";
  const words = firstClause.split(" ").map((w) => w.replace(/^[^\w&-]+|[^\w&-]+$/g, "")).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    const isFiller = FILLER.has(word.toLowerCase());
    if (isFiller && kept.length === 0) continue;
    if (isFiller) break;
    kept.push(word);
    if (kept.length === MAX_WORDS) break;
  }
  return clip(kept.map(titleCase).join(" ")) || FALLBACK;
}

export function extractProviderId(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return null;
  const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
  return provider || null;
}

export function extractProviderIdWithFallback(modelId: string, fallback = "other"): string {
  return extractProviderId(modelId) ?? fallback;
}

export function extractModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return trimmed;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim();
}

/**
 * Built-in adapters whose model list arrives in a deliberate order: Claude and Codex by family
 * and version, the runner's Codex list, Gemini with `Auto` first, Grok, Kimi, OpenClaw, and the
 * OpenCode and Pi lists, which the server sorts when discovered and which lead with the default
 * model when it falls back to the declared list. The model dropdown shows these lists as the
 * adapter advertises them. Cursor is left out because its list comes from `agent models`
 * discovery, whose order can change between refreshes. Adapters not named here, including
 * externally installed ones, keep the dropdown's alphabetical order.
 */
const CURATED_MODEL_ORDER_ADAPTERS: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
]);

export function adapterCuratesModelOrder(adapterType: string): boolean {
  return CURATED_MODEL_ORDER_ADAPTERS.has(adapterType);
}

const CLAUDE = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i;

function titleCase(words: string[]): string {
  return words.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word)).join(" ");
}

/**
 * A readable model name for a raw id ("claude-opus-5-5" → "Claude Opus 5.5").
 * Falls back to title-cased words so an unknown id never shows as a slug.
 */
export function formatModelName(modelId: string): string {
  const id = extractModelName(modelId);
  if (!id) return "";
  const claude = id.match(CLAUDE);
  if (claude) return `Claude ${titleCase([claude[1]])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = id.match(/^gpt-([\w.]+?)(?:-([a-z]+))?$/i);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${titleCase([gpt[2]])}` : ""}`;
  return titleCase(id.split(/[-_]+/).filter(Boolean));
}

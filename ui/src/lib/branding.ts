import { PRODUCT_NAME, PRODUCT_TAGLINE, TERMS_PATH, PRIVACY_PATH } from "@paperclipai/shared";

export { PRODUCT_NAME, PRODUCT_TAGLINE, TERMS_PATH, PRIVACY_PATH };

function optionalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\//.test(trimmed) || trimmed.startsWith("mailto:") ? trimmed : null;
}

/** Operator-set links. A null hides the link that would use it. */
export const DOCS_URL: string | null = optionalUrl(import.meta.env.VITE_DOCS_URL);
export const FEEDBACK_URL: string | null = optionalUrl(import.meta.env.VITE_FEEDBACK_URL);

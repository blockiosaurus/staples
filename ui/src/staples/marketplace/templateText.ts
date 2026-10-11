import {
  Calculator,
  Code,
  Globe,
  LifeBuoy,
  Mail,
  Newspaper,
  PenLine,
  Search,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { APP_DEFINITIONS, type AgentTemplateCategory, type AgentTemplateSummary } from "@paperclipai/shared";
import { getAgentIcon } from "@/lib/agent-icons";

/** Marketplace section order. */
export const MARKETPLACE_CATEGORY_ORDER: readonly AgentTemplateCategory[] = [
  "communication",
  "content",
  "research",
  "operations",
  "engineering",
  "finance",
];

export const MARKETPLACE_CATEGORY_LABELS: Record<AgentTemplateCategory, string> = {
  communication: "Communication",
  content: "Content",
  research: "Research",
  operations: "Operations",
  engineering: "Engineering",
  finance: "Finance",
};

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  calculator: Calculator,
  code: Code,
  globe: Globe,
  "life-buoy": LifeBuoy,
  mail: Mail,
  newspaper: Newspaper,
  "pen-line": PenLine,
  search: Search,
  "share-2": Share2,
};

/** The template's lucide icon by name, falling back to the agent icon set. */
export function templateIcon(name: string): LucideIcon {
  return TEMPLATE_ICONS[name] ?? getAgentIcon(name);
}

const APP_NAME_OVERRIDES: Record<string, string> = { linkedin: "LinkedIn", x: "X" };

/** Display name for an app slug. */
export function appName(slug: string): string {
  const known = APP_DEFINITIONS.find((app) => app.slug === slug)?.name ?? APP_NAME_OVERRIDES[slug];
  if (known) return known;
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** "Gmail or AgentMail". */
export function appChoices(anyOf: string[]): string {
  const names = anyOf.map(appName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** "Needs: Gmail or AgentMail, Google Calendar" or "Works right away" when nothing is required. */
export function needsText(template: Pick<AgentTemplateSummary, "needs">): string {
  const required = template.needs.filter((need) => !need.optional);
  if (required.length === 0) return "Works right away";
  return `Needs: ${required.map((need) => appChoices(need.anyOf)).join(", ")}`;
}

/** "Asks before: Send an email, Publish a post", "Read-only", or null when it neither asks nor is read-only. */
export function asksText(template: Pick<AgentTemplateSummary, "asksBefore" | "readOnly">): string | null {
  if (template.readOnly) return "Read-only";
  if (template.asksBefore.length === 0) return null;
  return `Asks before: ${template.asksBefore.join(", ")}`;
}

/** "$20 a month". */
export function budgetText(cents: number | null): string | null {
  if (cents === null || cents <= 0) return null;
  const dollars = cents / 100;
  const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  return `${amount} a month`;
}

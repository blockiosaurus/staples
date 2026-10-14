# Staples "looks like a product" pass — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person starting a business sees one product named Staples from sign-up through Home, Connectors, Settings and Costs, with no developer vocabulary in default views.

**Architecture:** One shared branding constant feeds the wordmark, titles and copy; a codemod rewrites the remaining person-facing "Paperclip" strings and a guard test keeps them out. Two more guard tests (banned terms in default views) force the jargon fixes. Connectors, Settings and Costs each get a plain default view with the existing machinery moved under an "Advanced" or "Details" disclosure.

**Tech Stack:** pnpm monorepo; Express server (`server/`), React 19 + Vite UI (`ui/`), `@paperclipai/shared` constants, Vitest (`// @vitest-environment jsdom` per UI test file), `sharp` (already a `server/` dependency) for icon generation, TypeScript compiler API for the codemod.

**Spec:** `doc/plans/2026-10-14-staples-product-pass-design.md` (approved). Research notes with exact anchors live in the session scratchpad; this plan carries every anchor an implementer needs.

## Global Constraints

- Branch: `staples/product-pass`. Never commit `.claude/launch.json` (it has a pre-existing local change). Never read `.env.local` or any key or token.
- Product name is the constant `PRODUCT_NAME` from `@paperclipai/shared` (value `"Staples"`). Hub files (document title, wordmark, Auth, legal pages, account menu, bootstrap pages) import the constant; the long tail of copy becomes the literal `Staples` via the codemod. Both are acceptable per the spec.
- Never rename: `@paperclipai/*` package names, `paperclipai/...` skill keys, `paperclip_*` and `paperclip__*` tool names, the `paperclip` skill, `PAPERCLIP_*` env vars, `X-Paperclip-Run-Id`, API paths, CSS class names, identifiers (`PaperclipLoading`, `PaperclipLockup` until deleted), lucide's `Paperclip` icon, and the phrases `Paperclip Labs` (legal entity) and `Paperclip Dot` (external plugin name).
- Banned words in default views (string literals and JSX text): adapter, harness, runtime, session, heartbeat, MCP, API, JSON, provider trace, lifecycle. Strings behind an Advanced disclosure or an admin-only view go in the allowlist with a reason; everything else is rewritten.
- UI token rule: no hex, raw px, arbitrary Tailwind bracket values or raw font-size in `ui/src/components/**` and `ui/src/pages/**`. Run `pnpm check:token-gates` after any UI change. SVG/PNG assets under `ui/public/` are outside the gate.
- Generic product: no ColecoVision-specific content; examples are a candle shop, a dog-walking service, a newsletter.
- Form/dialog footers: Cancel/Back left, primary action right, one row (`DESIGN.md`).
- Tests: one test file per component change; `// @vitest-environment jsdom` for React tests; run single files with `pnpm exec vitest run <path>` from the repo root. Long suites (`pnpm exec vitest run --root ui`) take minutes: start them with `run_in_background: true`, write output to a log file in the scratchpad, and read the log; never block a foreground command for more than 4 minutes.
- Commit after each task with a conventional message and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Bump the Assistant `stockVersion` once in this pass (Task 2) to `"2026-10-14c"`.

## File map

| Area | Create | Modify |
|---|---|---|
| Branding | `packages/shared/src/branding.ts`, `ui/src/lib/branding.ts`, `ui/src/components/ProductWordmark.tsx` (+test), `scripts/brand/generate-icons.mjs`, `ui/public/favicon.svg` and PNG/ICO icons | `packages/shared/src/index.ts`, `ui/src/context/BreadcrumbContext.tsx` (+test), `ui/src/components/SidebarAccountMenu.tsx` (+test), `ui/src/pages/Auth.tsx`, `ui/index.html`, `ui/public/site.webmanifest`, `ui/public/sw.js`, delete `ui/src/components/PaperclipLockup.tsx` |
| Sweep | `scripts/brand/brand-terms.mjs`, `scripts/brand/rebrand-sweep.mjs`, `ui/src/__tests__/brand-guard.test.ts` | ~225 UI files, `server/src/built-ins/**`, `server/src/services/built-in-agents.ts`, `packages/teams-catalog/catalog/**`, `packages/teams-catalog/generated/catalog.json`, `ui/src/components/BootstrapPendingPage.tsx`, `ui/src/components/CloudAccessGate.tsx` |
| Sign-up | `ui/src/pages/legal/LegalPage.tsx`, `TermsPage.tsx`, `PrivacyPage.tsx` (+test) | `ui/src/pages/Auth.tsx` (+test), `ui/src/App.tsx`, `ui/src/staples/start/StartCompanyPage.tsx` (+test) |
| Jargon | `ui/src/__tests__/person-facing-copy.test.ts`, `ui/src/__tests__/person-facing-copy.allowlist.ts`, `ui/src/lib/model-utils.test.ts` | `ui/src/lib/model-utils.ts`, `ui/src/components/AgentActionButtons.tsx`, `ui/src/components/primary-agent/PrimaryAgentPresentation.tsx`, `ui/src/staples/autopilot/AgentTemplateChip.tsx`, `ui/src/pages/AgentDetail.tsx`, `ui/src/components/Identity.tsx`, `ui/src/components/SidebarAccountMenu.tsx`, `ui/src/components/task-chat/TaskChatComposer.tsx`, `ui/src/components/MarkdownEditor.tsx`, `ui/src/components/TaskChatThread.tsx`, `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx`, `ui/src/staples/assistant/*`, tests |
| Connectors | `ui/src/pages/apps/connector-sections.ts` (+test), `ui/src/pages/apps/NeededByTeam.tsx` | `server/src/routes/public-mcp.ts` (+test), `server/src/routes/connection-intents.ts` (+test), `packages/shared/src/types/issue.ts`, `ui/src/api/connection-intents.ts`, `ui/src/pages/apps/Browse.tsx` (+test), `ui/src/pages/apps/app-definition-display.ts` (+test), `packages/shared/src/app-definitions/*.json` (featured), `packages/shared/src/app-definitions.ts` |
| Settings | `ui/src/hooks/useIsInstanceAdmin.ts` (+test), `ui/src/components/InstanceAdminGate.tsx` | `ui/src/pages/CompanySettings.tsx`, `ui/src/pages/InstanceGeneralSettings.tsx` (+test), `ui/src/components/CompanySettingsSidebar.tsx` (+test), `ui/src/App.tsx` |
| Costs | `ui/src/pages/costs/CostsOverview.tsx` (+test), `ui/src/pages/costs/projection.ts` (+test) | `ui/src/pages/Costs.tsx` (+test), `ui/src/staples/home/BriefingRow.tsx` (export form), `ui/src/pages/audit/AuditHub.tsx`, `ui/src/staples/surfaces/registry.ts`, `ui/src/components/Sidebar.test.tsx` |

---

### Task 1: Branding constants, wordmark, icons, title

**Files:**
- Create: `packages/shared/src/branding.ts`
- Modify: `packages/shared/src/index.ts` (append an export line near line 161)
- Create: `ui/src/lib/branding.ts`
- Create: `ui/src/components/ProductWordmark.tsx`, `ui/src/components/ProductWordmark.test.tsx`
- Delete: `ui/src/components/PaperclipLockup.tsx`
- Modify: `ui/src/pages/Auth.tsx:15` (import) and `:111` (usage)
- Modify: `ui/src/context/BreadcrumbContext.tsx:73`, `ui/src/context/BreadcrumbContext.test.tsx:106-120`
- Modify: `ui/src/components/SidebarAccountMenu.tsx:31-32`, `:248-254`, `:276-291`; `ui/src/components/SidebarAccountMenu.test.tsx:300-305`
- Modify: `ui/index.html:7-8`, `ui/public/site.webmanifest`, `ui/public/sw.js:18-19`
- Create: `scripts/brand/generate-icons.mjs`; regenerate `ui/public/favicon.svg`, `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`

**Interfaces:**
- Produces: `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `TERMS_PATH`, `PRIVACY_PATH` from `@paperclipai/shared`; `DOCS_URL: string | null`, `FEEDBACK_URL: string | null` from `@/lib/branding`; `<ProductWordmark className? decorative? />`.

- [ ] **Step 1: Shared constants**

Create `packages/shared/src/branding.ts`:

```ts
/**
 * Product branding. The one source for the person-facing product name; copy
 * that names the product imports these instead of spelling the name out.
 */
export const PRODUCT_NAME = "Staples";
export const PRODUCT_TAGLINE = "Run your business with a team of AI agents you direct";
export const TERMS_PATH = "/terms";
export const PRIVACY_PATH = "/privacy";
```

Append to `packages/shared/src/index.ts` (after the `markdown-work-products.js` export block):

```ts
export { PRODUCT_NAME, PRODUCT_TAGLINE, TERMS_PATH, PRIVACY_PATH } from "./branding.js";
```

- [ ] **Step 2: UI branding module with operator links**

Create `ui/src/lib/branding.ts`:

```ts
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
```

- [ ] **Step 3: Wordmark test (failing)**

Create `ui/src/components/ProductWordmark.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ProductWordmark } from "./ProductWordmark";

function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  flushSync(() => createRoot(container).render(node));
  return container;
}

describe("ProductWordmark", () => {
  it("names the product for assistive tech and shows the wordmark text", () => {
    const container = render(<ProductWordmark />);
    const mark = container.querySelector('[role="img"]');
    expect(mark?.getAttribute("aria-label")).toBe("Staples");
    expect(container.textContent).toContain("Staples");
  });

  it("is hidden from assistive tech when decorative", () => {
    const container = render(<ProductWordmark decorative />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
```

Run: `pnpm exec vitest run ui/src/components/ProductWordmark.test.tsx` — expected FAIL (module not found).

- [ ] **Step 4: Wordmark component**

Create `ui/src/components/ProductWordmark.tsx`:

```tsx
import { PRODUCT_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The typographic product wordmark: a letter mark plus the product name.
 * Size it with a text class on `className`; the mark scales with the text.
 */
export function ProductWordmark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : PRODUCT_NAME}
      aria-hidden={decorative ? true : undefined}
      className={cn("inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground", className)}
    >
      <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">
        {PRODUCT_NAME.charAt(0)}
      </span>
      <span>{PRODUCT_NAME}</span>
    </span>
  );
}
```

Run the test again — expected PASS. Run `pnpm check:token-gates` — expected clean.

- [ ] **Step 5: Replace the lockup**

In `ui/src/pages/Auth.tsx` replace the import on line 15 with `import { ProductWordmark } from "@/components/ProductWordmark";` and line 111 with `<ProductWordmark className="text-xl" />`. Delete `ui/src/components/PaperclipLockup.tsx`. Confirm no other importer: `grep -rn "PaperclipLockup" ui/src` must print nothing.

- [ ] **Step 6: Document title**

`ui/src/context/BreadcrumbContext.tsx`: add `import { PRODUCT_NAME } from "@/lib/branding";` and change line 73 to `const parts = [...pageParts, ...companyPart, PRODUCT_NAME];`. In `BreadcrumbContext.test.tsx` lines 106-120 replace the literal `Paperclip` in the expected titles with `Staples`. Run `pnpm exec vitest run ui/src/context/BreadcrumbContext.test.tsx` — PASS.

- [ ] **Step 7: Account menu links**

`ui/src/components/SidebarAccountMenu.tsx`: delete lines 31-32 (`DOCS_URL`, `FEEDBACK_URL` constants) and add `import { DOCS_URL, FEEDBACK_URL } from "@/lib/branding";`. Wrap the `Documentation` `MenuAction` (lines 248-254) in `{DOCS_URL ? (...) : null}` and the feedback `Tooltip` block (the `{!rail && !isCloud ? (` branch around line 276) in `{!rail && !isCloud && FEEDBACK_URL ? (`. Update `SidebarAccountMenu.test.tsx` around line 300: the existing assertion that the feedback link points at `https://paperclip.ing/feedback` becomes an assertion that no `a[aria-label="Share feedback"]` renders when `FEEDBACK_URL` is unset; add a second test that stubs the module (`vi.mock("@/lib/branding", async (orig) => ({ ...(await orig()), FEEDBACK_URL: "mailto:help@example.com" }))`) and expects the link href `mailto:help@example.com`. Run that test file — PASS.

- [ ] **Step 8: Static shell files**

`ui/index.html` line 7 `content="Staples"`, line 8 `<title>Staples</title>`; lines 52, 85, 100 replace `Paperclip` with `Staples` in the startup-error copy (leave the element id `paperclip-startup-title`). `ui/public/site.webmanifest`: `"name": "Staples"`, `"short_name": "Staples"`, `"description": "Run your business with a team of AI agents you direct."`. `ui/public/sw.js` lines 18-19: `Staples is offline` (leave the cache name on line 9).

- [ ] **Step 9: Icon generator**

Create `scripts/brand/generate-icons.mjs`:

```js
#!/usr/bin/env node
// Generates the Staples letter-mark favicon set into ui/public. Run from the
// repo root: `node scripts/brand/generate-icons.mjs`. Uses the `sharp`
// dependency that server/ already carries.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const sharp = require("sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "ui/public");
mkdirSync(out, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#18181b"/>
  <text x="32" y="45" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#ffffff">S</text>
</svg>
`;
writeFileSync(path.join(out, "favicon.svg"), svg);

async function png(size) {
  return sharp(Buffer.from(svg), { density: 512 }).resize(size, size).png().toBuffer();
}

/** ICO container holding PNG-encoded images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); entry.writeUInt8(0, 3); entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length; entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const sizes = { "favicon-16x16.png": 16, "favicon-32x32.png": 32, "apple-touch-icon.png": 180, "android-chrome-192x192.png": 192, "android-chrome-512x512.png": 512 };
for (const [file, size] of Object.entries(sizes)) writeFileSync(path.join(out, file), await png(size));
writeFileSync(path.join(out, "favicon.ico"), ico([{ size: 16, data: await png(16) }, { size: 32, data: await png(32) }, { size: 48, data: await png(48) }]));
console.log(`wrote ${Object.keys(sizes).length + 2} icons to ${out}`);
```

Run: `node scripts/brand/generate-icons.mjs`. Expected: "wrote 7 icons". Check `file ui/public/favicon.ico ui/public/favicon-32x32.png` reports an icon and a PNG. Leave `ui/public/worktree-favicon*` alone (dev-only variants) and never touch `ui/public/brands/**` (third-party logos).

- [ ] **Step 10: Typecheck and commit**

Run `pnpm --filter @paperclipai/shared typecheck` and `pnpm --filter @paperclipai/ui typecheck` (background, log file). Then:

```bash
git add packages/shared/src/branding.ts packages/shared/src/index.ts ui/src/lib/branding.ts ui/src/components/ProductWordmark.tsx ui/src/components/ProductWordmark.test.tsx ui/src/pages/Auth.tsx ui/src/context ui/src/components/SidebarAccountMenu.tsx ui/src/components/SidebarAccountMenu.test.tsx ui/index.html ui/public/site.webmanifest ui/public/sw.js ui/public/favicon.svg ui/public/favicon.ico ui/public/favicon-16x16.png ui/public/favicon-32x32.png ui/public/apple-touch-icon.png ui/public/android-chrome-192x192.png ui/public/android-chrome-512x512.png scripts/brand/generate-icons.mjs
git rm ui/src/components/PaperclipLockup.tsx
git commit -m "feat(brand): Staples constants, wordmark, letter-mark icons, document title"
```

---

### Task 2: Rebrand sweep and guard test

**Files:**
- Create: `scripts/brand/brand-terms.mjs` (shared matcher), `scripts/brand/rebrand-sweep.mjs` (codemod), `ui/src/__tests__/brand-guard.test.ts`
- Modify (by codemod): `ui/src/**/*.{ts,tsx}` including tests, `server/src/built-ins/**/*.md`, `server/src/services/built-in-agents.ts`, `server/src/services/plan-templates.ts`, `packages/teams-catalog/catalog/**/*.md`
- Modify by hand: `ui/src/components/BootstrapPendingPage.tsx:79,123,142`, `ui/src/components/CloudAccessGate.tsx:35`, `ui/src/App.test.tsx` (matching expectations), `server/src/services/built-in-agents.ts:393,470,542` (stock versions)
- Regenerate: `packages/teams-catalog/generated/catalog.json`

**Interfaces:**
- Produces: `findBrandMentions(source, ext) => Array<{ line: number; text: string }>` and `rewriteBrand(source, ext) => string` from `scripts/brand/brand-terms.mjs`.

- [ ] **Step 1: Shared matcher**

Create `scripts/brand/brand-terms.mjs`:

```js
// Rules shared by the rebrand codemod and its guard test. A "mention" is the
// word Paperclip inside person-facing text: string literals, template parts
// and JSX text in TypeScript files; any text in markdown/html/json/js files.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const SWEEP_ROOTS = [
  "ui/src",
  "ui/index.html",
  "ui/public/site.webmanifest",
  "ui/public/sw.js",
  "server/src/built-ins",
  "server/src/services/built-in-agents.ts",
  "server/src/services/plan-templates.ts",
  "packages/teams-catalog/catalog",
];
export const SWEEP_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json", ".js", ".html", ".webmanifest"]);
export const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "generated", "brands"]);
/** Phrases that keep the upstream name on purpose (a legal entity, an external plugin). */
export const KEEP_PHRASES = ["Paperclip Labs", "Paperclip Dot"];

const WORD = /(?<![\w@/.\-<])Paperclip(?![\w])/g;
const NEW_NAME = "Staples";

function keepAt(text, index) {
  return KEEP_PHRASES.some((phrase) => text.startsWith(phrase, index));
}

/** Rewrites one piece of person-facing text. "Paperclip's" becomes "Staples'". */
export function rewriteText(text) {
  const swapped = text.replace(WORD, (match, offset, whole) => (keepAt(whole, offset) ? match : NEW_NAME));
  return swapped.replace(/Staples's\b/g, "Staples'");
}

function mentionsInText(text, baseOffset) {
  const found = [];
  for (const match of text.matchAll(WORD)) {
    if (keepAt(text, match.index)) continue;
    found.push(baseOffset + match.index);
  }
  return found;
}

function isInsideImportOrExport(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isImportEqualsDeclaration(current)) return true;
  }
  return false;
}

function isTestIdAttribute(node) {
  const parent = node.parent;
  return parent && ts.isJsxAttribute(parent) && parent.name.getText() === "data-testid";
}

/** Text-bearing nodes a person can read: string literals, template parts, JSX text. */
function textNodes(sourceFile) {
  const nodes = [];
  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))
      && !isInsideImportOrExport(node) && !isTestIdAttribute(node)
      && !(node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    ) {
      nodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

function parse(source, ext) {
  return ts.createSourceFile("file" + ext, source, ts.ScriptTarget.Latest, true, ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Byte ranges [start, end) of readable text inside a TS/TSX source. */
function textRanges(source, ext) {
  const sourceFile = parse(source, ext);
  return textNodes(sourceFile).map((node) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    // Strip the quote/backtick delimiters so replacements never touch them.
    const text = source.slice(start, end);
    const lead = /^["'`]|^}/.test(text) ? 1 : 0;
    const trail = /["'`]$|\${$/.test(text) ? (text.endsWith("${") ? 2 : 1) : 0;
    return [start + lead, end - trail];
  });
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function lineText(source, index) {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? undefined : end).trim();
}

export function findBrandMentions(source, ext) {
  const offsets = ext === ".ts" || ext === ".tsx"
    ? textRanges(source, ext).flatMap(([start, end]) => mentionsInText(source.slice(start, end), start))
    : mentionsInText(source, 0);
  return offsets.map((index) => ({ line: lineOf(source, index), text: lineText(source, index) }));
}

export function rewriteBrand(source, ext) {
  if (ext !== ".ts" && ext !== ".tsx") return rewriteText(source);
  const ranges = textRanges(source, ext).sort((a, b) => b[0] - a[0]);
  let output = source;
  for (const [start, end] of ranges) {
    output = output.slice(0, start) + rewriteText(output.slice(start, end)) + output.slice(end);
  }
  return output;
}

export function shouldSweepFile(filePath) {
  if (!SWEEP_EXTENSIONS.has(path.extname(filePath))) return false;
  return !filePath.split(path.sep).some((part) => SKIP_DIR_NAMES.has(part));
}
```

- [ ] **Step 2: Matcher unit test (failing first, then passing)**

Create `scripts/brand/brand-terms.test.mjs` (run with `node --test scripts/brand/brand-terms.test.mjs`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { findBrandMentions, rewriteBrand, rewriteText } from "./brand-terms.mjs";

test("rewrites readable text only", () => {
  const src = `import { Paperclip } from "lucide-react";
import { PaperclipLoading } from "./x";
const a = "Sign in to Paperclip";
const b = \`Connect \${name} to Paperclip\`;
const c = <p>Welcome to Paperclip's board <Paperclip /></p>;
const d = { label: "Paperclip Labs", icon: Paperclip };
const e = "@paperclipai/shared"; const f = "paperclip_connection";
`;
  const out = rewriteBrand(src, ".tsx");
  assert.match(out, /Sign in to Staples/);
  assert.match(out, /Connect \$\{name\} to Staples/);
  assert.match(out, /Welcome to Staples' board <Paperclip \/>/);
  assert.match(out, /Paperclip Labs/);
  assert.match(out, /import \{ Paperclip \} from "lucide-react"/);
  assert.match(out, /PaperclipLoading/);
  assert.match(out, /icon: Paperclip/);
  assert.match(out, /@paperclipai\/shared/);
  assert.equal(findBrandMentions(out, ".tsx").length, 0);
});

test("reports remaining mentions with line numbers", () => {
  const src = `const x = 1;\nconst y = "Paperclip host";\n`;
  assert.deepEqual(findBrandMentions(src, ".ts"), [{ line: 2, text: 'const y = "Paperclip host";' }]);
});

test("markdown is plain text", () => {
  assert.equal(rewriteText("You are Paperclip's coach at Paperclip. Keep Paperclip Dot."), "You are Staples' coach at Staples. Keep Paperclip Dot.");
});
```

Run it; fix the matcher until all three pass.

- [ ] **Step 3: Codemod**

Create `scripts/brand/rebrand-sweep.mjs`:

```js
#!/usr/bin/env node
// One-shot, idempotent rebrand sweep. Run from the repo root:
//   node scripts/brand/rebrand-sweep.mjs          # rewrite files
//   node scripts/brand/rebrand-sweep.mjs --check  # list remaining mentions, exit 1 if any
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SWEEP_ROOTS, findBrandMentions, rewriteBrand, shouldSweepFile } from "./brand-terms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");

function* walk(target) {
  const stat = statSync(target);
  if (stat.isFile()) { if (shouldSweepFile(target)) yield target; return; }
  for (const entry of readdirSync(target)) {
    const full = path.join(target, entry);
    if (statSync(full).isDirectory()) { if (!shouldSweepFile(path.join(full, "x.ts"))) continue; yield* walk(full); }
    else if (shouldSweepFile(full)) yield full;
  }
}

let changed = 0;
const remaining = [];
for (const relative of SWEEP_ROOTS) {
  for (const file of walk(path.join(root, relative))) {
    const ext = path.extname(file);
    const source = readFileSync(file, "utf8");
    if (check) {
      for (const mention of findBrandMentions(source, ext)) remaining.push(`${path.relative(root, file)}:${mention.line}  ${mention.text}`);
      continue;
    }
    const output = rewriteBrand(source, ext);
    if (output !== source) { writeFileSync(file, output); changed += 1; }
  }
}
if (check) {
  if (remaining.length) { console.log(remaining.join("\n")); process.exitCode = 1; }
  else console.log("no person-facing Paperclip mentions");
} else {
  console.log(`rewrote ${changed} files`);
}
```

Run `node scripts/brand/rebrand-sweep.mjs --check | wc -l` first and note the count (expect several hundred). Then `node scripts/brand/rebrand-sweep.mjs`, then `--check` again — expected "no person-facing Paperclip mentions". Review `git diff --stat` and spot-check 10 files for damaged code (quotes, template braces, lucide icons). If a file was damaged, fix the matcher, `git checkout` the sweep roots, and rerun.

- [ ] **Step 4: Manual copy that reads wrong after the swap**

- `ui/src/components/BootstrapPendingPage.tsx:79` → `This workspace is waiting on its first admin`; `:123` and `:142` → `Finish setting up this workspace`. Update the matching expectations in `ui/src/App.test.tsx` (lines ~223, 272, 274, 334, 336).
- `ui/src/components/CloudAccessGate.tsx:35` → `` {temporary ? `Reconnecting to ${PRODUCT_NAME}` : `Unable to load ${PRODUCT_NAME}`} `` with `import { PRODUCT_NAME } from "@/lib/branding";`. `App.test.tsx` lines ~134 and ~232 expect `Unable to load Staples` (the codemod already rewrote them; confirm).
- `ui/src/staples/start/StartCompanyPage.tsx` lines 48-55 now say "Staples Cloud"; leave (Task 3 reworks this page's main title only).
- `server/src/services/built-in-agents.ts`: confirm the codemod left `readPaperclipSkillSyncPreference` and every `canonicalKey`/`key: paperclipai/...` untouched (`grep -n "paperclipai/" server/src/services/built-in-agents.ts` still lists them). Set the stock versions: line 393 `"2026-10-14c"`, line 470 (reflection-coach) `"2026-10-14"`, line 542 (summarizer) `"2026-10-14"`.
- Regenerate the teams catalog manifest: `pnpm --filter @paperclipai/teams-catalog build:manifest` and stage `packages/teams-catalog/generated/catalog.json`.

- [ ] **Step 5: Guard test**

Create `ui/src/__tests__/brand-guard.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/no-relative-packages
import { SWEEP_ROOTS, findBrandMentions, shouldSweepFile } from "../../../scripts/brand/brand-terms.mjs";

const repoRoot = path.resolve(__dirname, "../../..");

function* walk(target: string): Generator<string> {
  if (statSync(target).isFile()) { if (shouldSweepFile(target)) yield target; return; }
  for (const entry of readdirSync(target)) {
    const full = path.join(target, entry);
    if (statSync(full).isDirectory()) { if (shouldSweepFile(path.join(full, "x.ts"))) yield* walk(full); }
    else if (shouldSweepFile(full)) yield full;
  }
}

describe("brand guard", () => {
  it("has no person-facing 'Paperclip' in the swept roots", () => {
    const offenders: string[] = [];
    for (const relative of SWEEP_ROOTS as string[]) {
      for (const file of walk(path.join(repoRoot, relative))) {
        const source = readFileSync(file, "utf8");
        for (const mention of findBrandMentions(source, path.extname(file))) {
          offenders.push(`${path.relative(repoRoot, file)}:${mention.line}  ${mention.text}`);
        }
      }
    }
    expect(offenders, `Rename these to the product name (see scripts/brand/brand-terms.mjs):\n${offenders.join("\n")}`).toEqual([]);
  });
});
```

Run `pnpm exec vitest run ui/src/__tests__/brand-guard.test.ts` — PASS, under 30 s. If vitest refuses the `.mjs` import from outside `ui/`, add `test.server.deps.inline: [/scripts\/brand/]` to `ui/vitest.config.ts` and say so in the task report.

- [ ] **Step 6: Test fallout**

Run the UI suite in the background: `pnpm exec vitest run --root ui > <scratchpad>/ui-tests.log 2>&1` and the server tests that touch built-ins: `pnpm exec vitest run server/src/__tests__/built-in-agent-routes.test.ts server/src/__tests__/assistant-routes.test.ts server/src/__tests__/invite-onboarding-text.test.ts server/src/__tests__/agent-commentary-skills.test.ts server/src/__tests__/teams-catalog-service.test.ts`. Fix every failing assertion by updating the expectation to the new copy (never by restoring "Paperclip" in product copy). Typical: `Auth.test.tsx` "Continue to Staples Cloud", `StartCompanyPage.test.tsx` "Staples Cloud", `IssueChatThreadSystemNotice.test.tsx`, `AppsConnect.test.tsx`.

- [ ] **Step 7: Typecheck, token gates, commit**

`pnpm -r typecheck` (background) and `pnpm check:token-gates`. Commit:

```bash
git add -A ui/src server/src/built-ins server/src/services/built-in-agents.ts server/src/services/plan-templates.ts packages/teams-catalog/catalog packages/teams-catalog/generated/catalog.json scripts/brand ui/index.html ui/public/site.webmanifest ui/public/sw.js
git commit -m "feat(brand): sweep person-facing Paperclip copy to Staples; guard test"
```

Confirm `git status` shows `.claude/launch.json` still unstaged.

---

### Task 3: Sign-up page, legal pages, start page

**Files:**
- Modify: `ui/src/pages/Auth.tsx:108-121` (header), `:207-219` (toggle, add legal footer after it); `ui/src/pages/Auth.test.tsx`
- Create: `ui/src/pages/legal/LegalPage.tsx`, `ui/src/pages/legal/TermsPage.tsx`, `ui/src/pages/legal/PrivacyPage.tsx`, `ui/src/pages/legal/LegalPage.test.tsx`
- Modify: `ui/src/App.tsx` (imports near line 93-104; routes after line 588 `invite/:token`)
- Modify: `ui/src/staples/start/StartCompanyPage.tsx:97-106`; `ui/src/staples/start/StartCompanyPage.test.tsx:87`

**Interfaces:**
- Consumes: `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `TERMS_PATH`, `PRIVACY_PATH` from `@/lib/branding`; `ProductWordmark`.
- Produces: routes `/terms` and `/privacy` reachable signed out; `LegalPage({ title, updated, children })`.

- [ ] **Step 1: Legal page test (failing)**

Create `ui/src/pages/legal/LegalPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TermsPage } from "./TermsPage";
import { PrivacyPage } from "./PrivacyPage";

function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  flushSync(() => createRoot(container).render(<MemoryRouter>{node}</MemoryRouter>));
  return container;
}

describe("legal pages", () => {
  it("terms page names the product and is marked as a draft", () => {
    const container = render(<TermsPage />);
    expect(container.querySelector("h1")?.textContent).toBe("Terms of service");
    expect(container.textContent).toContain("Staples");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Draft");
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
  });

  it("privacy page links back to terms and sign-in", () => {
    const container = render(<PrivacyPage />);
    expect(container.querySelector("h1")?.textContent).toBe("Privacy policy");
    expect(container.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(container.querySelector('a[href="/auth"]')).not.toBeNull();
  });
});
```

Check how other UI tests import the router: `grep -rn "MemoryRouter" ui/src/pages/Costs.test.tsx | head -2` and copy that import path if it differs from `react-router-dom`.

Run: `pnpm exec vitest run ui/src/pages/legal/LegalPage.test.tsx` — FAIL (modules missing).

- [ ] **Step 2: Legal layout and pages**

Create `ui/src/pages/legal/LegalPage.tsx`:

```tsx
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { ProductWordmark } from "@/components/ProductWordmark";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/branding";

/** Shared shell for the signed-out legal pages. Static copy only; no company context. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-background px-4 py-12 text-foreground">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <Link to="/auth" className="inline-flex" aria-label="Back to sign in">
          <ProductWordmark />
        </Link>
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">Last updated {updated}</p>
          <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            Draft, not yet reviewed. This page is a placeholder until our terms are finalized.
          </p>
        </header>
        <div className="space-y-6 text-sm leading-relaxed [&_h2]:text-base [&_h2]:font-semibold">{children}</div>
        <footer className="flex flex-wrap gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
          <Link to={TERMS_PATH} className="hover:text-foreground">Terms of service</Link>
          <Link to={PRIVACY_PATH} className="hover:text-foreground">Privacy policy</Link>
          <Link to="/auth" className="hover:text-foreground">Sign in</Link>
        </footer>
      </div>
    </main>
  );
}
```

Create `ui/src/pages/legal/TermsPage.tsx`:

```tsx
import { LegalPage } from "./LegalPage";
import { PRODUCT_NAME } from "@/lib/branding";

export function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="October 14, 2026">
      <section>
        <h2>What {PRODUCT_NAME} is</h2>
        <p>{PRODUCT_NAME} lets you run a business with AI agents you direct. You stay in charge: agents ask before they do anything public or spend money beyond the limits you set.</p>
      </section>
      <section>
        <h2>Your account</h2>
        <p>You are responsible for what happens under your account and for keeping your password private. Tell us right away if you think someone else has used it.</p>
      </section>
      <section>
        <h2>Your content</h2>
        <p>What you and your agents create belongs to you. We use it only to run the service for you.</p>
      </section>
      <section>
        <h2>Fees and limits</h2>
        <p>Usage counts against the spending limits shown in Costs. We will not charge beyond a limit you have not raised.</p>
      </section>
      <section>
        <h2>Changes</h2>
        <p>We may update these terms. We will show the date of the latest change at the top of this page.</p>
      </section>
    </LegalPage>
  );
}
```

Create `ui/src/pages/legal/PrivacyPage.tsx`:

```tsx
import { LegalPage } from "./LegalPage";
import { PRODUCT_NAME } from "@/lib/branding";

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="October 14, 2026">
      <section>
        <h2>What we collect</h2>
        <p>Your name, email address, and the content you and your agents create in {PRODUCT_NAME}.</p>
      </section>
      <section>
        <h2>How we use it</h2>
        <p>To run the service, to send you the updates you ask for, and to keep your account secure. We do not sell your data.</p>
      </section>
      <section>
        <h2>Services you connect</h2>
        <p>When you connect a service such as email or payments, agents use that access only for the work you assign. You can disconnect a service at any time from Connectors.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can export your company data from Settings. Contact us to delete your account.</p>
      </section>
    </LegalPage>
  );
}
```

Run the test — PASS. Run `pnpm check:token-gates` — clean (the `[&_h2]` selector carries no value and passes Gate 2; if it fails, move the heading styles to explicit `className="text-base font-semibold"` on each `h2`).

- [ ] **Step 3: Routes**

In `ui/src/App.tsx` add imports beside the other page imports (around lines 93-104):

```tsx
import { TermsPage } from "./pages/legal/TermsPage";
import { PrivacyPage } from "./pages/legal/PrivacyPage";
```

After `<Route path="invite/:token" element={<InviteLandingPage />} />` (line 588) add:

```tsx
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
```

- [ ] **Step 4: Auth page copy**

In `ui/src/pages/Auth.tsx` add `import { Link } from "@/lib/router";` (if `Link` is not already imported; `useNavigate` comes from the same module) and `import { PRIVACY_PATH, PRODUCT_NAME, PRODUCT_TAGLINE, TERMS_PATH } from "@/lib/branding";`. Replace lines 110-121 (the wordmark `div`, the `h1` and the `p`) with:

```tsx
          <div className="mb-8">
            <ProductWordmark className="text-xl" />
          </div>

          <h1 className="text-2xl font-semibold leading-tight">{PRODUCT_TAGLINE}</h1>
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground" aria-label="Examples">
            <li>A candle shop that needs an online store and a newsletter.</li>
            <li>A dog-walking service that needs bookings and reminders.</li>
            <li>A newsletter that needs writing, sending and subscriber care.</li>
          </ul>

          <h2 className="mt-8 text-lg font-semibold">
            {mode === "sign_in" ? `Sign in to ${PRODUCT_NAME}` : `Create your ${PRODUCT_NAME} account`}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "sign_in"
              ? "Use your email and password."
              : "Use your email and a password of at least 8 characters."}
          </p>
```

After the mode-toggle `div` (ends line 219) add:

```tsx
          <p className="mt-6 text-xs text-muted-foreground">
            By continuing you agree to the{" "}
            <Link to={TERMS_PATH} className="underline underline-offset-2 hover:text-foreground">Terms</Link>
            {" "}and{" "}
            <Link to={PRIVACY_PATH} className="underline underline-offset-2 hover:text-foreground">Privacy policy</Link>.
          </p>
```

Keep the form, input ids, `autoComplete`, aria attributes and the "Create one"/"Sign in" button text unchanged (tests depend on them).

Add to `ui/src/pages/Auth.test.tsx` (inside the existing describe, using its render helper and the default authenticated health mock):

```tsx
  it("explains the product and links the legal pages", async () => {
    const { container } = await renderAuth();
    expect(container.querySelector("h1")?.textContent).toBe("Run your business with a team of AI agents you direct");
    expect(container.querySelector('ul[aria-label="Examples"]')?.children.length).toBe(3);
    expect(container.querySelector("h2")?.textContent).toBe("Sign in to Staples");
    expect(container.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(container.textContent).not.toContain("instance");
    expect(container.textContent).not.toContain("v1");
  });
```

Read the file's existing helper name first (it may be `renderAuthPage` or inline); match it. Run `pnpm exec vitest run ui/src/pages/Auth.test.tsx` — PASS.

- [ ] **Step 5: Start page copy**

In `ui/src/staples/start/StartCompanyPage.tsx` line 97 title → `"What's your business called?"`; line 100 label → `Business name`; line 106 placeholder → `"Lantern Candle Co"`; after the `Input` (line 108) add `<p className="text-xs text-muted-foreground">You can change this later.</p>`. In `StartCompanyPage.test.tsx` line 87 expect `"What's your business called?"`. Run that test file — PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Auth.tsx ui/src/pages/Auth.test.tsx ui/src/pages/legal ui/src/App.tsx ui/src/staples/start
git commit -m "feat(auth): product sign-up copy, draft terms and privacy pages, business-name start page"
```

---

### Task 4: Banned-terms guard and the agent-page fixes it forces

**Files:**
- Create: `ui/src/__tests__/person-facing-copy.test.ts`, `ui/src/__tests__/person-facing-copy.allowlist.ts`
- Create: `ui/src/lib/model-utils.test.ts`; Modify: `ui/src/lib/model-utils.ts`
- Modify: `ui/src/components/AgentActionButtons.tsx:386-395, 416-429, 465-514` (+ `AgentActionButtons.test.tsx`, `ui/src/pages/Agents.test.tsx` references)
- Modify: `ui/src/components/primary-agent/PrimaryAgentPresentation.tsx:34-38, 47-48, 59, 80-90`
- Modify: `ui/src/staples/autopilot/AgentTemplateChip.tsx:6, 22-25` (+ its test if present)
- Modify: `ui/src/pages/AgentDetail.tsx:242-247, 1687-1690, 1713-1715, 1776-1781, 1805, 1818, 1830, 1836-1850, 1908-1919` and the `AgentOverview` props (`:1752`) plus the call site `:1431-1432`; `ui/src/pages/AgentOverview.test.tsx`
- Modify: `ui/src/components/Identity.tsx:16-20` (+ test), `ui/src/components/SidebarAccountMenu.tsx:156,158`
- Modify: `ui/src/staples/assistant/setup-reasons.ts`, `ui/src/staples/assistant/AssistantSetupCard.tsx` (only the strings the guard flags)

**Interfaces:**
- Produces: `formatModelName(modelId: string): string` in `@/lib/model-utils`; `AgentOverview` gains `showSkills: boolean`; the guard test's `SCAN_TARGETS` list that Task 5 extends.

- [ ] **Step 1: Model name helper (test first)**

Create `ui/src/lib/model-utils.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatModelName } from "./model-utils";

describe("formatModelName", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["gpt-5.6", "GPT-5.6"],
    ["openai/gpt-5.6-mini", "GPT-5.6 Mini"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["grok-4", "Grok 4"],
    ["some-vendor-model", "Some Vendor Model"],
    ["  ", ""],
  ])("%s → %s", (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });
});
```

Run: FAIL (not exported). Append to `ui/src/lib/model-utils.ts`:

```ts
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
```

Run: PASS.

- [ ] **Step 2: Guard test (failing)**

Create `ui/src/__tests__/person-facing-copy.allowlist.ts`:

```ts
/**
 * Strings that contain a banned word on purpose because they render only
 * behind an Advanced disclosure, an admin-only view, or a tool name a person
 * must recognise. Each entry names the file, the exact literal, and why.
 */
export const COPY_ALLOWLIST: ReadonlyArray<{ file: string; literal: string; reason: string }> = [];
```

Create `ui/src/__tests__/person-facing-copy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { COPY_ALLOWLIST } from "./person-facing-copy.allowlist";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const uiSrc = path.resolve(__dirname, "..");

/** Default-view sources. A target is a file, a directory, or a file plus one function to scan. */
export const SCAN_TARGETS: ReadonlyArray<{ path: string; fn?: string }> = [
  { path: "staples" },
  { path: "components/Sidebar.tsx" },
  { path: "pages/Auth.tsx" },
  { path: "pages/legal" },
  { path: "pages/AgentDetail.tsx", fn: "AgentOverview" },
  { path: "pages/AgentDetail.tsx", fn: "LatestRunCard" },
  { path: "components/AgentActionButtons.tsx" },
  { path: "components/primary-agent/PrimaryAgentPresentation.tsx" },
  { path: "pages/CompanySettings.tsx" },
];

const BANNED = /\b(adapters?|harness(?:es)?|runtimes?|sessions?|heartbeats?|mcp|api|json|provider traces?|lifecycles?)\b/i;

function listFiles(target: string): string[] {
  const full = path.join(uiSrc, target);
  const fs = require("node:fs") as typeof import("node:fs");
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return listFiles(child);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path.join(uiSrc, child)] : [];
  });
}

/** Readable text nodes: string literals, template parts and JSX text with a space in them. */
function readableStrings(sourceFile: import("typescript").SourceFile, within?: import("typescript").Node): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const visit = (node: import("typescript").Node) => {
    const parent = node.parent;
    const skip = parent && (
      ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
      || (ts.isPropertyAssignment(parent) && parent.name === node)
      || (ts.isJsxAttribute(parent) && /^(className|data-testid|href|to|src|key|id|name|type|value|variant|size)$/.test(parent.name.getText()))
      || (ts.isCallExpression(parent) && /^(cn|clsx|queryKey|vi\.mock)$/.test(parent.expression.getText()))
    );
    if (!skip && (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node))) {
      const text = node.text.trim();
      if (text.includes(" ")) out.push({ text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(within ?? sourceFile);
  return out;
}

function functionNode(sourceFile: import("typescript").SourceFile, name: string): import("typescript").Node {
  let found: import("typescript").Node | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

describe("person-facing copy in default views", () => {
  it("uses no developer vocabulary", () => {
    const offenders: string[] = [];
    for (const target of SCAN_TARGETS) {
      for (const file of listFiles(target.path)) {
        const source = readFileSync(file, "utf8");
        const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const relative = path.relative(uiSrc, file);
        for (const entry of readableStrings(sourceFile, target.fn ? functionNode(sourceFile, target.fn) : undefined)) {
          const match = entry.text.match(BANNED);
          if (!match) continue;
          if (COPY_ALLOWLIST.some((allowed) => allowed.file === relative && allowed.literal === entry.text)) continue;
          offenders.push(`${relative}:${entry.line}  "${entry.text}"  (${match[0]})`);
        }
      }
    }
    expect(offenders, `Rewrite in plain words, or allowlist with a reason if it only renders behind Advanced:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the allowlist pointing at real strings", () => {
    for (const allowed of COPY_ALLOWLIST) {
      expect(readFileSync(path.join(uiSrc, allowed.file), "utf8")).toContain(allowed.literal);
    }
  });
});
```

If `AgentDetail.tsx` defines `LatestRunCard` as a `const` arrow function instead of a `function` declaration, extend `functionNode` to also match `VariableStatement` declarations with that name. Run `pnpm exec vitest run ui/src/__tests__/person-facing-copy.test.ts` — FAIL with a list of offenders. Save that list to the task report; the steps below cover the known ones. Every other offender is rewritten in plain words or allowlisted with a reason (only when it renders behind Advanced or an admin-only view).

- [ ] **Step 3: Agent action buttons**

In `ui/src/components/AgentActionButtons.tsx`:
- Lines 386-395 badge: text `Detailed logging on`, title `Extra detail is kept for the next runs for up to 24 hours.`
- Delete the provider-trace `Button` block (lines 416-429, the `{canRunWithProviderTrace && (...)}` branch).
- In the overflow `PopoverContent` (line 465) change `w-44` to `w-56` and add, after the `Duplicate Agent` button, guarded by `canRunWithProviderTrace`:

```tsx
          {canRunWithProviderTrace ? (
            <button
              type="button"
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 disabled:opacity-50"
              disabled={assignAndRunDisabled}
              onClick={() => {
                setMoreOpen(false);
                if (navigateToRunOnInvoke && !confirmNavigationStart(agentActionStartedDirtyRef)) return;
                providerTraceAction.mutate();
              }}
              title="Keeps a detailed log of this run for 24 hours"
            >
              <Bug className="h-3 w-3" />
              Run with detailed log
            </button>
          ) : null}
```

- Rename `Duplicate Agent` → `Duplicate agent`, `Copy Agent ID` → `Copy agent ID`, `Reset Sessions` → `Reset conversations`; error toasts `Failed to reset session` → `Couldn't reset the conversation`, `Failed to start traced run` → `Couldn't start the run`; aria-label line 127 → `Clear the problem and let the agent work again`. Any remaining banned word in this file (tooltips, titles) is rewritten the same way.
- Update `AgentActionButtons.test.tsx` and `ui/src/pages/Agents.test.tsx` where they look for `Run with provider trace`: open the `…` popover (`button[aria-label^="Open actions for"]`) and find `Run with detailed log`.

- [ ] **Step 4: Primary agent, template chip, initials**

`PrimaryAgentPresentation.tsx`: `My primary agent` → `My main agent` (lines 34, 38); `Retry loading primary agent` → `Retry loading main agent`; line 59 `Set as my primary` → `Make this my main agent`, `Loading primary…` → `Loading main agent…`, `Setting primary…` → `Setting main agent…`; dialog lines 80-90 `Change your primary agent?` → `Change your main agent?` and the confirm button `Make this my main agent`. Update the component's test file for the new strings.

`AgentTemplateChip.tsx` lines 22-25:

```tsx
      title={record.version ? `Template version ${record.version}` : undefined}
    >
      Ready-made: {name}
    </span>
```

(remove the `v{version}` text; keep `data-testid`). Update the doc comment on line 6 and the chip's test if one asserts the old text (`grep -rn "From template" ui/src`).

`ui/src/components/Identity.tsx:16-20` — single-word names show one letter:

```ts
export function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] ?? "").slice(0, 1).toUpperCase();
}
```

`SidebarAccountMenu.tsx:156` fallback `"Board"` → `"You"`; line 158 `"Local workspace board"` → `"This computer"`. Fix any test asserting `BO` or `Board` for the account button (`grep -rn '"BO"' ui/src --include='*.test.tsx'`).

- [ ] **Step 5: Agent overview**

In `ui/src/pages/AgentDetail.tsx`:
- `sourceLabels` (lines 242-247): `timer` → `Scheduled`, `assignment` → `Assigned`, `on_demand` → `You asked`, `automation` → `Automatic`; where it is read with `?? run.invocationSource` fall back to `"Run"` instead of the raw value.
- Lines 1687-1690: `{isLive ? "Working now" : "Latest work"}` and delete the `· {run.id.slice(0, 8)}` span.
- Line 1713: `{task.identifier ?? task.title}`; line 1715: delete the run-hash span.
- Line 1781: `?? "Default"`. Line 1818: `<span className="max-w-64 truncate text-sm">{configuredModel === "Default" ? "Default" : formatModelName(configuredModel)}</span>` with `import { formatModelName } from "@/lib/model-utils";`.
- Line 1805: `Board` → `You`.
- Line 1830: `Not described yet.`
- Skills section (1836-1850): wrap in `{showSkills ? (...) : null}`. Add `showSkills: boolean` to `AgentOverview`'s props (line 1752). At the `AgentOverview` call site (around 1431) pass `showSkills={skillsSurfaceVisible}` where, near the other hooks at the top of the `AgentDetail` component (around line 940-980):

```tsx
  const surfaces = useSurfaces();
  const skillsSurfaceVisible = !surfaces.ready
    || surfaces.states.find((state) => state.surface.id === "nav.skills")?.visible !== false;
```

with `import { useSurfaces } from "@/staples/surfaces/useSurfaces";`. In `ui/src/pages/AgentOverview.test.tsx` pass `showSkills` explicitly (true in the existing cases) and add one case asserting the Skills heading is absent when `showSkills={false}`.
- Lines 1908-1919: heading `History`; labels map `{ activity: "Activity", runs: "Work history", costs: "Costs", budgets: "Limits" }` instead of `capitalize` + raw key.
- Any other string the guard flags inside `AgentOverview`/`LatestRunCard` (e.g. `Runs on` is fine; `Setup` is fine).

- [ ] **Step 6: Staples assistant setup strings**

Only what the guard flags under `ui/src/staples/**`. Expected: `setup-reasons.ts` and `AssistantSetupCard.tsx` lines containing `API key` → `Anthropic key` (e.g. `Needs an Anthropic key`, `Add an Anthropic key to use Claude (hosted).`, `That Anthropic key was rejected.`, `...with your Anthropic key.`), and `CLI engine`/`default engine` sentences → `...needs Node X or newer here. Pick another option to continue.` Update the matching tests (`grep -rn "API key" ui/src/staples --include='*.test.*'`).

- [ ] **Step 7: Run guard, token gates, related tests, commit**

`pnpm exec vitest run ui/src/__tests__/person-facing-copy.test.ts` — PASS with an allowlist that is empty or carries only Advanced/admin strings with reasons. Then run the touched test files (`AgentActionButtons.test.tsx`, `Agents.test.tsx`, `AgentOverview.test.tsx`, `Identity` tests, `SidebarAccountMenu.test.tsx`, the primary-agent and template-chip tests, the staples assistant tests) and `pnpm check:token-gates`. Commit:

```bash
git add ui/src/__tests__ ui/src/lib/model-utils.ts ui/src/lib/model-utils.test.ts ui/src/components ui/src/pages ui/src/staples
git commit -m "feat(copy): banned-terms guard for default views; plain agent page, main agent, detailed-log action"
```

---

### Task 5: Jargon in the task thread and composer

**Files:**
- Modify: `ui/src/__tests__/person-facing-copy.test.ts` (`SCAN_TARGETS`)
- Modify: `ui/src/components/task-chat/TaskChatComposer.tsx:310-318, 687, 983, 1375, 1379-1400`; `ui/src/components/MarkdownEditor.tsx:1521-1528`
- Modify: `ui/src/components/TaskChatThread.tsx:1688-1724, 1788-1795, 2474, 2496, 2527-2528`; `ui/src/components/task-chat/TaskChatProtocolCard.tsx:629, 743`; `ui/src/components/task-chat/RunnerGoalWidget.tsx:118, 203, 283`; `ui/src/components/task-chat/TaskChatQueuedMessages.tsx:370`; `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx:41-65, 203, 215, 223, 248-255`
- Tests: the matching `*.test.tsx` files for each component

**Interfaces:**
- Consumes: `formatModelName`, `roleLabels` (exported from `ui/src/components/agent-config-primitives.tsx:71`), `REQUIRED_TOOLS_UNAVAILABLE_MESSAGE` handling from the quick-wins pass (unchanged).

- [ ] **Step 1: Extend the guard**

Append to `SCAN_TARGETS`:

```ts
  { path: "components/task-chat/TaskChatComposer.tsx" },
  { path: "components/task-chat/ComposerRunSettingsPicker.tsx" },
  { path: "components/task-chat/TaskChatProtocolCard.tsx" },
  { path: "components/task-chat/RunnerGoalWidget.tsx" },
  { path: "components/task-chat/TaskChatQueuedMessages.tsx" },
  { path: "components/TaskChatThread.tsx" },
```

Run the guard — FAIL with the new offenders; record the list in the task report.

- [ ] **Step 2: Composer and editor**

`TaskChatComposer.tsx` `modePlaceholder` (lines 310-318):

```ts
  switch (mode) {
    case "planning":
      return `Plan with ${agentName} — nothing changes yet…`;
    case "ask":
      return `Ask ${agentName} a question — it won't change anything…`;
    default:
      return `Message ${agentName}…`;
  }
```

Line 687 → `Availability is checked when the agent starts.`; line 983 → `Pick an agent before setting a goal.`; line 1375 → `Send /new to start a fresh conversation.`; lines 1391-1392 slash action `New conversation` / `Start fresh here, keeping the history above.`; pass `ariaLabel={`Message ${assigneeName}`}` (use the name variable the file already holds for the pending assignee; if none is in scope use `"Message"`) to `<MarkdownEditor>` at line 1379.

`MarkdownEditor.tsx:1523`: `key === "contentArea.editableMarkdown" ? (ariaLabel ?? placeholder ?? "Message") : ...` so no caller ever leaks "editable markdown".

- [ ] **Step 3: Thread failure lines and protocol cards**

`TaskChatThread.tsx`: lines 1688-1724 and 1788-1795 — remove every `(${code})` from the person-facing sentence; move the code into a `title` attribute on the enclosing element (`title={code}`) so support can still read it. Replace: `Model unavailable` block → `That model isn't available. Pick another or use the default.`; provider usage limit → `The AI service's usage limit was reached. Try again later.`; `Provider output exceeded the safe limit.` → `The answer was too long to receive.`; `The runner timed out …` / `The runner stopped …` → `The agent stopped unexpectedly. Try again.`; legacy `The run failed (${code}). …` → `The run failed. Try again.` Lines 2474, 2496 → `This request can't be answered here.`; 2527-2528 titles → `Permission needed` / `Input needed`.

`TaskChatProtocolCard.tsx:629` → `Details weren't saved for this older request.`; `:743` → `That request couldn't be completed.` `RunnerGoalWidget.tsx` → `Agent goal`, `Replace the goal?`, `Edit goal`, `There is no goal to edit yet.` `TaskChatQueuedMessages.tsx:370` → `The queue changed in another tab or window. Review it and try again.`

`ComposerRunSettingsPicker.tsx`: replace `HARNESS_LABELS`/`harnessLabel` with `getAdapterDisplay(agent.adapterType).label` from `@/adapters/adapter-display-registry` (delete the local map); line 248 raw `optionAgent.role` → `roleLabels[optionAgent.role] ?? optionAgent.role`; copy: `Its harness does not expose a model or effort setting.` → `This agent has no model setting.`; `The destination service chooses its model.` stays; the per-task sentence → `${PRODUCT_NAME} has no per-task model setting for it.` is already rebranded, rewrite to `There is no per-task model setting for it.`; model fallback at 129/203/223 → `formatModelName(model)`.

- [ ] **Step 4: Tests, guard, commit**

Update the tests that assert old strings (`grep -rln "describe what you want done\|editable markdown\|New session\|Runtime permission\|provider rejected" ui/src --include='*.test.tsx'`). Run those files, then the guard — PASS; `pnpm check:token-gates`. Commit:

```bash
git add ui/src/__tests__ ui/src/components
git commit -m "feat(copy): plain task-thread and composer wording; guard covers the thread"
```

---

### Task 6: Connectors server fixes (local status 401, pending requests endpoint)

**Files:**
- Modify: `server/src/routes/public-mcp.ts:255`; test `server/src/__tests__/public-mcp.test.ts` (model on the `limits assistant setup metadata to signed-in humans` test at ~line 451)
- Modify: `server/src/routes/connection-intents.ts` (inside `connectionIntentBoardRoutes`, after `addressedIntent`); `server/src/services/connection-intents.ts` (add `listPendingForCompany`); test `server/src/__tests__/connection-intents-service.test.ts`
- Modify: `packages/shared/src/types/issue.ts` (after `ConnectionIntentInteraction`, ~line 1772): add `PendingConnectionRequest`; export via the barrel if `issue.ts` types are re-exported with `export *` (check `packages/shared/src/index.ts`), else add it to the explicit export list
- Modify: `ui/src/api/connection-intents.ts` (add `listPending`)

**Interfaces:**
- Produces: `GET /api/companies/:companyId/connection-requests/pending` → `{ requests: PendingConnectionRequest[] }`; `connectionIntentsApi.listPending(companyId): Promise<{ requests: PendingConnectionRequest[] }>`; `GET /api/mcp/connections` returns `[]` for the `local_implicit` board actor.

```ts
export interface PendingConnectionRequest {
  interactionId: string;
  issueId: string;
  issueIdentifier: string | null;
  serviceSlug: string;
  serviceName: string;
  requestingAgentId: string;
  requestingAgentName: string;
  createdAt: string;
}
```

- [ ] **Step 1: Local board gets an empty connection list (test first)**

In `server/src/__tests__/public-mcp.test.ts`, inside the `limits assistant setup metadata to signed-in humans` test (or a sibling it), add an expectation that with `actor = { type: "board", source: "local_implicit", userId: "board" }` the request `GET /api/mcp/connections` returns status 200 and body `[]`, while `GET /api/mcp/setup` with the same actor still returns 401. Run `pnpm exec vitest run server/src/__tests__/public-mcp.test.ts -t "signed-in humans"` — FAIL (401).

In `server/src/routes/public-mcp.ts` replace line 255 with:

```ts
  // A local trusted board has no sign-in and therefore no assistant grants:
  // report "none" instead of an error so the Connectors page stays calm.
  router.get("/mcp/connections", (req, res, next) => {
    if (req.actor.type === "board" && req.actor.source === "local_implicit") { res.json([]); return; }
    next();
  }, realUser, async (req, res) => res.json(await oauth.listConnections(req.actor.userId!)));
```

Run the test — PASS.

- [ ] **Step 2: Pending requests service method (test first)**

In `server/src/__tests__/connection-intents-service.test.ts` add a test that creates a connection intent through the existing helpers in that file (look for how it inserts a `connection_intent` interaction today), then asserts `await connectionIntentService(db).listPendingForCompany(companyId)` returns one row with `serviceSlug`, `serviceName`, `requestingAgentName`, `issueId` from the fixture and that a second intent with status `"resolved"` is not returned. Run — FAIL (method missing).

In `server/src/services/connection-intents.ts` add to the service object:

```ts
    /** Open connection requests across a company's visible tasks, newest first. */
    async listPendingForCompany(companyId: string): Promise<PendingConnectionRequest[]> {
      const rows = await db
        .select({
          interactionId: issueThreadInteractions.id,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          payload: issueThreadInteractions.payload,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.kind, "connection_intent"),
          eq(issueThreadInteractions.status, "pending"),
          visibleIssueCondition(),
        ))
        .orderBy(desc(issueThreadInteractions.createdAt));
      return rows.map((row) => {
        const payload = row.payload as ConnectionIntentPayload;
        return {
          interactionId: row.interactionId,
          issueId: row.issueId,
          issueIdentifier: row.issueIdentifier ?? null,
          serviceSlug: payload.upstreamService?.slug ?? payload.serviceSlug,
          serviceName: payload.upstreamService?.name ?? payload.serviceName,
          requestingAgentId: payload.requestingAgentId,
          requestingAgentName: payload.requestingAgentName,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        };
      });
    },
```

Import `visibleIssueCondition` from where `server/src/services/company-signals.ts` imports it, `issues`/`issueThreadInteractions` from `@paperclipai/db`, and `and`/`eq`/`desc` from `drizzle-orm`. Run — PASS.

- [ ] **Step 3: Route**

In `connectionIntentBoardRoutes` add before the `setup-options` route:

```ts
  router.get("/companies/:companyId/connection-requests/pending", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ requests: await service.listPendingForCompany(companyId) });
  });
```

Add a route test beside the existing board-route tests for connection intents (search `connection-intents` in `server/src/__tests__/*routes*.test.ts`; if none exists, cover the route in `connection-intents-service.test.ts` with a supertest `express()` app mounting `connectionIntentBoardRoutes(db, heartbeat)` and a `local_implicit` actor, asserting 200 and the `requests` array). Run — PASS.

- [ ] **Step 4: Shared type and UI client**

Add `PendingConnectionRequest` to `packages/shared/src/types/issue.ts` (above) and to the barrel. In `ui/src/api/connection-intents.ts`:

```ts
  listPending: (companyId: string) =>
    api.get<{ requests: PendingConnectionRequest[] }>(`/companies/${companyId}/connection-requests/pending`),
```

`pnpm --filter @paperclipai/shared typecheck && pnpm --filter @paperclipai/server typecheck` (background). Commit:

```bash
git add server/src/routes/public-mcp.ts server/src/routes/connection-intents.ts server/src/services/connection-intents.ts server/src/__tests__ packages/shared/src/types/issue.ts packages/shared/src/index.ts ui/src/api/connection-intents.ts
git commit -m "feat(connectors): empty assistant-connection list for local boards; pending connection requests endpoint"
```

---

### Task 7: Connectors page sections

**Files:**
- Create: `ui/src/pages/apps/connector-sections.ts`, `ui/src/pages/apps/connector-sections.test.ts`
- Create: `ui/src/pages/apps/NeededByTeam.tsx`
- Modify: `ui/src/pages/apps/app-definition-display.ts:19-21` (+ test `app-definition-display.test.ts`, create if absent)
- Modify: `ui/src/pages/apps/Browse.tsx:785-811` (partition), `:855-860` (card visibility), `:886-898` (header), `:941-968` (list), `:973-980` (pagination); `ui/src/pages/apps/Browse.test.tsx:235-250` (`renderBrowse`), `:411` (chips test), new tests
- Modify: `packages/shared/src/app-definitions/*.json` `featured` flags; `packages/shared/src/app-definitions.ts:52-73` (`APP_STORE_HIDDEN_SLUGS`)
- Modify: `ui/src/lib/queryKeys.ts` (add `connectionRequests`)

**Interfaces:**
- Consumes: `ConnectorRowModel`, `isInstalled(row)`, `ConnectorCard`, `CatalogSourceFilters`, `AssistantConnectionCard`, `CustomConnectorCard` (all in `Browse.tsx`); `agentsApi.list(companyId)` (already queried as `chatAgentsQuery`, make it always enabled); `connectionIntentsApi.listPending`; `agentTemplateRecord` from `@/staples/autopilot/templateRecord` (extend `requiredApps` items with `why: string | null; optional: boolean`).
- Produces: `classifyRow(row): "advanced" | "popular" | "regular"`, `POPULAR_CATEGORY_LABELS`, `teamNeeds({ agents, rows, requests })`.

- [ ] **Step 1: Description rewrite (test first)**

`ui/src/pages/apps/app-definition-display.test.ts` (create if absent, Vitest node env):

```ts
import { describe, expect, it } from "vitest";
import { appDefinitionDescription } from "./app-definition-display";

describe("appDefinitionDescription", () => {
  it("turns the provider-hosted boilerplate into a plain sentence", () => {
    expect(appDefinitionDescription({ description: "Connect Stripe's provider-hosted MCP server." } as never)).toBe("Let agents use Stripe.");
    expect(appDefinitionDescription({ description: "Connect Hugging Face’s provider-hosted MCP server." } as never)).toBe("Let agents use Hugging Face.");
  });
  it("leaves other descriptions alone", () => {
    expect(appDefinitionDescription({ description: "Send email through Resend." } as never)).toBe("Send email through Resend.");
  });
});
```

Implementation (`app-definition-display.ts:19-21`):

```ts
const PROVIDER_HOSTED = /^Connect (.+?)['’]s provider-hosted MCP server\.$/;

export function appDefinitionDescription(entry: AppGalleryDisplayEntry | null | undefined): string {
  const raw = entry?.description ?? entry?.tagline ?? "";
  const boilerplate = raw.match(PROVIDER_HOSTED);
  return boilerplate ? `Let agents use ${boilerplate[1]}.` : raw;
}
```

- [ ] **Step 2: Curate `featured` and unhide the apps templates need**

Set `"featured": true` in exactly these definition files under `packages/shared/src/app-definitions/`: gmail, google-calendar, slack, notion, stripe, shopify, github, resend, beehiiv, klaviyo, agentmail, linear, vercel, netlify, webflow, google-drive, google-docs, google-sheets. Set `"featured": false` in: arcade, composio, executor, zapier, jira, posthog, github-code-review-bot, google-slides. Remove `"beehiiv"`, `"klaviyo"` and `"xero"` from `APP_STORE_HIDDEN_SLUGS` (the Newsletter and Bookkeeper templates require them; keeping them hidden makes "Needed by your team" unable to show them). If `scripts/ingest-app-definitions.mjs` must be rerun to refresh `app-definitions.generated.ts`, run it; otherwise the JSON edits are enough. Add to the existing app-definitions test (search `featured` in `packages/shared/src/**/*.test.ts`; if none, create `packages/shared/src/app-definitions.featured.test.ts`) an assertion that the featured set equals the 18 slugs above and that no aggregator is featured.

- [ ] **Step 3: Section classifier (test first)**

`ui/src/pages/apps/connector-sections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyRow, teamNeeds, type SectionRow } from "./connector-sections";

const row = (slug: string, extra: Partial<SectionRow> = {}): SectionRow => ({
  key: `gallery:${slug}`, slug, name: slug, entry: null, aggregatorApp: undefined, connections: [], chatEndpoints: [], upstreamApps: undefined, ...extra,
});

describe("classifyRow", () => {
  it("sends model providers, raw connectors and aggregators to Advanced", () => {
    expect(classifyRow(row("anthropic", { entry: { tags: ["model-provider"], categories: ["ai"] } as never }))).toBe("advanced");
    expect(classifyRow(row("api-key-generic"))).toBe("advanced");
    expect(classifyRow(row("composio", { aggregatorApp: { slug: "composio" } as never }))).toBe("advanced");
    expect(classifyRow(row("linkedin", { aggregatorApp: { slug: "linkedin", routes: [] } as never }))).toBe("advanced");
  });
  it("marks featured entries popular and everything else regular", () => {
    expect(classifyRow(row("gmail", { entry: { featured: true, categories: ["communication"] } as never }))).toBe("popular");
    expect(classifyRow(row("todoist", { entry: { featured: false } as never }))).toBe("regular");
    expect(classifyRow(row("legacy", { entry: null }))).toBe("regular");
  });
});

describe("teamNeeds", () => {
  const agents = [
    { id: "a1", name: "Newsletter editor", status: "active", metadata: { staplesTemplate: { ref: "staples/newsletter", requiredApps: [{ capability: "newsletter", anyOf: ["beehiiv", "resend"], why: "Holds your subscriber list and sends each issue." }] } } },
    { id: "a2", name: "Retired", status: "terminated", metadata: { staplesTemplate: { ref: "staples/coding-agent", requiredApps: [{ capability: "code", anyOf: ["github"], why: "x" }] } } },
  ];
  it("lists unmet required apps with the agent and reason", () => {
    const rows = [row("beehiiv"), row("resend"), row("github")];
    const needs = teamNeeds({ agents: agents as never, rows, requests: [] });
    expect(needs).toEqual([{ kind: "template", row: rows[0], agentName: "Newsletter editor", why: "Holds your subscriber list and sends each issue.", alternatives: [rows[1]] }]);
  });
  it("drops needs that an installed alternative satisfies", () => {
    const rows = [row("beehiiv"), row("resend", { connections: [{ id: "c1", status: "active" } as never] })];
    expect(teamNeeds({ agents: agents as never, rows, requests: [] })).toEqual([]);
  });
  it("adds open requests, deduplicated by service", () => {
    const rows = [row("stripe")];
    const requests = [{ interactionId: "i1", issueId: "t1", issueIdentifier: "LAN-4", serviceSlug: "stripe", serviceName: "Stripe", requestingAgentId: "a9", requestingAgentName: "Bookkeeper", createdAt: "2026-10-14T00:00:00Z" }];
    const needs = teamNeeds({ agents: [], rows, requests });
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: "request", row: rows[0], agentName: "Bookkeeper", issueHref: "/issues/LAN-4" });
  });
});
```

`ui/src/pages/apps/connector-sections.ts`:

```ts
import { isAppAggregator } from "@paperclipai/shared/aggregator-apps";
import type { Agent, PendingConnectionRequest } from "@paperclipai/shared";
import { agentTemplateRecord } from "@/staples/autopilot/templateRecord";

/** The slice of a Browse row the sections need. */
export interface SectionRow {
  key: string;
  slug: string;
  name: string;
  entry: { featured?: boolean; categories?: string[]; tags?: string[]; aiConnectionRouter?: unknown } | null;
  aggregatorApp?: unknown;
  connections: Array<{ status?: string }>;
  chatEndpoints: unknown[];
  upstreamApps?: Array<{ accounts: unknown[] }>;
}

const RAW_CONNECTOR_SLUGS = new Set(["api-key-generic", "oauth-generic", "local", "gateway", "chat-completions-api", "messages-api", "responses-api", "bedrock"]);

export const POPULAR_CATEGORY_LABELS: Record<string, string> = {
  communication: "Email and messaging",
  productivity: "Calendar and documents",
  commerce: "Sales and payments",
  content: "Website and content",
  developer: "Developer tools",
  data: "Data",
  analytics: "Analytics",
  ai: "AI",
  other: "Other",
};

export function rowIsInstalled(row: SectionRow): boolean {
  return row.connections.length > 0 || row.chatEndpoints.length > 0 || (row.upstreamApps ?? []).some((app) => app.accounts.length > 0);
}

export function classifyRow(row: SectionRow): "advanced" | "popular" | "regular" {
  if (row.aggregatorApp || isAppAggregator(row.slug) || RAW_CONNECTOR_SLUGS.has(row.slug)) return "advanced";
  if (row.entry?.tags?.includes("model-provider") || row.entry?.aiConnectionRouter) return "advanced";
  return row.entry?.featured === true ? "popular" : "regular";
}

/** Popular rows grouped by their first category, in the label map's order. */
export function groupPopular<T extends SectionRow>(rows: T[]): Array<{ label: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const category = row.entry?.categories?.[0] ?? "other";
    groups.set(category, [...(groups.get(category) ?? []), row]);
  }
  return Object.keys(POPULAR_CATEGORY_LABELS)
    .filter((category) => groups.has(category))
    .map((category) => ({ label: POPULAR_CATEGORY_LABELS[category], rows: groups.get(category)! }));
}

export type TeamNeed<T extends SectionRow = SectionRow> =
  | { kind: "template"; row: T; agentName: string; why: string | null; alternatives: T[] }
  | { kind: "request"; row: T | null; serviceName: string; agentName: string; issueHref: string };

/** Apps hired agents need but nobody connected, then open connection requests. */
export function teamNeeds<T extends SectionRow>(input: {
  agents: Array<Pick<Agent, "id" | "name" | "status" | "metadata">>;
  rows: T[];
  requests: PendingConnectionRequest[];
}): TeamNeed<T>[] {
  const bySlug = new Map(input.rows.map((row) => [row.slug, row] as const));
  const needs: TeamNeed<T>[] = [];
  const seen = new Set<string>();
  for (const agent of input.agents) {
    if (agent.status === "terminated") continue;
    const record = agentTemplateRecord(agent.metadata);
    if (!record) continue;
    for (const app of record.requiredApps) {
      if (app.optional) continue;
      const candidates = app.anyOf.map((slug) => bySlug.get(slug)).filter((row): row is T => Boolean(row));
      if (candidates.length === 0 || candidates.some(rowIsInstalled)) continue;
      const [row, ...alternatives] = candidates;
      if (seen.has(row.slug)) continue;
      seen.add(row.slug);
      needs.push({ kind: "template", row, agentName: agent.name, why: app.why, alternatives });
    }
  }
  for (const request of input.requests) {
    if (seen.has(request.serviceSlug)) continue;
    seen.add(request.serviceSlug);
    const row = bySlug.get(request.serviceSlug) ?? null;
    if (row && rowIsInstalled(row)) continue;
    needs.push({ kind: "request", row, serviceName: request.serviceName, agentName: request.requestingAgentName, issueHref: `/issues/${request.issueIdentifier ?? request.issueId}` });
  }
  return needs;
}
```

Extend `ui/src/staples/autopilot/templateRecord.ts` so `requiredApps` items carry `why: string | null` and `optional: boolean` (`why: typeof app.why === "string" ? app.why : null, optional: app.optional === true`), update its interface and its test. Run the section test — PASS.

- [ ] **Step 4: Needed-by-team component**

`ui/src/pages/apps/NeededByTeam.tsx`:

```tsx
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import type { SectionRow, TeamNeed } from "./connector-sections";

export function NeededByTeam<T extends SectionRow>({ needs, renderCard }: { needs: TeamNeed<T>[]; renderCard: (row: T) => ReactNode }) {
  if (needs.length === 0) return null;
  return (
    <section aria-labelledby="connectors-needed-heading" className="space-y-3">
      <h2 id="connectors-needed-heading" className="text-base font-semibold">Needed by your team</h2>
      <div className="space-y-3" role="list" aria-label="Needed connectors">
        {needs.map((need) => (
          <div key={need.kind === "template" ? need.row.key : need.issueHref} className="space-y-1">
            {need.row ? renderCard(need.row) : null}
            <p className="px-1 text-sm text-muted-foreground">
              {need.kind === "template"
                ? <>{need.agentName} needs it.{need.why ? ` ${need.why}` : ""}
                    {need.alternatives.length > 0 ? ` Or connect ${need.alternatives.map((row) => row.name).join(" or ")} instead.` : ""}</>
                : <>{need.agentName} asked to connect {need.serviceName}. <Link to={need.issueHref} className="underline underline-offset-2">Open the task</Link></>}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Browse integration**

In `Browse.tsx`:
1. State: `const [advanced, setAdvanced] = useState(() => { try { return localStorage.getItem("staples.connectors.advanced") === "1"; } catch { return false; } });` and persist on toggle. `source` stays, but in simple mode treat it as `"paperclip"`.
2. Queries: make `chatAgentsQuery` always enabled (it already calls `agentsApi.list`); add `const requestsQuery = useQuery({ queryKey: queryKeys.connectionRequests.pending(selectedCompanyId ?? ""), queryFn: () => connectionIntentsApi.listPending(selectedCompanyId!), enabled: Boolean(selectedCompanyId), retry: false });` with `connectionRequests: { pending: (companyId: string) => ["connection-requests", companyId, "pending"] as const }` added to `queryKeys`.
3. After `visibleRows` (line 805): 
```ts
  const effectiveSource: CatalogSource = advanced ? source : "paperclip";
```
(use `effectiveSource` instead of `source` inside the `visibleRows` filter and in `showAssistantConnection`/`showCustomConnector`), then:
```ts
  const simpleRows = advanced ? visibleRows : visibleRows.filter((row) => classifyRow(row) !== "advanced");
  const needs = useMemo(() => (advanced || trimmed) ? [] : teamNeeds({ agents: chatAgentsQuery.data ?? [], rows: simpleRows, requests: requestsQuery.data?.requests ?? [] }), [advanced, trimmed, chatAgentsQuery.data, simpleRows, requestsQuery.data]);
  const popularGroups = (advanced || trimmed) ? [] : groupPopular(simpleRows.filter((row) => classifyRow(row) === "popular" && !isInstalled(row)));
  const featuredKeys = new Set([...needs.flatMap((need) => need.row ? [need.row.key] : []), ...popularGroups.flatMap((group) => group.rows.map((row) => row.key))]);
  const listRows = simpleRows.filter((row) => !featuredKeys.has(row.key));
```
and compute `installedRows`/`catalogRows`/pagination from `listRows` instead of `visibleRows`.
4. Header: keep the search input; add on the right `<Button type="button" variant="ghost" size="sm" aria-pressed={advanced} onClick={() => { const next = !advanced; setAdvanced(next); try { localStorage.setItem("staples.connectors.advanced", next ? "1" : "0"); } catch {} if (!next) { setSource("paperclip"); } setPage(1); }}>Advanced</Button>`; render `<CatalogSourceFilters …/>` only when `advanced`.
5. `showAssistantConnection` and `showCustomConnector`: add `advanced &&` in front (both are Advanced-only).
6. List: before the existing `role="list"` block render `<NeededByTeam needs={needs} renderCard={(row) => <ConnectorCard … row={row} />} />` and, for each popular group, `<section aria-labelledby={id}><h2 …>{group.label}</h2><div role="list" aria-label={`${group.label} connectors`}>{group.rows.map(card)}</div></section>`; give the existing list an `<h2>` of `All connectors` when `!advanced && !trimmed`. Factor the `ConnectorCard` props into a local `renderCard(row)` function so all three places pass the same props.
7. `nothingMatches` becomes `listRows.length === 0 && needs.length === 0 && popularGroups.length === 0 && !showCustomConnector && !showAssistantConnection`.

- [ ] **Step 6: Tests**

`Browse.test.tsx`:
- `renderBrowse(allCatalog = true)`: after the first `flushReact()`, `await clickButton("Advanced", container);` then `clickButton("All")` when `allCatalog`. Add `localStorage.clear()` to `beforeEach`.
- Add `vi.mock("@/api/connection-intents", () => ({ connectionIntentsApi: { listPending: connectionRequestsMock } }))` with `connectionRequestsMock` resolving `{ requests: [] }` by default (hoisted like the others).
- Keep the five-chip test as is (it now runs after the Advanced click).
- New tests, rendering with `renderBrowse(false)` and no Advanced click (add a `renderSimple()` helper that renders without clicking):
  1. "simple mode hides model providers, aggregators and the assistant card": gallery includes `{ slug: "anthropic", tags: ["model-provider"], categories: ["ai"] }` and the aggregator catalog has an entry; expect no `[data-app-slug="anthropic"]`, no `[aria-label$="Assistant Connection (MCP)"]`, no `[aria-label="App filters"]`; click `Advanced` → all three appear.
  2. "popular section groups featured apps by category": gallery `gmail` (`featured: true, categories: ["communication"]`) and `notion` (`featured: true, categories: ["content"]`); expect headings `Email and messaging` and `Website and content` and that `[aria-label="Connector list"]` does not also contain gmail.
  3. "needed by your team lists unmet template apps": `agentsApi.list` resolves an agent with `metadata.staplesTemplate.requiredApps [{ capability: "newsletter", anyOf: ["resend"], why: "Holds your subscriber list and sends each issue." }]`; expect heading `Needed by your team`, text `Newsletter editor needs it. Holds your subscriber list and sends each issue.`, and the resend card inside `[aria-label="Needed connectors"]`.
  4. "open requests appear with a task link": `connectionRequestsMock` resolves one request for `stripe`; expect `a[href="/issues/LAN-4"]`.
  5. "provider-hosted descriptions read plainly": gallery entry with the boilerplate description; expect `Let agents use Stripe.`
- Existing `Couldn’t load your connection status` assertions still hold inside Advanced mode (the card only renders there now); adjust the test to click Advanced first.

Run `pnpm exec vitest run ui/src/pages/apps/Browse.test.tsx ui/src/pages/apps/AssistantConnection.test.tsx ui/src/pages/apps/connector-sections.test.ts ui/src/pages/apps/app-definition-display.test.ts ui/src/staples/autopilot` — PASS. `pnpm check:token-gates`. Commit:

```bash
git add ui/src/pages/apps ui/src/staples/autopilot ui/src/lib/queryKeys.ts packages/shared/src/app-definitions packages/shared/src/app-definitions.ts packages/shared/src/app-definitions.generated.ts packages/shared/src/*.test.ts
git commit -m "feat(connectors): needed-by-team, popular and all sections; advanced toggle; plain descriptions"
```

---

### Task 8: Settings split

**Files:**
- Create: `ui/src/hooks/useIsInstanceAdmin.ts`, `ui/src/hooks/useIsInstanceAdmin.test.ts`
- Create: `ui/src/components/InstanceAdminGate.tsx`
- Modify: `ui/src/App.tsx:210` (route), `ui/src/pages/InstanceGeneralSettings.tsx:30-36, 102-114` (+ `InstanceGeneralSettings.test.tsx`)
- Modify: `ui/src/pages/CompanySettings.tsx:217-222, 342-357, 358-374, 376-418` (+ `CompanySettingsArchive.test.tsx`, `CompanySettingsRenameHint.test.tsx` mocks)
- Modify: `ui/src/components/CompanySettingsSidebar.tsx:105-199` (+ `CompanySettingsSidebar.test.tsx`)

**Interfaces:**
- Produces: `resolveIsInstanceAdmin(health, boardAccess): boolean | null`, `useIsInstanceAdmin(): { isAdmin: boolean; loaded: boolean }`; route `/company/settings/instance/general` renders the Admin page.

- [ ] **Step 1: Admin hook (test first)**

`ui/src/hooks/useIsInstanceAdmin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveIsInstanceAdmin } from "./useIsInstanceAdmin";

describe("resolveIsInstanceAdmin", () => {
  it("is unknown until health loads", () => expect(resolveIsInstanceAdmin(undefined, undefined)).toBeNull());
  it("treats a local trusted board as admin", () => expect(resolveIsInstanceAdmin({ deploymentMode: "local_trusted" }, undefined)).toBe(true));
  it("waits for board access in authenticated mode", () => expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, undefined)).toBeNull());
  it("reads the flag in authenticated mode", () => {
    expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, { isInstanceAdmin: true })).toBe(true);
    expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, { isInstanceAdmin: false })).toBe(false);
  });
});
```

`ui/src/hooks/useIsInstanceAdmin.ts` (same shape as `useCanCreateCompany.ts`):

```ts
import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { healthApi, type HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/** Whether this viewer administers the whole deployment. `null` while unknown. */
export function resolveIsInstanceAdmin(
  health: Pick<HealthStatus, "deploymentMode"> | null | undefined,
  boardAccess: Pick<CurrentBoardAccess, "isInstanceAdmin"> | null | undefined,
): boolean | null {
  if (!health) return null;
  if (health.deploymentMode !== "authenticated") return true;
  if (!boardAccess) return null;
  return boardAccess.isInstanceAdmin === true;
}

export function useIsInstanceAdmin(): { isAdmin: boolean; loaded: boolean } {
  const healthQuery = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), enabled: false });
  const needsBoardAccess = healthQuery.data?.deploymentMode === "authenticated";
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: needsBoardAccess,
    retry: false,
  });
  const resolved = resolveIsInstanceAdmin(healthQuery.data, boardAccessQuery.data);
  return { isAdmin: resolved === true, loaded: resolved !== null };
}
```

`ui/src/components/InstanceAdminGate.tsx`:

```tsx
import { Navigate, Outlet } from "@/lib/router";
import { useIsInstanceAdmin } from "@/hooks/useIsInstanceAdmin";

/** Route layout: admin-only pages fall back to company settings for everyone else. */
export function InstanceAdminGate() {
  const { isAdmin, loaded } = useIsInstanceAdmin();
  if (!loaded) return null;
  return isAdmin ? <Outlet /> : <Navigate to="/company/settings" replace />;
}
```

(Check `@/lib/router` exports `Navigate` and `Outlet`; `HiddenSettingsPageGate.tsx` shows the import to copy.)

- [ ] **Step 2: Route and Admin page**

`App.tsx:210` becomes:

```tsx
      <Route element={<InstanceAdminGate />}>
        <Route path="company/settings/instance/general" element={<InstanceGeneralSettings />} />
      </Route>
```

with `import { InstanceAdminGate } from "./components/InstanceAdminGate";` and the `InstanceGeneralSettings` import (it is already imported by `CompanySettings`; add a direct import in `App.tsx`).

`InstanceGeneralSettings.tsx`: breadcrumbs (lines 32-35) → `{ label: "Settings", href: "/company/settings" }, { label: "Admin" }`; header (lines 103-114) → `<h1 className="text-lg font-semibold">Admin</h1>` and the paragraph `Settings for this ${PRODUCT_NAME} deployment. They apply to every company here.` (import `PRODUCT_NAME` from `@/lib/branding`; drop the `topicSummary` sentence and delete `visibleTopics`/`topicSummary` if nothing else uses them). Update `InstanceGeneralSettings.test.tsx` expectations for the heading if any assert `General`.

- [ ] **Step 3: Company settings page**

`CompanySettings.tsx`:
- Line 219 `h1` text `General` → `Company`.
- Line ~350 toggle label `Require board approval for new hires` → `Require approval for new hires`; its description → `New hires wait for your approval before they start.`
- Replace lines 358-374 (decision model, governance panel, embedded instance block) with:

```tsx
      <details className="rounded-lg border border-border p-4" data-testid="company-settings-advanced">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 space-y-8">
          {selectedCompanyId && <DecisionModelSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />}
          <InteractionGovernancePanel
            governance={governance}
            onChange={handleGovernanceChange}
            isPending={governanceMutation.isPending}
            errorMessage={governanceMutation.isError ? (governanceMutation.error instanceof Error ? governanceMutation.error.message : "Couldn't save these settings") : null}
          />
        </div>
      </details>
```

- Remove the `InstanceGeneralSettings` import (line 32). In the Danger Zone copy, replace `This persists in the database.` with nothing (`Archive this company to hide it from the sidebar.`), and `organization` → `company` in this page's copy.
- After the Danger Zone block append a footer:

```tsx
      <footer className="flex flex-wrap gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
        <Link to={TERMS_PATH} className="hover:text-foreground">Terms of service</Link>
        <Link to={PRIVACY_PATH} className="hover:text-foreground">Privacy policy</Link>
      </footer>
```

with `Link` from `@/lib/router` and the paths from `@/lib/branding`.
- In `CompanySettingsArchive.test.tsx` and `CompanySettingsRenameHint.test.tsx` delete the `vi.mock("./InstanceGeneralSettings", …)` blocks (now unused) and add one assertion in the archive test that `[data-testid="company-settings-advanced"] summary` reads `Advanced` and that the governance panel mock renders inside it.

- [ ] **Step 4: Settings sidebar Admin group**

`CompanySettingsSidebar.tsx`: call `const { isAdmin } = useIsInstanceAdmin();`. Keep in the first group: General (`/company/settings`), Profile, Members, plugin slot pages, Secrets, Export, Import. Move Environments, Access, Experimental, Plugins (with its subtree), Adapters into a second group rendered only when `isAdmin`:

```tsx
        {isAdmin ? (
          <div data-slot="contextual-sidebar-group" className={primarySidebarStyles.group} aria-label="Admin">
            <p className="px-3 pb-1 pt-3 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Admin</p>
            <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/general`} label="Deployment" icon={MonitorCog} end />
            {/* existing Environments, Access, Experimental, Plugins, Adapters items, unchanged */}
          </div>
        ) : null}
```

Check how `Sidebar.tsx` labels its own groups (`grep -n "uppercase" ui/src/components/Sidebar.tsx | head -3`) and copy that class string instead of the one above if it differs; the token utilities `text-(length:--text-micro)` and `tracking-(--tracking-label)` exist in `index.css`. `CompanySettingsSidebar.test.tsx`: mock `@/hooks/useIsInstanceAdmin` to `{ isAdmin: true, loaded: true }` by default; existing assertions for Environments/Access/Plugins/Adapters keep passing; add a test with `isAdmin: false` asserting none of those labels nor `Deployment` render, and one with `isAdmin: true` asserting `Deployment` links to `/company/settings/instance/general`.

- [ ] **Step 5: Tests, gates, commit**

Run `pnpm exec vitest run ui/src/hooks/useIsInstanceAdmin.test.ts ui/src/pages/InstanceGeneralSettings.test.tsx ui/src/pages/CompanySettingsArchive.test.tsx ui/src/pages/CompanySettingsRenameHint.test.tsx ui/src/components/CompanySettingsSidebar.test.tsx ui/src/__tests__/person-facing-copy.test.ts` — PASS; `pnpm check:token-gates`. Commit:

```bash
git add ui/src/hooks ui/src/components/InstanceAdminGate.tsx ui/src/components/CompanySettingsSidebar.tsx ui/src/components/CompanySettingsSidebar.test.tsx ui/src/pages/CompanySettings.tsx ui/src/pages/CompanySettingsArchive.test.tsx ui/src/pages/CompanySettingsRenameHint.test.tsx ui/src/pages/InstanceGeneralSettings.tsx ui/src/pages/InstanceGeneralSettings.test.tsx ui/src/App.tsx
git commit -m "feat(settings): company page with Advanced disclosure; Admin page and sidebar group for instance admins"
```

---

### Task 9: Costs overview for owners, "Activity" rename

**Files:**
- Create: `ui/src/pages/costs/projection.ts`, `ui/src/pages/costs/projection.test.ts`
- Create: `ui/src/pages/costs/CostsOverview.tsx`, `ui/src/pages/costs/CostsOverview.test.tsx`
- Modify: `ui/src/staples/home/BriefingRow.tsx:103` (export `RaiseLimitForm`)
- Modify: `ui/src/pages/Costs.tsx` (render overview; wrap lines ~600-760 summary chrome + tabs in a `<details>`); `ui/src/pages/Costs.test.tsx` (new mocks)
- Modify: `ui/src/pages/audit/AuditHub.tsx:45, 87`; `ui/src/staples/surfaces/registry.ts:281-283`; `ui/src/components/Sidebar.test.tsx:254-256`; `ui/src/pages/AgentDetail.tsx` History link to `/activity` unchanged
- Modify: `ui/src/__tests__/person-facing-copy.test.ts` `SCAN_TARGETS` (+ `{ path: "pages/costs" }`)

**Interfaces:**
- Consumes: `briefingApi.get(companyId, signal)` with `queryKeys.briefing(companyId)` (`Briefing.spend: { monthSpendCents, companyBudgetCents, hosted: { capCents, spentCents } | null } | null`); `agentsApi.list(companyId)` (`Agent.spentMonthlyCents`, `budgetMonthlyCents`, `status`, `pauseReason`); `budgetsApi.overview`, `budgetsApi.upsertPolicy`, `budgetsApi.resolveIncident`; `RaiseLimitForm` props `{ limitCents, observedCents, suggestedCents, maxCents, hosted, pending, onCancel, onSubmit }`; `formatDollars` from `@/lib/utils`.
- Produces: `projectedMonthEndCents(monthSpendCents, now)`, `<CostsOverview companyId />`.

- [ ] **Step 1: Projection helper (test first)**

`ui/src/pages/costs/projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectedMonthEndCents } from "./projection";

describe("projectedMonthEndCents", () => {
  it("scales month-to-date spend to the full month in UTC", () => {
    expect(projectedMonthEndCents(1000, new Date("2026-10-10T12:00:00Z"))).toBe(3100);
  });
  it("is null before there is spend", () => {
    expect(projectedMonthEndCents(0, new Date("2026-10-10T12:00:00Z"))).toBeNull();
  });
});
```

`ui/src/pages/costs/projection.ts`:

```ts
/** Month-to-date spend scaled to the whole UTC month; null until anything was spent. */
export function projectedMonthEndCents(monthSpendCents: number, now: Date): number | null {
  if (monthSpendCents <= 0) return null;
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round((monthSpendCents / day) * daysInMonth);
}
```

- [ ] **Step 2: Overview component (test first)**

`ui/src/pages/costs/CostsOverview.test.tsx` (jsdom; mock `@/api/briefing`, `@/api/agents`, `@/api/budgets`; render inside `QueryClientProvider` + `MemoryRouter`, same style as `Costs.test.tsx`):

1. "shows the meter against the company budget and the projection": briefing spend `{ monthSpendCents: 1200, companyBudgetCents: 6000, hosted: null }`, fake date `2026-10-10T12:00:00Z`; expect text `$12 of $60 this month`, a `[role="progressbar"]` with `aria-valuenow="20"`, and `About $37 by month end at this pace`.
2. "falls back to the hosted cap, then to no limit": `{ monthSpendCents: 500, companyBudgetCents: null, hosted: { capCents: 2000, spentCents: 500 } }` → `$5 of $20 this month`; `{ monthSpendCents: 500, companyBudgetCents: null, hosted: null }` → `$5 this month · no limit set` and the button reads `Set a limit`.
3. "lists agents by spend with a paused badge": agents `[ { name: "Writer", spentMonthlyCents: 800, status: "active", pauseReason: null }, { name: "Researcher", spentMonthlyCents: 300, status: "paused", pauseReason: "budget" } ]` → list items in that order, `Paused by limit` only on Researcher.
4. "raise limit submits a policy when there is no incident": click `Raise limit`, type `90` in the form's input (`aria-label` from `RaiseLimitForm`: find `input[type="number"]` or by label text `New limit (USD)`), submit → `budgetsApi.upsertPolicy` called with `{ scopeType: "company", scopeId: "company-1", metric: "billed_cents", windowKind: "calendar_month_utc", amount: 9000 }`.
5. "raise limit resolves an open incident instead": `budgetsApi.overview` returns `activeIncidents: [{ id: "inc-1", scopeType: "company", … }]` → submit calls `resolveIncident("company-1", "inc-1", { action: "raise_budget_and_resume", amount: 9000 })`.

`ui/src/pages/costs/CostsOverview.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { briefingApi } from "@/api/briefing";
import { agentsApi } from "@/api/agents";
import { budgetsApi } from "@/api/budgets";
import { queryKeys } from "@/lib/queryKeys";
import { formatDollars } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RaiseLimitForm } from "@/staples/home/BriefingRow";
import { projectedMonthEndCents } from "./projection";

/** The owner's view of spend: one meter, the projection, who spent what, and the limit control. */
export function CostsOverview({ companyId, now = new Date() }: { companyId: string; now?: Date }) {
  const queryClient = useQueryClient();
  const [raising, setRaising] = useState(false);
  const briefing = useQuery({ queryKey: queryKeys.briefing(companyId), queryFn: ({ signal }) => briefingApi.get(companyId, signal) });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const budgets = useQuery({ queryKey: queryKeys.budgets.overview(companyId), queryFn: () => budgetsApi.overview(companyId) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.briefing(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  };
  const raise = useMutation({
    mutationFn: async (amount: number) => {
      const incident = budgets.data?.activeIncidents.find((candidate) => candidate.scopeType === "company");
      if (incident) return budgetsApi.resolveIncident(companyId, incident.id, { action: "raise_budget_and_resume", amount });
      return budgetsApi.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, metric: hosted ? "hosted_billed_cents" : "billed_cents", windowKind: "calendar_month_utc", amount });
    },
    onSuccess: () => { setRaising(false); invalidate(); },
  });

  const spend = briefing.data?.spend ?? null;
  if (!spend) return null;
  const hosted = spend.companyBudgetCents === null && spend.hosted !== null;
  const limitCents = spend.companyBudgetCents ?? spend.hosted?.capCents ?? null;
  const spentCents = hosted ? spend.hosted!.spentCents : spend.monthSpendCents;
  const percent = limitCents ? Math.min(100, Math.round((spentCents / limitCents) * 100)) : null;
  const projected = projectedMonthEndCents(spend.monthSpendCents, now);
  const rows = (agents.data ?? [])
    .filter((agent) => agent.status !== "terminated")
    .sort((a, b) => b.spentMonthlyCents - a.spentMonthlyCents);

  return (
    <Card data-testid="costs-overview" className="gap-3 py-4">
      <CardHeader className="gap-1 px-5">
        <CardTitle className="text-base">This month</CardTitle>
        <p className="text-sm text-foreground">
          {limitCents !== null ? `${formatDollars(spentCents)} of ${formatDollars(limitCents)} this month` : `${formatDollars(spentCents)} this month · no limit set`}
        </p>
        {percent !== null ? (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Spend against limit" className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className={percent >= 100 ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {projected !== null ? <p className="text-sm text-muted-foreground">About {formatDollars(projected)} by month end at this pace.</p> : null}
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {rows.length > 0 ? (
          <ul className="divide-y divide-border" aria-label="Spend by agent">
            {rows.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">{agent.name}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  {agent.status === "paused" && agent.pauseReason === "budget" ? <Badge variant="outline">Paused by limit</Badge> : null}
                  {formatDollars(agent.spentMonthlyCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No agents have spent anything yet.</p>}
        {raising ? (
          <RaiseLimitForm
            limitCents={limitCents ?? 0}
            observedCents={spentCents}
            suggestedCents={Math.max(spentCents + 1, (limitCents ?? 0) * 2 || 5000)}
            maxCents={null}
            hosted={hosted}
            pending={raise.isPending}
            onCancel={() => setRaising(false)}
            onSubmit={(amount) => raise.mutate(amount)}
          />
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setRaising(true)}>{limitCents !== null ? "Raise limit" : "Set a limit"}</Button>
          </div>
        )}
        {raise.isError ? <p role="alert" className="text-sm text-destructive">Couldn't change the limit. Try again in a minute.</p> : null}
      </CardContent>
    </Card>
  );
}
```

`style={{ width }}` with a percentage is a runtime value, not a literal; if `check:token-gates` flags it, switch to a CSS variable: `style={{ "--meter": `${percent}%` } as React.CSSProperties}` and `className="h-full w-(--meter) bg-primary"`. Export `RaiseLimitForm` from `BriefingRow.tsx` (prefix `export`). Run the test — PASS.

- [ ] **Step 3: Costs page integration and Details disclosure**

In `Costs.tsx`, inside the `showSummaryChrome` branch, render `<CostsOverview companyId={companyId} />` first, then wrap the existing summary grid, the follow-up notes and the whole `<Tabs>` block in:

```tsx
      <details data-testid="costs-details" className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">Details</summary>
        <div className="mt-4 space-y-5">
          {/* existing summary grid, notes, Tabs */}
        </div>
      </details>
```

When `!showSummaryChrome` (the embedded Budgets-only surface) render the Tabs block as before without the overview or the disclosure. In `Costs.test.tsx` add `vi.mock("../api/briefing", …)` resolving a briefing with `spend: { monthSpendCents: 200, companyBudgetCents: 1000, hosted: null }` and `vi.mock("../api/agents", …)` resolving `[]`; the existing tests that read tile text keep passing because jsdom's `textContent` includes closed `<details>` content; any test that clicks a tab must first open the disclosure (`container.querySelector('[data-testid="costs-details"]')!.open = true`). Add one test asserting the overview renders above the details and that the details element is closed by default.

- [ ] **Step 4: Activity rename**

`AuditHub.tsx:45` label `Activity`, `:87` h1 `Activity`; `registry.ts:282` label `Activity`, and its `reason`/doc text if it says Audit; `Sidebar.test.tsx:254-256` expect `"Activity"` in place of `"Audit"`; `grep -rn '"Audit"' ui/src --include='*.tsx' --include='*.ts'` and rename remaining person-facing labels (`AgentContextualSidebar.tsx:186` → `Activity`, `AgentDetail.tsx:314` legacy tab label). Add `{ path: "pages/costs" }` to `SCAN_TARGETS`.

- [ ] **Step 5: Tests, gates, commit**

Run `pnpm exec vitest run ui/src/pages/costs ui/src/pages/Costs.test.tsx ui/src/components/Sidebar.test.tsx ui/src/pages/audit ui/src/__tests__` — PASS; `pnpm check:token-gates`. Commit:

```bash
git add ui/src/pages/costs ui/src/pages/Costs.tsx ui/src/pages/Costs.test.tsx ui/src/staples/home/BriefingRow.tsx ui/src/pages/audit ui/src/staples/surfaces/registry.ts ui/src/components ui/src/pages/AgentDetail.tsx ui/src/__tests__
git commit -m "feat(costs): owner overview with meter, projection, per-agent spend and raise limit; Audit becomes Activity"
```

---

### Task 10: Full checks and live verification (controller runs this)

- [ ] `pnpm -r typecheck`, `pnpm test:run` (background, log), `pnpm check:token-gates`, `pnpm build` — all green; record failures with output.
- [ ] Restart the dev server (`staples-dev-hosted`, data dir `tmp/staples-hosted2`, port 3100) and walk: `/auth` (wordmark, tagline, examples, legal links; the `/terms` and `/privacy` pages signed out), Home (title suffix "Staples", account menu without a feedback link), an agent page (chip "Ready-made", "Latest work", main-agent wording, no model id, no hash, History links), task thread composer placeholder, `/apps` (Needed by your team for Lantern Candle Co, Popular groups, Advanced toggle reveals providers and the assistant card, no status error), `/company/settings` (Company, Advanced disclosure, footer links) and `/company/settings/instance/general` (Admin), the settings sidebar Admin group, `/activity/costs` (meter, projection, per-agent list, Details closed; breadcrumb "Activity").
- [ ] Phone width (375) on `/auth`, `/apps` and `/activity/costs`: no horizontal scroll, buttons stack.
- [ ] Screenshots of `/auth`, `/apps`, `/activity/costs` saved to the scratchpad for the final report.

## Self-review notes

- Spec coverage: §1 Tasks 1-2; §2 Task 3; §3 Tasks 4-5; §4 Tasks 6-7; §5 Task 8; §6 Task 9; Testing + delivery order Task 10.
- Deviations from the spec, stated: the long tail of copy uses the literal "Staples" rather than the constant (allowed by §1); "Paperclip Labs" and "Paperclip Dot" stay; the Popular set is 18 apps (the spec's 15 plus Google Drive, Docs and Sheets); open connection requests show "<Agent> asked to connect <Service>" with a task link because intents carry no reason text; `featured` is turned off on aggregators and Jira/PostHog so Popular stays short.
- Type consistency: `PendingConnectionRequest` (Task 6) is consumed by `teamNeeds` (Task 7); `showSkills` (Task 4) is a prop, not a hook call inside `AgentOverview`; `RaiseLimitForm` export (Task 9) keeps its existing props.

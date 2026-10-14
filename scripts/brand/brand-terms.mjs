// Rules shared by the rebrand codemod and its guard test. A "mention" is the
// word Paperclip inside person-facing text: string literals, template parts
// and JSX text in TypeScript files; any text in markdown/html/json/js files.
import { createRequire } from "node:module";
import path from "node:path";

// The repo pins TypeScript 7 (native), which has no JS AST API, so parsing goes
// through the oxc parser that ships with the UI's bundler (vite -> rolldown).
const uiRequire = createRequire(new URL("../../ui/package.json", import.meta.url));
const { parseSync } = createRequire(uiRequire.resolve("vite/package.json"))("rolldown/utils");

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

const IMPORT_EXPORT_TYPES = new Set([
  "ImportDeclaration", "ImportExpression", "TSImportType", "TSExternalModuleReference", "TSImportEqualsDeclaration",
]);

/** Byte ranges [start, end) of readable text inside a TS/TSX source. */
function textRanges(source, ext) {
  const lang = ext === ".tsx" ? "tsx" : "ts";
  const { program } = parseSync("file" + ext, source, { lang });
  const ranges = [];
  const visit = (node, parent, key, inImport, inTestId) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child, parent, key, inImport, inTestId); return; }
    if (typeof node.type !== "string") return;
    const reExportSource = parent && (parent.type === "ExportNamedDeclaration" || parent.type === "ExportAllDeclaration")
      && (key === "source" || key === "attributes");
    const importing = inImport || IMPORT_EXPORT_TYPES.has(node.type) || reExportSource;
    const testId = inTestId || (node.type === "JSXAttribute" && node.name?.name === "data-testid");
    const isKey = parent && key === "key" && !parent.computed;
    if (!importing && !testId && !isKey) {
      if (node.type === "Literal" && typeof node.value === "string") ranges.push([node.start + 1, node.end - 1]);
      else if (node.type === "TemplateElement") {
        const text = source.slice(node.start, node.end);
        const lead = /^[`}]/.test(text) ? 1 : 0;
        const trail = text.endsWith("${") ? 2 : text.endsWith("`") ? 1 : 0;
        ranges.push([node.start + lead, node.end - trail]);
      } else if (node.type === "JSXText") ranges.push([node.start, node.end]);
    }
    for (const childKey of Object.keys(node)) {
      if (childKey === "type" || childKey === "start" || childKey === "end") continue;
      visit(node[childKey], node, childKey, importing, testId);
    }
  };
  visit(program, null, null, false, false);
  return ranges;
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

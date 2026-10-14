import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_ALLOWLIST } from "./person-facing-copy.allowlist";

// The repo pins TypeScript 7 (native), which has no JS AST API, so parsing goes
// through the oxc parser that ships with the bundler (same approach as scripts/brand/brand-terms.mjs).
const requireFromHere = createRequire(import.meta.url);
const { parseSync } = createRequire(requireFromHere.resolve("vite/package.json"))("rolldown/utils") as {
  parseSync: (file: string, source: string, options: { lang: string }) => { program: AstNode };
};
const uiSrc = path.resolve(__dirname, "..");

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

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
const SKIP_ATTRIBUTES = /^(className|data-testid|href|to|src|key|id|name|type|value|variant|size)$/;
const SKIP_CALLS = /^(cn|clsx|queryKey|vi\.mock)$/;

function listFiles(target: string): string[] {
  const full = path.join(uiSrc, target);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return listFiles(child);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path.join(uiSrc, child)] : [];
  });
}

function calleeName(callee: AstNode | undefined): string {
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return `${calleeName(callee.object as AstNode)}.${(callee.property as AstNode).name as string}`;
  }
  return "";
}

const IMPORT_EXPORT_TYPES = new Set([
  "ImportDeclaration", "ImportExpression", "TSImportType", "TSExternalModuleReference", "TSImportEqualsDeclaration",
]);

function walk(node: unknown, visit: (node: AstNode, parent: AstNode | null, key: string | null, skip: boolean) => boolean | void, parent: AstNode | null = null, key: string | null = null, skip = false): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent, key, skip);
    return;
  }
  const ast = node as AstNode;
  if (typeof ast.type !== "string") return;
  let nextSkip = skip;
  if (IMPORT_EXPORT_TYPES.has(ast.type)) nextSkip = true;
  if (parent && (parent.type === "ExportNamedDeclaration" || parent.type === "ExportAllDeclaration") && (key === "source" || key === "attributes")) nextSkip = true;
  if (ast.type === "JSXAttribute" && SKIP_ATTRIBUTES.test(String((ast.name as AstNode).name))) nextSkip = true;
  if (ast.type === "CallExpression" && SKIP_CALLS.test(calleeName(ast.callee as AstNode))) nextSkip = true;
  if (visit(ast, parent, key, nextSkip) === false) return;
  for (const childKey of Object.keys(ast)) {
    if (childKey === "type" || childKey === "start" || childKey === "end") continue;
    walk(ast[childKey], visit, ast, childKey, nextSkip);
  }
}

/** Readable text nodes: string literals, template parts and JSX text with a space in them. */
function readableStrings(source: string, root: AstNode, within?: AstNode): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const add = (raw: string, start: number) => {
    const text = raw.trim();
    if (text.includes(" ")) out.push({ text, line: source.slice(0, start).split("\n").length });
  };
  walk(within ?? root, (node, parent, key, skip) => {
    if (skip) return;
    if (parent && key === "key" && !parent.computed) return;
    if (node.type === "Literal" && typeof node.value === "string") add(node.value, node.start);
    else if (node.type === "TemplateElement") add(String((node.value as { cooked?: string; raw: string }).cooked ?? (node.value as { raw: string }).raw), node.start);
    else if (node.type === "JSXText") add(source.slice(node.start, node.end), node.start);
  });
  return out;
}

/** A `function Name` declaration or `const Name = ...` binding, so one component can be scanned alone. */
function functionNode(root: AstNode, name: string): AstNode {
  let found: AstNode | undefined;
  walk(root, (node) => {
    if (found) return false;
    if (node.type === "FunctionDeclaration" && (node.id as AstNode | null)?.name === name) found = node;
    else if (node.type === "VariableDeclarator" && (node.id as AstNode).name === name) found = node;
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
        const { program } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
        const relative = path.relative(uiSrc, file);
        for (const entry of readableStrings(source, program, target.fn ? functionNode(program, target.fn) : undefined)) {
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

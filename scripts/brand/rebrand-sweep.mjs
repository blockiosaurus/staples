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

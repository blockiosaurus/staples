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
  it("keeps the upstream product name out of person-facing text", () => {
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

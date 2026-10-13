import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANT_READ_TOOL_NAMES, ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES, ASSISTANT_WRITE_TOOL_NAMES } from "../services/assistant-tools.js";

const TOOL_NAME = /\b(?:staples|paperclip)_[a-z0-9_]+\b/g;
const assistantInstructions = fileURLToPath(new URL("../built-ins/agents/assistant/AGENTS.md", import.meta.url));
const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));

async function instructionFiles() {
  const skills = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("staples-"))
    .map((entry) => join(skillsDir, entry.name, "SKILL.md"));
  return [assistantInstructions, ...skills];
}

describe("Assistant instructions and tool list", () => {
  it("names only tools the Assistant actually has", async () => {
    const tools = new Set<string>([...ASSISTANT_READ_TOOL_NAMES, ...ASSISTANT_WRITE_TOOL_NAMES, ...ASSISTANT_WEEKLY_UPDATE_RUN_WRITE_TOOL_NAMES]);
    const files = await instructionFiles();
    expect(files.length).toBeGreaterThan(1);
    const missing: string[] = [];
    let mentioned = 0;
    for (const file of files) {
      const names = new Set((await readFile(file, "utf8")).match(TOOL_NAME) ?? []);
      mentioned += names.size;
      for (const name of names) if (!tools.has(name)) missing.push(`${name} (${file})`);
    }
    expect(mentioned).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

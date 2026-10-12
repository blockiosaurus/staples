import { describe, expect, it } from "vitest";
import { MISSING_KEY_MESSAGE, runSmoke } from "./smoke.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("smoke script", () => {
  it("without a key prints the message and exits 1", async () => {
    const c = capture();
    expect(await runSmoke([], {}, c.io)).toBe(1);
    expect(c.err).toEqual([MISSING_KEY_MESSAGE]);
    expect(c.out).toEqual([]);
  });

  it("--fake runs the adapter against the fake server and passes without a key", async () => {
    const c = capture();
    const code = await runSmoke(["--fake"], {}, c.io);
    expect(c.err).toEqual([]);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("echo_note calls: 1");
    expect(text).toContain("PASS");
    expect(text).toMatch(/Archived session /);
  });
});

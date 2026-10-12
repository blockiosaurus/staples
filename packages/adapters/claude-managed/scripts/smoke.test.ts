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
    expect(text).toMatch(/Session started: sesn_/);
  });

  it("cancels a never-idle session on the timeout and still archives it", async () => {
    const c = capture();
    const started = Date.now();
    const code = await runSmoke(["--fake"], { SMOKE_FAKE_SCENARIO: "never_idle", SMOKE_TIMEOUT_MS: "500" }, c.io);
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    const text = c.out.join("\n");
    const initId = /Session started: (\S+)/.exec(text)?.[1];
    expect(initId).toBeTruthy();
    expect(text).toContain(`Archived session ${initId}.`);
    expect(c.err.join("\n")).toMatch(/Timed out after/);
    expect(c.err.join("\n")).toMatch(/did not finish within/);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
});

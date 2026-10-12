import { describe, expect, it } from "vitest";
import { MISSING_KEY_MESSAGE, SCENARIOS, parseSmokeArgs, runSmoke, type SmokeSummary } from "./smoke.js";

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

  it("parses --scenario (repeatable, comma lists, all) and rejects unknown names", () => {
    expect(parseSmokeArgs([])).toEqual({ fake: false, json: false, scenarios: ["basic"] });
    expect(parseSmokeArgs(["--fake", "--scenario", "resume", "--scenario=cancel,budget", "--json"])).toEqual({
      fake: true,
      json: true,
      scenarios: ["resume", "cancel", "budget"],
    });
    expect(parseSmokeArgs(["--scenario", "all"])).toMatchObject({ scenarios: [...SCENARIOS] });
    expect(parseSmokeArgs(["--scenario", "nope"])).toMatchObject({ error: expect.stringContaining('Unknown scenario "nope"') });
    expect(parseSmokeArgs(["--scenario"])).toMatchObject({ error: expect.stringContaining("needs a value") });
  });

  it("an unknown scenario exits 1 before doing anything", async () => {
    const c = capture();
    expect(await runSmoke(["--fake", "--scenario", "nope"], {}, c.io)).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err[0]).toMatch(/Unknown scenario/);
  });

  it("--fake --scenario all passes every scenario and prints a JSON summary", async () => {
    const c = capture();
    const code = await runSmoke(["--fake", "--scenario", "all", "--json"], {}, c.io);
    expect(c.err).toEqual([]);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    for (const name of SCENARIOS) {
      expect(text).toContain(`PASS ${name}:`);
      expect(text).toMatch(new RegExp(`cost \\(USD\\) ${name}: `));
    }
    expect(text).toMatch(/Total cost \(USD\): [\d.]+ across 10 scenario\(s\)/);
    expect(text).toContain("second run: resumed true");
    expect(text).toContain("session budget cap: $0.01");
    expect(text).toContain('"allowed_hosts":["example.com"]');
    expect(text).toContain("check claude_managed_auth_ok (info)");
    expect(text).not.toContain("sk-ant-fake");

    const summary = JSON.parse(c.out[c.out.length - 1]!) as SmokeSummary;
    expect(summary.mode).toBe("fake");
    expect(summary.passed).toBe(true);
    expect(Object.keys(summary.scenarios)).toEqual([...SCENARIOS]);
    for (const s of Object.values(summary.scenarios)) expect(s?.status).toBe("pass");
    const sum = Object.values(summary.scenarios).reduce((acc, s) => acc + (s?.costUsd ?? 0), 0);
    expect(summary.totalCostUsd).toBeCloseTo(sum, 6);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.scenarios.resume?.details).toMatchObject({ firstCostUsd: 0.01, secondCostUsd: 0.02, sessionTotalCostUsd: 0.03 });
    expect(summary.scenarios.cancel?.details).toMatchObject({ idleObserved: true, sessionStatus: "idle" });
    // Every session a scenario started was archived.
    for (const s of Object.values(summary.scenarios)) {
      for (const id of s?.sessionIds ?? []) expect(text).toContain(`Archived session ${id}.`);
    }
    // One default environment plus one for limited networking; one agent per model.
    const envs = new Set(Object.values(summary.scenarios).flatMap((s) => s?.environmentIds ?? []));
    const agents = new Set(Object.values(summary.scenarios).flatMap((s) => s?.agentIds ?? []));
    expect(envs.size).toBe(2);
    expect(agents.size).toBe(3);
    expect(process.listenerCount("SIGINT")).toBe(0);
  }, 60_000);

  it("models reports an unsupported model without failing the run", async () => {
    const c = capture();
    const code = await runSmoke(["--fake", "--scenario", "models"], { MANAGED_AGENTS_MODELS: "claude-sonnet-5-5,claude-unsupported-9" }, c.io);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("PASS claude-sonnet-5-5:");
    expect(text).toMatch(/FAIL claude-unsupported-9: .*400 invalid_request_error/);
    expect(text).toContain("INFO models:");
  });
});

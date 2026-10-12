import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgentJwtSecret, resolveAgentJwtSecretFilePath } from "../agent-jwt-secret.js";

describe("ensureAgentJwtSecret", () => {
  const dirs: string[] = [];
  const tempSecretsDir = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agent-jwt-secret-"));
    dirs.push(root);
    return path.join(root, "secrets");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("generates a 32-byte hex secret once (0600 file, 0700 dir), sets the env and logs the path, never the value", () => {
    const secretsDir = tempSecretsDir();
    const env: NodeJS.ProcessEnv = {};
    const log = vi.fn();
    const result = ensureAgentJwtSecret({ env, secretsDir, log });
    const file = resolveAgentJwtSecretFilePath(secretsDir);
    expect(result).toEqual({ source: "generated", path: file });
    const value = readFileSync(file, "utf8");
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe(value);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(secretsDir).mode & 0o777).toBe(0o700);
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe(`Generated a local agent run-token secret at ${file}`);
    expect(log.mock.calls[0]![0]).not.toContain(value);
  });

  it("reuses the persisted secret on restart without logging again", () => {
    const secretsDir = tempSecretsDir();
    const first: NodeJS.ProcessEnv = {};
    ensureAgentJwtSecret({ env: first, secretsDir });
    const second: NodeJS.ProcessEnv = {};
    const log = vi.fn();
    expect(ensureAgentJwtSecret({ env: second, secretsDir, log }).source).toBe("file");
    expect(second.PAPERCLIP_AGENT_JWT_SECRET).toBe(first.PAPERCLIP_AGENT_JWT_SECRET);
    expect(log).not.toHaveBeenCalled();
  });

  it("never overrides or writes when a secret is configured", () => {
    for (const env of [{ PAPERCLIP_AGENT_JWT_SECRET: "configured-agent-secret" }, { BETTER_AUTH_SECRET: "configured-auth-secret" }] as NodeJS.ProcessEnv[]) {
      const secretsDir = tempSecretsDir();
      const before = { ...env };
      expect(ensureAgentJwtSecret({ env, secretsDir })).toEqual({ source: "configured" });
      expect(env).toEqual(before);
      expect(() => statSync(resolveAgentJwtSecretFilePath(secretsDir))).toThrow();
    }
  });

  it("tightens loose permissions on an existing secret and refuses a too-short one", () => {
    if (process.platform === "win32") return;
    const secretsDir = tempSecretsDir();
    mkdirSync(secretsDir, { recursive: true, mode: 0o755 });
    const file = resolveAgentJwtSecretFilePath(secretsDir);
    writeFileSync(file, "a".repeat(64), { mode: 0o644 });
    const env: NodeJS.ProcessEnv = {};
    expect(ensureAgentJwtSecret({ env, secretsDir }).source).toBe("file");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(secretsDir).mode & 0o777).toBe(0o700);
    writeFileSync(file, "short");
    expect(() => ensureAgentJwtSecret({ env: {}, secretsDir })).toThrow(/at least 32 characters/);
  });
});

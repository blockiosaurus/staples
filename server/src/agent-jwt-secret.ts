import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "./home-paths.js";

/**
 * The run-token signing secret (agent JWTs: run-scoped tokens that give agents
 * their Staples tools). Without one, agents run with no Staples tools, so an
 * local_trusted instance that configures neither PAPERCLIP_AGENT_JWT_SECRET
 * nor BETTER_AUTH_SECRET gets a persisted, generated one:
 * `<instance>/secrets/agent-jwt-secret` (directory 0700, file 0600, 32 random
 * bytes as hex). A configured secret always wins and is never overwritten.
 * The value is never logged.
 */

const MIN_SECRET_LENGTH = 32;
const FILE_NAME = "agent-jwt-secret";

export function resolveAgentJwtSecretFilePath(secretsDir = path.dirname(resolveDefaultSecretsKeyFilePath())): string {
  return path.join(secretsDir, FILE_NAME);
}

function assertOwnedByCurrentUser(stats: Stats, description: string) {
  if (process.platform === "win32") return;
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`${description} must be owned by the Paperclip process user`);
  }
}

function enforceMode(target: string, kind: "file" | "directory", mode: number) {
  const description = kind === "file" ? `Agent run-token secret at ${target}` : `Secrets directory at ${target}`;
  const check = (stats: Stats) => {
    if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) throw new Error(`${description} must be a regular ${kind}`);
    assertOwnedByCurrentUser(stats, description);
  };
  let stats = lstatSync(target);
  check(stats);
  if (process.platform === "win32" || (stats.mode & 0o077) === 0) return;
  chmodSync(target, mode);
  stats = lstatSync(target);
  check(stats);
  if ((stats.mode & 0o077) !== 0) throw new Error(`${description} must have permissions ${mode.toString(8).padStart(4, "0")}`);
}

function readSecret(keyPath: string): string {
  enforceMode(keyPath, "file", 0o600);
  const existing = readFileSync(keyPath, "utf8").trim();
  if (existing.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Invalid agent run-token secret at ${keyPath} (must be at least ${MIN_SECRET_LENGTH} characters); remove the file to regenerate it or set PAPERCLIP_AGENT_JWT_SECRET`,
    );
  }
  return existing;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function loadOrCreate(keyPath: string): { secret: string; generated: boolean } {
  const dir = path.dirname(keyPath);
  try {
    enforceMode(dir, "directory", 0o700);
    return { secret: readSecret(keyPath), generated: false };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  enforceMode(dir, "directory", 0o700);
  const generated = randomBytes(32).toString("hex");
  const temporaryPath = `${keyPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    enforceMode(temporaryPath, "file", 0o600);
    try {
      // Publish only a complete secret; a hard link never replaces one another process wrote first.
      linkSync(temporaryPath, keyPath);
      enforceMode(keyPath, "file", 0o600);
      return { secret: generated, generated: true };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return { secret: readSecret(keyPath), generated: false };
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export type AgentJwtSecretSource = "configured" | "file" | "generated" | "missing";

/** A secret env var counts as set only when it is non-blank (the agent JWT config trims and ignores blanks). */
const isSet = (value: string | undefined) => Boolean(value?.trim());

/**
 * Startup: make sure a run-token signing secret is set before anything reads
 * the JWT config. Does nothing when PAPERCLIP_AGENT_JWT_SECRET or
 * BETTER_AUTH_SECRET is set to a non-blank value (worktree/fork instances set
 * it deliberately; blank values count as unset, like the JWT config).
 *
 * Only a `local_trusted` instance gets a generated secret: in authenticated
 * modes PAPERCLIP_AGENT_JWT_SECRET is also better-auth's fallback login
 * secret, so it must be configured on purpose (better-auth still refuses to
 * start without one). There, a missing secret is reported with an operator
 * hint (`warn`) and nothing is written.
 *
 * Otherwise reads the instance's persisted secret, generating it on first
 * start, and sets PAPERCLIP_AGENT_JWT_SECRET for this process.
 */
export function ensureAgentJwtSecret(options: {
  deploymentMode: string;
  env?: NodeJS.ProcessEnv;
  secretsDir?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): { source: AgentJwtSecretSource; path?: string } {
  const env = options.env ?? process.env;
  if (isSet(env.PAPERCLIP_AGENT_JWT_SECRET) || isSet(env.BETTER_AUTH_SECRET)) return { source: "configured" };
  if (options.deploymentMode !== "local_trusted") {
    options.warn?.(
      "No agent run-token secret is configured, so agents run without their Staples tools. Set PAPERCLIP_AGENT_JWT_SECRET (and BETTER_AUTH_SECRET) for this instance.",
    );
    return { source: "missing" };
  }
  const keyPath = resolveAgentJwtSecretFilePath(options.secretsDir);
  const { secret, generated } = loadOrCreate(keyPath);
  env.PAPERCLIP_AGENT_JWT_SECRET = secret;
  if (generated) options.log?.(`Generated a local agent run-token secret at ${keyPath}`);
  return { source: generated ? "generated" : "file", path: keyPath };
}

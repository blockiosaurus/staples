import os from "node:os";
import { getSelfServePolicy } from "./self-serve-policy.js";

/**
 * Git hardening for server-side git invocations.
 *
 * Command-line `-c` settings always win over a repository's own `.git/config`,
 * so they are how a server-side git call neutralises a planted configuration.
 */

/**
 * Config for a git invocation inside a managed workspace folder (the file
 * browser's status scan, checkout after a managed clone, origin lookups): a
 * repository-local `core.fsmonitor` or hooks folder never runs a program.
 */
export const MANAGED_WORKSPACE_GIT_CONFIG_ARGS: readonly string[] = Object.freeze([
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${os.devNull}`,
]);

/**
 * Config for a clone or fetch of a URL a user supplied. `ext::` (runs an
 * arbitrary command) is always refused. While self-serve companies are on, the
 * `file` transport (a `file://` URL or a bare server path, which would copy
 * another tenant's or the server's files into a workspace the file browser
 * serves) is refused for every company. A self-serve-free instance keeps local
 * paths, which trusted operators use for local repositories.
 */
export function untrustedRemoteGitConfigArgs(): string[] {
  const args = ["-c", "protocol.ext.allow=never"];
  // With untrusted tenants, no fetch or ls-remote may follow a redirect to a
  // host the clone-time address check never saw.
  if (getSelfServePolicy().enabled) args.push("-c", "protocol.file.allow=never", "-c", "http.followRedirects=false");
  return args;
}

/**
 * Extra config for a clone in a self-serve company: no redirect to a host the
 * clone-time address check never saw.
 */
export const SELF_SERVE_CLONE_GIT_CONFIG_ARGS: readonly string[] = Object.freeze([
  "-c", "http.followRedirects=false",
]);

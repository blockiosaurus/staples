/**
 * Native skills for claude_managed.
 *
 * The server resolves the company skill library into `config.paperclipRuntimeSkills`
 * (the same entries claude_local mounts). For each skill this agent wants, the
 * adapter reads its files, hashes them, and makes sure a custom skill with that
 * exact content exists in the Anthropic workspace (display name
 * `staples-<runtimeName>-<sha256>`): it lists the workspace's skills once per
 * process and reuses an exact title match, otherwise it uploads. The agent
 * definition pins each skill's version id.
 *
 * When the Skills API refuses (403/404/unsupported/beta not enabled), skills are
 * inlined into the system prompt instead (bounded), with one warning per run.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { buildSkillLibraryManifestMarkdown } from "@paperclipai/adapter-utils/skill-library-manifest";
import { ManagedAgentsApiError, type ManagedAgentsClient } from "../client.js";
import type { AgentSkillRef, ManagedSkill, SkillUploadFile } from "../types.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Per-skill upload cap (sum of file sizes). */
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
/** Per-skill file count cap. */
export const MAX_SKILL_FILES = 200;
/** Total size of skill text inlined into the system prompt on fallback. */
export const MAX_INLINE_SKILL_CHARS = 60 * 1024;
const SKILLS_LIST_PAGE_LIMIT = 100;
const SKILLS_LIST_MAX_PAGES = 50;
/** How long a refusal is remembered before the Skills API is tried again. */
const REFUSAL_TTL_MS = 10 * 60_000;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

type OnLog = AdapterExecutionContext["onLog"];

export interface LocalSkill {
  key: string;
  runtimeName: string;
  /** sha256 over the runtime name and every file's path + content. */
  hash: string;
  /** `staples-<runtimeName>-<sha256>` (full 64-character content hash). */
  title: string;
  /** Paths relative to the skill root (`SKILL.md`, `references/x.md`, ...). */
  files: Array<{ path: string; content: string }>;
  skillMd: string;
  /** Files left out (binary, oversized, over the count cap). */
  skipped: string[];
}

export interface SkillsResolution {
  /** Agent `skills` entries (pinned versions), sorted by skill id. */
  refs: AgentSkillRef[];
  /** Text appended to the system prompt: library manifest + any inlined skills. */
  systemAppendix: string;
  /** Skills uploaded/reused natively, by runtime name. */
  native: Array<{ runtimeName: string; skillId: string; version: string; reused: boolean }>;
  /** Skills inlined into the system prompt, by runtime name. */
  inlined: string[];
  /** True when the Skills API refused and every skill was inlined. */
  fallback: boolean;
}

// ---------------------------------------------------------------------------
// Reading local skills
// ---------------------------------------------------------------------------

/**
 * Desired, available runtime skill entries for this agent: the operational
 * Staples skill (`paperclip`) and the feedback skills, plus the agent's desired
 * company skills. Same resolver as claude_local.
 */
export async function readDesiredSkillEntries(
  config: Record<string, unknown>,
  onLog: OnLog,
): Promise<{ all: PaperclipSkillEntry[]; desired: PaperclipSkillEntry[]; desiredKeys: Set<string> }> {
  // Only the server-resolved list counts. Without it (tests, scripts) there are no
  // skills: the adapter-utils fallback (this package's bundled skills directory)
  // means nothing for an agent that runs in Anthropic's cloud.
  const all = Array.isArray(config.paperclipRuntimeSkills) ? await readPaperclipRuntimeSkillEntries(config, __moduleDir) : [];
  // claude_managed is not a native runner: nothing else gives it the Staples
  // operating contract (heartbeats, task updates, questions, the Company Brief),
  // so the required operational skill is always attached, as for claude_local.
  const desiredKeys = new Set(resolveLegacyPaperclipDesiredSkillNames(config, all));
  const desired: PaperclipSkillEntry[] = [];
  for (const entry of all) {
    if (!desiredKeys.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      await onLog(
        "stderr",
        `[staples] Warning: skill "${entry.key}" is enabled for this agent but its files are unavailable${entry.missingDetail ? `: ${entry.missingDetail}` : "."}\n`,
      );
      continue;
    }
    desired.push(entry);
  }
  return { all, desired, desiredKeys };
}

function isProbablyText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, child)));
    else if (entry.isFile()) out.push(child); // symlinks are skipped
  }
  return out;
}

/**
 * `staples-<slug>-<sha256 hex>`: the FULL 64-character content hash. The
 * workspace (one per API key) is shared by every company on the operator's
 * hosted key, and an exact title match is reused, so a short hash prefix could
 * be brute-forced to make another company's agent attach crafted content.
 * Display names are single-line, max 255 chars: the slug is capped so the
 * title always fits (8 + 180 + 1 + 64 = 253).
 */
export function skillTitle(runtimeName: string, hash: string): string {
  const slug = runtimeName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180).replace(/-+$/g, "") || "skill";
  return `staples-${slug}-${hash}`;
}

/** Reads one skill directory: SKILL.md first, then other text files (capped). Null when SKILL.md is missing. */
export async function readLocalSkill(entry: Pick<PaperclipSkillEntry, "key" | "runtimeName" | "source">): Promise<LocalSkill | null> {
  let skillMd: string;
  try {
    const skillMdPath = path.join(entry.source, "SKILL.md");
    const stat = await fs.lstat(skillMdPath);
    // Like other files: no symlinks, and SKILL.md alone must fit the per-skill cap.
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
    skillMd = await fs.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const files: LocalSkill["files"] = [{ path: "SKILL.md", content: skillMd }];
  const skipped: string[] = [];
  let bytes = Buffer.byteLength(skillMd);
  let paths: string[] = [];
  try {
    paths = (await walk(entry.source)).filter((p) => p !== "SKILL.md");
  } catch {
    paths = [];
  }
  for (const rel of paths) {
    if (files.length >= MAX_SKILL_FILES) {
      skipped.push(rel);
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(entry.source, rel));
    } catch {
      skipped.push(rel);
      continue;
    }
    if (!isProbablyText(buffer) || bytes + buffer.length > MAX_SKILL_BYTES) {
      skipped.push(rel);
      continue;
    }
    bytes += buffer.length;
    files.push({ path: rel, content: buffer.toString("utf8") });
  }
  const hasher = createHash("sha256");
  hasher.update(`v1\0${entry.runtimeName}\0`);
  for (const file of files) hasher.update(`${file.path}\0${file.content}\0`);
  const hash = hasher.digest("hex");
  return { key: entry.key, runtimeName: entry.runtimeName, hash, title: skillTitle(entry.runtimeName, hash), files, skillMd, skipped };
}

// ---------------------------------------------------------------------------
// Workspace sync (cached per process and workspace)
// ---------------------------------------------------------------------------

interface WorkspaceState {
  /** Title -> skill, from one listing per process (plus our own uploads). */
  listing: Promise<Map<string, ManagedSkill>> | null;
  /** Upload in flight or done, by content hash (dedupes concurrent runs). */
  uploads: Map<string, Promise<ManagedSkill>>;
  /** Hashes the API rejected (e.g. invalid frontmatter): inline them without retrying. */
  rejected: Map<string, string>;
  refusedUntil: number;
  refusalReason: string | null;
  /** The refusal warning was logged for the current refusal window. */
  refusalWarned: boolean;
}

const workspaces = new Map<string, WorkspaceState>();

/** Test seam: forget every cached listing, upload and refusal. */
export function resetSkillsCache(): void {
  workspaces.clear();
}

/**
 * Forgets a workspace's skill listing and uploads (keeps refusals and per-skill
 * rejections), so the next resolution lists again. Used when the agent API
 * reports that a cached skill no longer exists.
 */
export function invalidateSkillsListing(key: string): void {
  const state = workspaces.get(key);
  if (!state) return;
  state.listing = null;
  state.uploads.clear();
}

/** Cache key: base URL + a hash of the API key (different keys can be different workspaces). */
export function workspaceKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

function workspace(key: string): WorkspaceState {
  let state = workspaces.get(key);
  if (!state) {
    state = { listing: null, uploads: new Map(), rejected: new Map(), refusedUntil: 0, refusalReason: null, refusalWarned: false };
    workspaces.set(key, state);
  }
  return state;
}

/**
 * API ASSUMPTION (skills refusal): the Skills API docs list no error codes. A
 * workspace without Skills access is assumed to answer 403 (permission) or
 * 404 / 405 / 501 (endpoint not available) on any call, and on the LISTING call
 * also 400 whose message mentions a beta / feature not being enabled or
 * supported. Those mean "inline skills instead". On an upload, 400 / 413 / 422
 * are always per-skill validation failures (e.g. SKILL.md frontmatter), whatever
 * the message says. 401 / 429 / 5xx / connection errors fail the run.
 */
export function isSkillsApiRefusal(error: unknown, call: "list" | "upload" = "list"): boolean {
  if (!(error instanceof ManagedAgentsApiError)) return false;
  if (error.status === 403 || error.status === 404 || error.status === 405 || error.status === 501) return true;
  if (call === "list" && error.status === 400) return /beta|not (?:yet )?(?:enabled|supported|available)|unsupported|access/i.test(error.message);
  return false;
}

function isUploadValidationFailure(error: unknown): boolean {
  return error instanceof ManagedAgentsApiError && (error.status === 400 || error.status === 413 || error.status === 422);
}

/** Shared calls (listing, uploads) run on their own timeout; each caller races its own signal. */
const SHARED_CALL_TIMEOUT_MS = 120_000;

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function listByTitle(client: ManagedAgentsClient, signal?: AbortSignal): Promise<Map<string, ManagedSkill>> {
  const byTitle = new Map<string, ManagedSkill>();
  let page: string | undefined;
  for (let i = 0; i < SKILLS_LIST_MAX_PAGES; i += 1) {
    const result = await client.listSkills({ limit: SKILLS_LIST_PAGE_LIMIT, page, source: "custom" }, { signal });
    for (const skill of Array.isArray(result.data) ? result.data : []) {
      if (!skill?.display_name?.startsWith("staples-") || !skill.latest_version_id) continue;
      // Titles carry a content hash; on duplicates keep the newest.
      const existing = byTitle.get(skill.display_name);
      if (!existing || String(skill.created_at ?? "") > String(existing.created_at ?? "")) byTitle.set(skill.display_name, skill);
    }
    page = typeof result.next_page === "string" && result.next_page ? result.next_page : undefined;
    if (!page) break;
  }
  return byTitle;
}

function toUploadFiles(skill: LocalSkill): SkillUploadFile[] {
  // The top-level directory is the title, so each upload is self-describing.
  return skill.files.map((file) => ({ path: `${skill.title}/${file.path}`, content: file.content }));
}

/**
 * Inlines skills into a bounded system-prompt section. SKILL.md bodies only;
 * supporting files are listed by name.
 */
export function buildInlineSkillsSection(skills: LocalSkill[], maxChars = MAX_INLINE_SKILL_CHARS): string {
  if (skills.length === 0) return "";
  const header = [
    "## Skills",
    "",
    "These skills are loaded for you below (the skills service was not available for this agent).",
    "Follow a skill's instructions when a task matches its description.",
    "",
    ...skills.map((s) => `- ${s.runtimeName}`),
  ].join("\n");
  let out = header;
  const omitted: string[] = [];
  for (const skill of skills) {
    const extra = skill.files.length > 1 ? `\n\n(Supporting files not loaded: ${skill.files.slice(1).map((f) => f.path).join(", ")})` : "";
    const block = `\n\n### Skill: ${skill.runtimeName}\n\n${skill.skillMd.trim()}${extra}`;
    if (out.length + block.length <= maxChars) {
      out += block;
      continue;
    }
    const room = maxChars - out.length - 200;
    if (room > 500) {
      out += `${block.slice(0, room)}\n\n[Staples truncated this skill to fit the system prompt.]`;
    } else {
      omitted.push(skill.runtimeName);
    }
  }
  if (omitted.length) out += `\n\n[Staples omitted these skills to stay within ${Math.round(maxChars / 1024)} KB: ${omitted.join(", ")}.]`;
  return out;
}

/**
 * Resolves this run's skills: native refs (uploading or reusing) or, on refusal,
 * an inlined system-prompt section. Throws only for real failures (auth, 5xx,
 * rate limits, connection) so the run fails as it would for any API error.
 */
export async function resolveAgentSkills(input: {
  config: Record<string, unknown>;
  client: ManagedAgentsClient;
  workspaceKey: string;
  onLog: OnLog;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<SkillsResolution> {
  const { config, client, onLog, signal } = input;
  const now = input.now ?? Date.now;
  const { all, desired, desiredKeys } = await readDesiredSkillEntries(config, onLog);
  const manifest = buildSkillLibraryManifestMarkdown({ entries: all, desiredSkillKeys: desiredKeys }) ?? "";

  const local: LocalSkill[] = [];
  for (const entry of desired) {
    const skill = await readLocalSkill(entry);
    if (!skill) {
      await onLog("stderr", `[staples] Warning: skill "${entry.key}" has no readable SKILL.md (missing, a symlink, or over ${MAX_SKILL_BYTES / 1024 / 1024} MB) and was not attached.\n`);
      continue;
    }
    if (skill.skipped.length) {
      await onLog("stderr", `[staples] Skill "${entry.key}": left out ${skill.skipped.length} file(s) (binary, over ${MAX_SKILL_BYTES / 1024 / 1024} MB or over ${MAX_SKILL_FILES} files).\n`);
    }
    local.push(skill);
  }
  local.sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));

  const result: SkillsResolution = { refs: [], systemAppendix: "", native: [], inlined: [], fallback: false };
  const finish = (inline: LocalSkill[]): SkillsResolution => {
    result.inlined = inline.map((s) => s.runtimeName);
    result.refs.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
    result.systemAppendix = [manifest, buildInlineSkillsSection(inline)].filter(Boolean).join("\n\n");
    return result;
  };
  if (local.length === 0) return finish([]);

  const state = workspace(input.workspaceKey);
  const refuse = async (reason: string): Promise<SkillsResolution> => {
    result.fallback = true;
    result.refs = [];
    result.native = [];
    if (!state.refusalWarned) {
      state.refusalWarned = true;
      await onLog("stderr", `[staples] Warning: the Anthropic Skills API is not available for this key (${reason}); skills are added to the system prompt instead (retried after ${REFUSAL_TTL_MS / 60_000} minutes).\n`);
    }
    return finish(local);
  };
  if (state.refusedUntil > now()) return refuse(state.refusalReason ?? "refused earlier");

  let call: "list" | "upload" = "list";
  try {
    if (!state.listing) {
      const listing = listByTitle(client, AbortSignal.timeout(SHARED_CALL_TIMEOUT_MS));
      state.listing = listing;
      listing.catch(() => {
        if (state.listing === listing) state.listing = null;
      });
    }
    const byTitle = await raceSignal(state.listing, signal);
    call = "upload";
    const inline: LocalSkill[] = [];
    for (const skill of local) {
      if (state.rejected.has(skill.hash)) {
        inline.push(skill);
        continue;
      }
      const found = byTitle.get(skill.title);
      if (found) {
        result.refs.push({ type: "custom", skill_id: found.id, version: found.latest_version_id });
        result.native.push({ runtimeName: skill.runtimeName, skillId: found.id, version: found.latest_version_id, reused: true });
        continue;
      }
      let upload = state.uploads.get(skill.hash);
      if (!upload) {
        const started = client.uploadSkill(
          { displayName: skill.title, files: toUploadFiles(skill) },
          { signal: AbortSignal.timeout(SHARED_CALL_TIMEOUT_MS) },
        );
        upload = started;
        state.uploads.set(skill.hash, started);
        started.then(
          (created) => byTitle.set(skill.title, created),
          () => {
            if (state.uploads.get(skill.hash) === started) state.uploads.delete(skill.hash);
          },
        );
      }
      try {
        const created = await raceSignal(upload, signal);
        result.refs.push({ type: "custom", skill_id: created.id, version: created.latest_version_id });
        result.native.push({ runtimeName: skill.runtimeName, skillId: created.id, version: created.latest_version_id, reused: false });
      } catch (error) {
        if (signal?.aborted || !isUploadValidationFailure(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        state.rejected.set(skill.hash, reason);
        await onLog("stderr", `[staples] Warning: skill "${skill.key}" could not be uploaded (${reason}); it was added to the system prompt instead.\n`);
        inline.push(skill);
      }
    }
    return finish(inline);
  } catch (error) {
    if (signal?.aborted || !isSkillsApiRefusal(error, call)) throw error;
    state.refusedUntil = now() + REFUSAL_TTL_MS;
    state.refusalWarned = false;
    state.refusalReason = error instanceof ManagedAgentsApiError ? `${error.status} ${error.errorType}` : "refused";
    return refuse(state.refusalReason);
  }
}

// ---------------------------------------------------------------------------
// Adapter skill hooks (skills UI / sync)
// ---------------------------------------------------------------------------

async function buildSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "claude_managed",
    availableEntries,
    desiredSkills,
    configuredDetail: "Uploaded to Anthropic as a custom skill and attached to the agent on the next run.",
  });
}

export async function listClaudeManagedSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncClaudeManagedSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

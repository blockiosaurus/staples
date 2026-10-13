/**
 * In-process fake of the Claude Managed Agents API for tests (node:http).
 *
 * - Records every request (method, path, headers, parsed body).
 * - Validates the required headers on every request (x-api-key, anthropic-version,
 *   anthropic-beta containing managed-agents-2026-04-01) and answers 401/400 with
 *   an Anthropic-style error body when they are missing.
 * - Plays scripted SSE event sequences per session turn. A turn starts when a
 *   `user.message` event arrives. Steps can emit events, wait for a
 *   `user.custom_tool_result`, or pause. A `user.interrupt` stops the running turn
 *   and the session goes idle (usage + `session.status_idle` end_turn).
 * - Fault injection: `failNext()` answers matching requests with an error status.
 *
 * Delivery: events go to every open stream for the session. Like the real API,
 * events emitted while no stream is open are dropped from the stream (they stay in
 * `emittedEvents()`); opt into `bufferUntilStream` to flush them to the next stream.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MANAGED_AGENTS_BETA, ANTHROPIC_VERSION } from "../types.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  /** Request headers; `x-api-key` is replaced with "[redacted]" when present. */
  headers: Record<string, string | string[] | undefined>;
  /** Whether `x-api-key` matched the fake's key. */
  hasValidKey: boolean;
  body: unknown;
}

export type FakeEventPayload = Record<string, unknown> & { type: string };

export type TurnStep =
  | { kind: "emit"; event: FakeEventPayload }
  | {
      kind: "custom_tool_call";
      name: string;
      input?: Record<string, unknown>;
      /** Event id for the `agent.custom_tool_use` event; generated when omitted. */
      id?: string;
      /** Emit `session.status_idle` requires_action before waiting. Default true. */
      emitRequiresAction?: boolean;
    }
  | { kind: "delay"; ms: number }
  /** Waits until a `user.interrupt` arrives (simulates a long-running turn). */
  | { kind: "hang" };

export type TurnScript = TurnStep[];

/** What a turn factory sees when a `user.message` starts a turn. */
export interface FakeTurnContext {
  sessionId: string;
  /** The agent snapshot the session runs with (system, tools, skills, ...). */
  agent: Record<string, unknown>;
  /** Files of the custom skills attached to the session's agent, keyed by skill id. */
  attachedSkillFiles: Map<string, Array<{ path: string; content: string }>>;
  /** Text of the user.message that started the turn. */
  userText: string;
}

/** A queued turn: a fixed script, or a factory evaluated when the turn starts. */
export type TurnSource = TurnScript | ((context: FakeTurnContext) => TurnScript);

export interface FakeSkill {
  id: string;
  display_name: string;
  latest_version_id: string;
  versions: Map<string, Array<{ path: string; content: string }>>;
  created_at: string;
}

export interface FailRule {
  method?: string;
  /** Matches when the request path (without query) equals this string or matches this regex. */
  path?: string | RegExp;
  status: number;
  errorType?: string;
  message?: string;
  retryAfterSeconds?: number;
  /** How many matching requests fail. Default 1. */
  times?: number;
  /** Wait this long before answering. */
  delayMs?: number;
  /** After the delay, handle the request normally instead of failing it. */
  passThrough?: boolean;
}

export interface FakeManagedAgentsServerOptions {
  apiKey?: string;
  /** Split each SSE data payload across multiple `data:` lines (exercises the parser). */
  multilineData?: boolean;
  /** Send `event: ping` keep-alive frames and comment lines between events. */
  keepAlives?: boolean;
  /**
   * Buffer events emitted while no stream is open and flush them to the next stream.
   * Default false: like the real API, such events are dropped from the stream.
   */
  bufferUntilStream?: boolean;
  /** Forces the page size of `GET /v1/skills` (overrides the request's `limit`; default: `limit`, else 20). */
  skillsPageSize?: number;
}

interface FakeSession {
  id: string;
  status: "idle" | "running" | "terminated";
  agent: unknown;
  environmentId: string;
  budget: unknown;
  archivedAt: string | null;
  received: Array<Record<string, unknown>>;
  streams: Set<ServerResponse>;
  pending: string[];
  emitted: FakeEventPayload[];
  turnActive: boolean;
  interrupt: (() => void) | null;
  toolWaiters: Map<string, (result: Record<string, unknown>) => void>;
  toolResults: Map<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number; list_cost_cents: number };
  stopReason: Record<string, unknown> | null;
  metadata: Record<string, string>;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_fake${String(idCounter).padStart(6, "0")}`;
}

/** Helpers for building scripted events. */
export const fakeEvents = {
  agentMessage(text: string): FakeEventPayload {
    return { type: "agent.message", content: [{ type: "text", text }] };
  },
  agentToolUse(name: string, input: Record<string, unknown> = {}): FakeEventPayload {
    return { type: "agent.tool_use", name, input, evaluated_permission: "allow" };
  },
  agentMcpToolUse(serverName: string, name: string, input: Record<string, unknown> = {}): FakeEventPayload {
    return { type: "agent.mcp_tool_use", mcp_server_name: serverName, name, input };
  },
  running(): FakeEventPayload {
    return { type: "session.status_running" };
  },
  idle(stopReason: Record<string, unknown> & { type: string } = { type: "end_turn" }): FakeEventPayload {
    return { type: "session.status_idle", stop_reason: stopReason };
  },
  usage(input: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; listCostCents: number; activeSeconds?: number; budget?: unknown }): FakeEventPayload {
    return {
      type: "session.usage",
      usage: {
        input_tokens: input.inputTokens ?? 0,
        output_tokens: input.outputTokens ?? 0,
        cache_read_input_tokens: input.cacheReadTokens ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        list_cost: { amount: String(input.listCostCents), currency: "USD" },
        active_seconds: input.activeSeconds ?? 1,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
      budget: input.budget ?? null,
    };
  },
  error(type: string, message: string, retryStatus: "retrying" | "exhausted" | "terminal" = "terminal"): FakeEventPayload {
    return { type: "session.error", error: { type, message, retry_status: { type: retryStatus } } };
  },
};

/** A typical successful turn: running, one message, usage, idle end_turn. */
export function simpleTurn(text = "Done.", listCostCents = 1): TurnScript {
  return [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "emit", event: fakeEvents.agentMessage(text) },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 100, outputTokens: 20, listCostCents }) },
    { kind: "emit", event: fakeEvents.idle() },
  ];
}

/** A turn that stops at the session budget. */
export function budgetReachedTurn(listCostCents: number, budget?: unknown): TurnScript {
  return [
    { kind: "emit", event: fakeEvents.running() },
    { kind: "emit", event: fakeEvents.agentMessage("Working...") },
    { kind: "emit", event: fakeEvents.usage({ inputTokens: 1000, outputTokens: 200, listCostCents, budget }) },
    { kind: "emit", event: fakeEvents.idle({ type: "budget_reached" }) },
  ];
}

export class FakeManagedAgentsServer {
  readonly apiKey: string;
  readonly requests: RecordedRequest[] = [];
  private readonly options: FakeManagedAgentsServerOptions;
  private server: Server | null = null;
  private port = 0;
  private readonly agents = new Map<string, Record<string, unknown>>();
  private readonly environments = new Map<string, Record<string, unknown>>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly turnQueue: TurnSource[] = [];
  private readonly sessionTurnQueues = new Map<string, TurnSource[]>();
  private readonly skills = new Map<string, FakeSkill>();
  private readonly failRules: Array<FailRule & { remaining: number }> = [];
  private readonly turnPromises = new Set<Promise<void>>();
  private listLimit: number | null = null;
  /** When true, `user.interrupt` events are recorded but do not stop the turn. */
  ignoreInterrupts = false;
  /** Simulates an API that refuses budget changes on an existing session. */
  rejectBudgetUpdates = false;

  constructor(options: FakeManagedAgentsServerOptions = {}) {
    this.options = options;
    this.apiKey = options.apiKey ?? "sk-ant-fake-test-key-0123456789";
  }

  /** Base URL including `/v1`, for `ManagedAgentsClient({ baseUrl })`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) this.sendError(res, 500, "api_error", error instanceof Error ? error.message : String(error));
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.interrupt?.();
      for (const stream of session.streams) stream.end();
      session.streams.clear();
    }
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Queue turn scripts consumed by the next `user.message` events (any session). */
  queueTurns(...turns: TurnSource[]): void {
    this.turnQueue.push(...turns);
  }

  /** Skills uploaded to the fake (newest last). */
  listUploadedSkills(): FakeSkill[] {
    return [...this.skills.values()];
  }

  /** Adds a skill as if uploaded earlier (e.g. by another process). */
  seedSkill(input: { displayName: string; files: Array<{ path: string; content: string }> }): FakeSkill {
    const skill: FakeSkill = {
      id: nextId("skill"),
      display_name: input.displayName,
      latest_version_id: nextId("skver"),
      versions: new Map(),
      created_at: new Date().toISOString(),
    };
    skill.versions.set(skill.latest_version_id, input.files);
    this.skills.set(skill.id, skill);
    return skill;
  }

  /** Deletes a skill (as if removed in the Console); agents that reference it can no longer be written. */
  deleteSkill(skillId: string): void {
    this.skills.delete(skillId);
  }

  /** Queue turn scripts for one session (takes precedence over the global queue). */
  queueSessionTurns(sessionId: string, ...turns: TurnSource[]): void {
    const queue = this.sessionTurnQueues.get(sessionId) ?? [];
    queue.push(...turns);
    this.sessionTurnQueues.set(sessionId, queue);
  }

  failNext(rule: FailRule): void {
    this.failRules.push({ ...rule, remaining: rule.times ?? 1 });
  }

  /** Events the client sent to a session, in order. */
  receivedEvents(sessionId: string): Array<Record<string, unknown>> {
    return [...(this.sessions.get(sessionId)?.received ?? [])];
  }

  /** Events the fake emitted for a session, in order. */
  emittedEvents(sessionId: string): FakeEventPayload[] {
    return [...(this.sessions.get(sessionId)?.emitted ?? [])];
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getSessionStatus(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.status ?? null;
  }

  /** Marks an agent archived (the fake has no archive endpoint for agents). */
  archiveAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.archived_at = new Date().toISOString();
  }

  /** Replaces the metadata of an agent, environment or session (simulates resources owned by someone else). */
  setMetadata(kind: "agent" | "environment" | "session", id: string, metadata: Record<string, string>): void {
    if (kind === "session") {
      const session = this.sessions.get(id);
      if (session) session.metadata = { ...metadata };
      return;
    }
    const record = (kind === "agent" ? this.agents : this.environments).get(id);
    if (record) record.metadata = { ...metadata };
  }

  /** Ends every open stream for a session without an idle event (a dropped connection). */
  dropStreams(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const stream of session.streams) stream.destroy();
    session.streams.clear();
  }

  /** The session's current spending cap (as created or last updated). */
  sessionBudget(sessionId: string): unknown {
    return this.sessions.get(sessionId)?.budget ?? null;
  }

  /** The agent snapshot (incl. session-local tool updates) a session runs with. */
  sessionAgent(sessionId: string): Record<string, unknown> | null {
    return (this.sessions.get(sessionId)?.agent as Record<string, unknown> | undefined) ?? null;
  }

  /** Emit an ad-hoc event on a session (outside any turn script). */
  emit(sessionId: string, event: FakeEventPayload): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown fake session ${sessionId}`);
    this.emitEvent(session, event);
  }

  /** Resolves once all running turn scripts have finished. */
  async settled(): Promise<void> {
    while (this.turnPromises.size > 0) await Promise.all([...this.turnPromises]);
  }

  // ---------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const bodyBytes = await readBody(req);
    const bodyText = bodyBytes.toString("utf8");
    let body: unknown = undefined;
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.startsWith("multipart/form-data")) {
      try {
        body = await new Response(new Uint8Array(bodyBytes), { headers: { "content-type": contentType } }).formData();
      } catch {
        this.record(req, path, url.search, "[unparseable multipart]");
        this.sendError(res, 400, "invalid_request_error", "Request body is not valid multipart/form-data");
        return;
      }
    } else if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        this.record(req, path, url.search, bodyText);
        this.sendError(res, 400, "invalid_request_error", "Request body is not valid JSON");
        return;
      }
    }
    this.record(req, path, url.search, body);

    const headerProblem = this.checkHeaders(req);
    if (headerProblem) {
      this.sendError(res, headerProblem.status, headerProblem.type, headerProblem.message);
      return;
    }

    const rule = this.failRules.find((r) => r.remaining > 0 && matchesRule(r, req.method ?? "GET", path));
    if (rule) {
      rule.remaining -= 1;
      if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    }
    if (rule && !rule.passThrough) {
      const headers: Record<string, string> = {};
      if (rule.retryAfterSeconds !== undefined) headers["retry-after"] = String(rule.retryAfterSeconds);
      this.sendError(res, rule.status, rule.errorType ?? defaultErrorType(rule.status), rule.message ?? "injected failure", headers);
      return;
    }

    const method = req.method ?? "GET";
    const segments = path.replace(/^\/v1\/?/, "").split("/").filter(Boolean);
    if (!path.startsWith("/v1/")) return this.sendError(res, 404, "not_found_error", "Not found");
    const [resource, id, action, sub] = segments;

    const limit = url.searchParams.get("limit");
    this.listLimit = limit !== null && /^\d+$/.test(limit) ? Number(limit) : null;
    if (resource === "agents") return this.handleAgents(res, method, id, action, body);
    if (resource === "environments") return this.handleEnvironments(res, method, id, body);
    if (resource === "sessions") return this.handleSessions(req, res, method, id, action, sub, body);
    if (resource === "skills") return this.handleSkills(res, method, id, url.searchParams, body);
    this.sendError(res, 404, "not_found_error", "Not found");
  }

  private skillJson(skill: FakeSkill): Record<string, unknown> {
    return {
      id: skill.id,
      type: "skill",
      display_name: skill.display_name,
      latest_version_id: skill.latest_version_id,
      source: { type: "custom" },
      created_at: skill.created_at,
      updated_at: skill.created_at,
    };
  }

  private async handleSkills(res: ServerResponse, method: string, id: string | undefined, query: URLSearchParams, body: unknown): Promise<void> {
    if (!id && method === "POST") {
      if (!(body instanceof FormData)) return this.sendError(res, 400, "invalid_request_error", "multipart/form-data body is required");
      const entries = body.getAll("files[]");
      const files: Array<{ path: string; content: string }> = [];
      for (const entry of entries) {
        if (typeof entry === "string") return this.sendError(res, 400, "invalid_request_error", "files[] entries must be files");
        files.push({ path: entry.name, content: await entry.text() });
      }
      if (files.length === 0) return this.sendError(res, 400, "invalid_request_error", "files: at least one file is required");
      const roots = new Set(files.map((f) => f.path.split("/")[0]));
      if (roots.size !== 1 || files.some((f) => !f.path.includes("/"))) {
        return this.sendError(res, 400, "invalid_request_error", "All files must be in the same top-level directory");
      }
      const root = [...roots][0]!;
      const skillMd = files.find((f) => f.path === `${root}/SKILL.md`);
      if (!skillMd) return this.sendError(res, 400, "invalid_request_error", "SKILL.md is required at the root of the top-level directory");
      const name = /^---\s*\n[\s\S]*?^name:\s*(.+?)\s*$/m.exec(skillMd.content)?.[1]?.replace(/^["']|["']$/g, "");
      if (!name || !/^[a-z0-9-]{1,64}$/.test(name) || /anthropic|claude/.test(name)) {
        return this.sendError(res, 400, "invalid_request_error", "SKILL.md frontmatter name must be lowercase letters, numbers and hyphens (max 64), without reserved words");
      }
      const displayName = body.get("display_name");
      const skill = this.seedSkill({ displayName: typeof displayName === "string" && displayName ? displayName : name, files });
      return this.sendJson(res, 200, this.skillJson(skill));
    }
    if (!id && method === "GET") {
      const all = [...this.skills.values()].reverse();
      const pageSize = this.options.skillsPageSize ?? this.listLimit ?? 20;
      const start = Number(query.get("page") ?? "0") || 0;
      const data = all.slice(start, start + pageSize).map((skill) => this.skillJson(skill));
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return this.sendJson(res, 200, { data, next_page: next });
    }
    const skill = id ? this.skills.get(id) : undefined;
    if (!skill) return this.sendError(res, 404, "not_found_error", "Skill not found");
    if (method === "GET") return this.sendJson(res, 200, this.skillJson(skill));
    this.sendError(res, 404, "not_found_error", "Not found");
  }

  /** Files of the custom skills an agent snapshot attaches (pinned version or latest). */
  private attachedSkillFiles(agent: Record<string, unknown>): Map<string, Array<{ path: string; content: string }>> {
    const out = new Map<string, Array<{ path: string; content: string }>>();
    const refs = Array.isArray(agent.skills) ? agent.skills : [];
    for (const raw of refs) {
      const ref = asRecord(raw);
      if (ref.type !== "custom" || typeof ref.skill_id !== "string") continue;
      const skill = this.skills.get(ref.skill_id);
      if (!skill) continue;
      const version = typeof ref.version === "string" && ref.version !== "latest" ? ref.version : skill.latest_version_id;
      const files = skill.versions.get(version);
      if (files) out.set(skill.id, files);
    }
    return out;
  }

  /** Error message when an agent body references a custom skill (or version) the fake does not have. */
  private missingSkillProblem(params: Record<string, unknown>): string | null {
    const refs = Array.isArray(params.skills) ? params.skills : [];
    for (const raw of refs) {
      const ref = asRecord(raw);
      if (ref.type !== "custom") continue;
      const skill = typeof ref.skill_id === "string" ? this.skills.get(ref.skill_id) : undefined;
      if (!skill) return `skills: skill ${String(ref.skill_id)} not found`;
      if (typeof ref.version === "string" && ref.version !== "latest" && !skill.versions.has(ref.version)) {
        return `skills: version ${ref.version} of skill ${skill.id} not found`;
      }
    }
    return null;
  }

  private handleAgents(res: ServerResponse, method: string, id: string | undefined, action: string | undefined, body: unknown): void {
    const now = new Date().toISOString();
    if (method === "POST" && !action) {
      // API ASSUMPTION (fake): unknown skill references are a 404 naming the skill.
      const problem = this.missingSkillProblem(asRecord(body));
      if (problem) return this.sendError(res, 404, "not_found_error", problem);
    }
    if (!id && method === "POST") {
      const params = asRecord(body);
      if (typeof params.name !== "string" || !params.model) {
        return this.sendError(res, 400, "invalid_request_error", "name and model are required");
      }
      const agent = {
        id: nextId("agent"),
        type: "agent",
        version: 1,
        name: params.name,
        model: typeof params.model === "string" ? { id: params.model } : params.model,
        system: params.system ?? null,
        description: params.description ?? null,
        tools: params.tools ?? [],
        mcp_servers: params.mcp_servers ?? [],
        skills: params.skills ?? [],
        metadata: params.metadata ?? {},
        archived_at: null,
        created_at: now,
        updated_at: now,
      };
      this.agents.set(agent.id, agent);
      return this.sendJson(res, 200, agent);
    }
    if (!id && method === "GET") {
      const data = [...this.agents.values()].reverse();
      return this.sendJson(res, 200, { data: data.slice(0, this.listLimit ?? data.length), next_page: null });
    }
    const agent = id ? this.agents.get(id) : undefined;
    if (!agent) return this.sendError(res, 404, "not_found_error", "Agent not found");
    if (!action && method === "GET") return this.sendJson(res, 200, agent);
    if (!action && method === "POST") {
      const params = asRecord(body);
      if (typeof params.version === "number" && params.version !== agent.version) {
        return this.sendError(res, 409, "conflict_error", "Agent version does not match");
      }
      const { version: _ignored, ...changes } = params;
      const model = changes.model === undefined ? agent.model : typeof changes.model === "string" ? { id: changes.model } : changes.model;
      Object.assign(agent, changes, { model, version: Number(agent.version) + 1, updated_at: now });
      return this.sendJson(res, 200, agent);
    }
    this.sendError(res, 404, "not_found_error", "Not found");
  }

  private handleEnvironments(res: ServerResponse, method: string, id: string | undefined, body: unknown): void {
    const now = new Date().toISOString();
    if (!id && method === "POST") {
      const params = asRecord(body);
      if (typeof params.name !== "string") return this.sendError(res, 400, "invalid_request_error", "name is required");
      const env = {
        id: nextId("env"),
        type: "environment",
        name: params.name,
        description: params.description ?? null,
        config: params.config ?? { type: "cloud", networking: { type: "unrestricted" } },
        metadata: params.metadata ?? {},
        archived_at: null,
        created_at: now,
        updated_at: now,
      };
      this.environments.set(env.id, env);
      return this.sendJson(res, 200, env);
    }
    if (!id && method === "GET") {
      const data = [...this.environments.values()].reverse();
      return this.sendJson(res, 200, { data: data.slice(0, this.listLimit ?? data.length), next_page: null });
    }
    const env = id ? this.environments.get(id) : undefined;
    if (!env) return this.sendError(res, 404, "not_found_error", "Environment not found");
    if (method === "GET") return this.sendJson(res, 200, env);
    this.sendError(res, 404, "not_found_error", "Not found");
  }

  private handleSessions(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    id: string | undefined,
    action: string | undefined,
    sub: string | undefined,
    body: unknown,
  ): void {
    if (!id && method === "POST") {
      const params = asRecord(body);
      const agentRef = params.agent;
      const agentId = typeof agentRef === "string" ? agentRef : asRecord(agentRef).id;
      if (typeof agentId !== "string" || !this.agents.has(agentId)) {
        return this.sendError(res, 404, "not_found_error", "Agent not found");
      }
      if (typeof params.environment_id !== "string" || !this.environments.has(params.environment_id)) {
        return this.sendError(res, 404, "not_found_error", "Environment not found");
      }
      const budget = params.budget ?? null;
      if (budget !== null) {
        const amount = asRecord(asRecord(budget).max_list_cost).amount;
        if (asRecord(budget).type !== "limit" || typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) {
          return this.sendError(res, 400, "invalid_request_error", "budget.max_list_cost.amount must be a positive whole number of cents");
        }
      }
      const session: FakeSession = {
        id: nextId("sesn"),
        status: "idle",
        agent: structuredClone(this.agents.get(agentId)),
        environmentId: params.environment_id,
        budget,
        archivedAt: null,
        received: [],
        streams: new Set(),
        pending: [],
        emitted: [],
        turnActive: false,
        interrupt: null,
        toolWaiters: new Map(),
        toolResults: new Map(),
        usage: { input_tokens: 0, output_tokens: 0, list_cost_cents: 0 },
        stopReason: null,
        metadata: { ...((params.metadata as Record<string, string> | undefined) ?? {}) },
      };
      this.sessions.set(session.id, session);
      return this.sendJson(res, 200, this.sessionJson(session));
    }
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return this.sendError(res, 404, "not_found_error", "Session not found");

    if (!action && method === "GET") return this.sendJson(res, 200, this.sessionJson(session));
    if (!action && method === "POST") {
      if (session.status !== "idle") return this.sendError(res, 400, "invalid_request_error", "Session must be idle to update the agent");
      const update = asRecord(asRecord(body).agent);
      if (Array.isArray(update.tools)) (session.agent as Record<string, unknown>).tools = update.tools;
      if (this.rejectBudgetUpdates && asRecord(body).budget !== undefined) {
        return this.sendError(res, 400, "invalid_request_error", "budget cannot be updated");
      }
      if (asRecord(body).budget !== undefined) session.budget = asRecord(body).budget;
      return this.sendJson(res, 200, this.sessionJson(session));
    }
    if (action === "archive" && method === "POST") {
      session.interrupt?.();
      session.status = "terminated";
      session.archivedAt = new Date().toISOString();
      this.emitEvent(session, { type: "session.status_terminated" });
      for (const stream of session.streams) stream.end();
      session.streams.clear();
      return this.sendJson(res, 200, this.sessionJson(session));
    }
    if (action === "events" && sub === "stream" && method === "GET") return this.openStream(req, res, session);
    if (action === "events" && !sub && method === "POST") return this.receiveEvents(res, session, body);
    this.sendError(res, 404, "not_found_error", "Not found");
  }

  private receiveEvents(res: ServerResponse, session: FakeSession, body: unknown): void {
    if (session.status === "terminated") return this.sendError(res, 400, "invalid_request_error", "Session is terminated");
    const events = asRecord(body).events;
    if (!Array.isArray(events) || events.length === 0) {
      return this.sendError(res, 400, "invalid_request_error", "events must be a non-empty array");
    }
    for (const raw of events) {
      const event = asRecord(raw);
      if (typeof event.type !== "string") return this.sendError(res, 400, "invalid_request_error", "event.type is required");
      if (event.type === "user.custom_tool_result" && typeof event.custom_tool_use_id !== "string") {
        return this.sendError(res, 400, "invalid_request_error", "custom_tool_use_id is required");
      }
    }
    const accepted: Array<Record<string, unknown>> = [];
    for (const raw of events) {
      const event: Record<string, unknown> = { ...asRecord(raw), id: nextId("sevt"), processed_at: new Date().toISOString() };
      session.received.push(event);
      accepted.push(event);
      switch (event.type) {
        case "user.message":
          this.startTurn(session);
          break;
        case "user.interrupt":
          if (!this.ignoreInterrupts) session.interrupt?.();
          break;
        case "user.custom_tool_result": {
          const toolId = String(event.custom_tool_use_id);
          session.toolResults.set(toolId, event);
          const waiter = session.toolWaiters.get(toolId);
          if (waiter) {
            session.toolWaiters.delete(toolId);
            waiter(event);
          }
          break;
        }
        default:
          break;
      }
    }
    this.sendJson(res, 200, { data: accepted });
  }

  private startTurn(session: FakeSession): void {
    const queue = this.sessionTurnQueues.get(session.id);
    const source = queue?.shift() ?? this.turnQueue.shift() ?? simpleTurn();
    const script = typeof source === "function"
      ? source({
          sessionId: session.id,
          agent: session.agent as Record<string, unknown>,
          attachedSkillFiles: this.attachedSkillFiles(session.agent as Record<string, unknown>),
          userText: lastUserText(session),
        })
      : source;
    // Queue behind any running turn so ordering stays deterministic.
    const run = this.runTurn(session, script);
    this.turnPromises.add(run);
    void run.finally(() => this.turnPromises.delete(run));
  }

  private async runTurn(session: FakeSession, script: TurnScript): Promise<void> {
    while (session.turnActive) await new Promise((r) => setTimeout(r, 5));
    session.turnActive = true;
    session.status = "running";
    let interrupted = false;
    const interruptWaiters = new Set<() => void>();
    session.interrupt = () => {
      interrupted = true;
      for (const wake of interruptWaiters) wake();
    };
    const waitOrInterrupt = <T>(promise: Promise<T>): Promise<T | null> =>
      new Promise((resolve) => {
        const wake = () => resolve(null);
        interruptWaiters.add(wake);
        void promise.then((value) => {
          interruptWaiters.delete(wake);
          resolve(value);
        });
      });
    try {
      for (const step of script) {
        if (interrupted) break;
        await new Promise((r) => setImmediate(r));
        if (interrupted) break;
        if (step.kind === "emit") {
          this.emitEvent(session, step.event);
          if (step.event.type === "session.status_idle") {
            session.status = "idle";
            session.stopReason = asRecord(step.event.stop_reason);
          }
          if (step.event.type === "session.status_running") session.status = "running";
        } else if (step.kind === "delay") {
          await waitOrInterrupt(new Promise((r) => setTimeout(r, step.ms)));
        } else if (step.kind === "hang") {
          await waitOrInterrupt(new Promise<void>(() => undefined));
        } else if (step.kind === "custom_tool_call") {
          const toolId = step.id ?? nextId("sevt");
          this.emitEvent(session, { type: "agent.custom_tool_use", id: toolId, name: step.name, input: step.input ?? {} });
          const result = new Promise<Record<string, unknown>>((resolve) => {
            const early = session.toolResults.get(toolId);
            if (early) resolve(early);
            else session.toolWaiters.set(toolId, resolve);
          });
          if (step.emitRequiresAction !== false) {
            this.emitEvent(session, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [toolId] } });
            session.status = "idle";
            session.stopReason = { type: "requires_action", event_ids: [toolId] };
          }
          const answered = await waitOrInterrupt(result);
          session.toolWaiters.delete(toolId);
          if (!answered) break;
          session.status = "running";
          this.emitEvent(session, { type: "session.status_running" });
        }
      }
      if (interrupted) {
        this.emitEvent(session, fakeEvents.usage({
          inputTokens: session.usage.input_tokens,
          outputTokens: session.usage.output_tokens,
          listCostCents: session.usage.list_cost_cents,
          budget: session.budget,
        }));
        this.emitEvent(session, fakeEvents.idle({ type: "end_turn" }));
        session.stopReason = { type: "end_turn" };
      }
    } finally {
      if ((session.status as FakeSession["status"]) !== "terminated") session.status = "idle";
      session.interrupt = null;
      session.turnActive = false;
    }
  }

  private emitEvent(session: FakeSession, input: FakeEventPayload): void {
    const event: FakeEventPayload = {
      ...input,
      id: typeof input.id === "string" ? input.id : nextId("sevt"),
      processed_at: new Date().toISOString(),
    };
    if (event.type === "session.usage") {
      const usage = asRecord(event.usage);
      session.usage = {
        input_tokens: Number(usage.input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
        list_cost_cents: Number(asRecord(usage.list_cost).amount ?? 0),
      };
    }
    session.emitted.push(event);
    const frame = this.formatFrame(event);
    if (session.streams.size === 0) {
      if (this.options.bufferUntilStream) session.pending.push(frame);
      return;
    }
    for (const stream of session.streams) stream.write(frame);
  }

  private formatFrame(event: FakeEventPayload): string {
    let frame = "";
    if (this.options.keepAlives) frame += ": keep-alive\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n";
    frame += `event: ${event.type}\n`;
    if (this.options.multilineData) {
      // Pretty-printed JSON only has newlines between tokens, so it survives the line split.
      frame += JSON.stringify(event, null, 2).split("\n").map((line) => `data: ${line}`).join("\n");
      frame += "\n";
    } else {
      frame += `data: ${JSON.stringify(event)}\n`;
    }
    return `${frame}\n`;
  }

  private openStream(req: IncomingMessage, res: ServerResponse, session: FakeSession): void {
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("text/event-stream")) {
      return this.sendError(res, 400, "invalid_request_error", "accept: text/event-stream is required");
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    session.streams.add(res);
    for (const frame of session.pending.splice(0)) res.write(frame);
    if (session.status === "terminated") {
      session.streams.delete(res);
      res.end();
      return;
    }
    req.on("close", () => session.streams.delete(res));
  }

  private sessionJson(session: FakeSession): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      id: session.id,
      type: "session",
      status: session.status,
      agent: session.agent,
      environment_id: session.environmentId,
      budget: session.budget,
      archived_at: session.archivedAt,
      // API ASSUMPTION (adapter): the session object exposes the last idle stop_reason.
      stop_reason: session.status === "idle" ? session.stopReason : null,
      created_at: now,
      updated_at: now,
      metadata: { ...session.metadata },
      usage: {
        input_tokens: session.usage.input_tokens,
        output_tokens: session.usage.output_tokens,
        list_cost: { amount: String(session.usage.list_cost_cents), currency: "USD" },
      },
    };
  }

  private checkHeaders(req: IncomingMessage): { status: number; type: string; message: string } | null {
    const key = req.headers["x-api-key"];
    if (key !== this.apiKey) return { status: 401, type: "authentication_error", message: "invalid x-api-key" };
    if (req.headers["anthropic-version"] !== ANTHROPIC_VERSION) {
      return { status: 400, type: "invalid_request_error", message: "anthropic-version header is required" };
    }
    const beta = String(req.headers["anthropic-beta"] ?? "").split(",").map((v) => v.trim());
    if (!beta.includes(MANAGED_AGENTS_BETA)) {
      return { status: 400, type: "invalid_request_error", message: `anthropic-beta must include ${MANAGED_AGENTS_BETA}` };
    }
    return null;
  }

  private record(req: IncomingMessage, path: string, query: string, body: unknown): void {
    const headers = { ...req.headers };
    const hasValidKey = headers["x-api-key"] === this.apiKey;
    if (headers["x-api-key"] !== undefined) headers["x-api-key"] = "[redacted]";
    this.requests.push({ method: req.method ?? "GET", path, query, headers, hasValidKey, body });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", "request-id": nextId("req"), ...headers });
    res.end(JSON.stringify({ type: "error", error: { type, message }, request_id: nextId("req") }));
  }
}

export async function startFakeManagedAgentsServer(options: FakeManagedAgentsServerOptions = {}): Promise<FakeManagedAgentsServer> {
  return new FakeManagedAgentsServer(options).start();
}

function matchesRule(rule: FailRule, method: string, path: string): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  if (rule.path === undefined) return true;
  return typeof rule.path === "string" ? rule.path === path : rule.path.test(path);
}

function defaultErrorType(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  if (status === 404) return "not_found_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  return "invalid_request_error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function lastUserText(session: FakeSession): string {
  const message = [...session.received].reverse().find((event) => event.type === "user.message");
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((block) => (typeof asRecord(block).text === "string" ? String(asRecord(block).text) : "")).join("\n");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

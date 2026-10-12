import {
  decodeManagedAgentsEvent,
  readSseFrames,
  SSE_KEEPALIVE_EVENTS,
  sseErrorFromFrame,
} from "./sse.js";
import {
  ANTHROPIC_VERSION,
  DEFAULT_MANAGED_AGENTS_BASE_URL,
  MANAGED_AGENTS_BETA,
  type BudgetLimit,
  type CreateAgentParams,
  type CreateEnvironmentParams,
  type CreateSessionParams,
  type ManagedAgent,
  type ManagedAgentsEvent,
  type ManagedEnvironment,
  type ManagedSession,
  type UpdateAgentParams,
  type UserEventParams,
} from "./types.js";

export * from "./types.js";
export { listCostToUsd, normalizeSessionUsage } from "./sse.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ManagedAgentsClientOptions {
  apiKey: string;
  /** Defaults to https://api.anthropic.com/v1. Must include the `/v1` prefix. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Retries for non-streaming calls on 429/5xx. Default 3. */
  maxRetries?: number;
  /** First backoff delay; doubles each attempt (with jitter). Default 500ms. */
  retryBaseDelayMs?: number;
  /** Upper bound for a single backoff delay, including Retry-After. Default 30s. */
  retryMaxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

/**
 * Error thrown for any failed Managed Agents call. The message never contains the
 * API key (it is redacted defensively in case a server echoes it).
 */
export class ManagedAgentsApiError extends Error {
  readonly status: number;
  /** Anthropic error type, e.g. `invalid_request_error`, `rate_limit_error`, `connection_error`. */
  readonly errorType: string;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(input: { message: string; status: number; errorType: string; requestId?: string | null; retryable?: boolean }) {
    super(input.message);
    this.name = "ManagedAgentsApiError";
    this.status = input.status;
    this.errorType = input.errorType;
    this.requestId = input.requestId ?? null;
    this.retryable = input.retryable ?? false;
  }
}

/**
 * API ASSUMPTION: error responses use the standard Anthropic API envelope
 * `{"type":"error","error":{"type":"...","message":"..."},"request_id":"..."}`.
 * The Managed Agents docs list status codes but do not show the body.
 */
export function parseApiErrorBody(text: string): { type: string | null; message: string | null; requestId: string | null } {
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
      return {
        type: typeof error?.type === "string" ? error.type : null,
        message: typeof error?.message === "string" ? error.message : null,
        requestId: typeof record.request_id === "string" ? record.request_id : null,
      };
    }
  } catch {
    // not JSON
  }
  return { type: null, message: null, requestId: null };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Converts a dollar amount to a session budget (whole cents, rounded down, min 1 cent). */
export function budgetFromUsd(usd: number): BudgetLimit | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const cents = Math.max(1, Math.floor(usd * 100 + 1e-9));
  return { type: "limit", max_list_cost: { amount: String(cents), currency: "USD" } };
}

export class ManagedAgentsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ManagedAgentsClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error("ManagedAgentsClient requires an API key");
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_MANAGED_AGENTS_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 500);
    this.retryMaxDelayMs = Math.max(0, options.retryMaxDelayMs ?? 30_000);
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ---- Agents -------------------------------------------------------------

  createAgent(params: CreateAgentParams, options?: RequestOptions): Promise<ManagedAgent> {
    return this.request("POST", "/agents", params, options);
  }

  getAgent(agentId: string, options?: RequestOptions): Promise<ManagedAgent> {
    return this.request("GET", `/agents/${enc(agentId)}`, undefined, options);
  }

  /** Updating an agent creates a new agent version (POST /v1/agents/{id}). */
  updateAgent(agentId: string, params: UpdateAgentParams, options?: RequestOptions): Promise<ManagedAgent> {
    return this.request("POST", `/agents/${enc(agentId)}`, params, options);
  }

  // ---- Environments ------------------------------------------------------

  createEnvironment(params: CreateEnvironmentParams, options?: RequestOptions): Promise<ManagedEnvironment> {
    return this.request("POST", "/environments", params, options);
  }

  getEnvironment(environmentId: string, options?: RequestOptions): Promise<ManagedEnvironment> {
    return this.request("GET", `/environments/${enc(environmentId)}`, undefined, options);
  }

  // ---- Sessions ------------------------------------------------------------

  createSession(params: CreateSessionParams, options?: RequestOptions): Promise<ManagedSession> {
    return this.request("POST", "/sessions", params, options);
  }

  getSession(sessionId: string, options?: RequestOptions): Promise<ManagedSession> {
    return this.request("GET", `/sessions/${enc(sessionId)}`, undefined, options);
  }

  archiveSession(sessionId: string, options?: RequestOptions): Promise<ManagedSession> {
    return this.request("POST", `/sessions/${enc(sessionId)}/archive`, undefined, options);
  }

  sendEvents(sessionId: string, events: UserEventParams[], options?: RequestOptions): Promise<unknown> {
    return this.request("POST", `/sessions/${enc(sessionId)}/events`, { events }, options);
  }

  /**
   * Opens the session's SSE stream and yields typed events until the server closes
   * the stream or `signal` aborts (abort ends iteration without throwing). The stream
   * only carries events emitted after it opens, so open it before sending events.
   * No retries and no reconnect: callers reconcile via the events list if needed.
   */
  async *streamEvents(sessionId: string, options: StreamOptions = {}): AsyncGenerator<ManagedAgentsEvent> {
    const { signal } = options;
    const path = `/sessions/${enc(sessionId)}/events/stream`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: "GET",
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      throw this.connectionError("GET", path, error);
    }
    if (!response.ok) throw await this.httpError("GET", path, response);
    if (!response.body) return;
    try {
      for await (const frame of readSseFrames(response.body)) {
        if (frame.event && SSE_KEEPALIVE_EVENTS.has(frame.event)) continue;
        const streamError = sseErrorFromFrame(frame);
        if (streamError) {
          throw new ManagedAgentsApiError({
            message: this.redact(`Managed Agents event stream error (${streamError.type}): ${streamError.message}`),
            status: 0,
            errorType: streamError.type,
          });
        }
        if (!frame.data.trim()) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          throw new ManagedAgentsApiError({
            message: "Managed Agents event stream sent a non-JSON data frame",
            status: 0,
            errorType: "invalid_stream_payload",
          });
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        yield decodeManagedAgentsEvent(payload as Record<string, unknown>, frame.event);
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ManagedAgentsApiError) throw error;
      throw this.connectionError("GET", path, error);
    }
  }

  // ---- Internals -----------------------------------------------------------

  private url(path: string): string {
    // `beta=true` mirrors the official SDK's request paths for beta endpoints.
    return `${this.baseUrl}${path}?beta=true`;
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": MANAGED_AGENTS_BETA,
    };
  }

  private async request<T>(method: "GET" | "POST", path: string, body: unknown, options?: RequestOptions): Promise<T> {
    const signal = options?.signal;
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path), {
          method,
          headers: {
            ...this.headers(),
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Connection failures are retried only for reads: a POST may have been applied.
        if (method === "GET" && attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt, null), signal);
          attempt += 1;
          continue;
        }
        throw this.connectionError(method, path, error);
      }
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(this.backoffMs(attempt, retryAfter), signal);
        attempt += 1;
        continue;
      }
      throw await this.httpError(method, path, response);
    }
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, this.retryMaxDelayMs);
    }
    const base = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = base * 0.25 * Math.random();
    return Math.min(base + jitter, this.retryMaxDelayMs);
  }

  private async httpError(method: string, path: string, response: Response): Promise<ManagedAgentsApiError> {
    const text = await response.text().catch(() => "");
    const parsed = parseApiErrorBody(text);
    const errorType = parsed.type ?? `http_${response.status}`;
    const detail = parsed.message ?? (response.statusText || "request failed");
    return new ManagedAgentsApiError({
      message: this.redact(`Managed Agents API ${method} ${path} failed (${response.status} ${errorType}): ${detail}`),
      status: response.status,
      errorType,
      requestId: parsed.requestId ?? response.headers.get("request-id"),
      retryable: isRetryableStatus(response.status),
    });
  }

  private connectionError(method: string, path: string, error: unknown): ManagedAgentsApiError {
    const detail = error instanceof Error ? error.message : String(error);
    return new ManagedAgentsApiError({
      message: this.redact(`Managed Agents API ${method} ${path} connection failed: ${detail}`),
      status: 0,
      errorType: "connection_error",
      retryable: true,
    });
  }

  private redact(message: string): string {
    return message.split(this.apiKey).join("[redacted]");
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

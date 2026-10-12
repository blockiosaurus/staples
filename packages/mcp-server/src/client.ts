import type { PaperclipMcpConfig } from "./config.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

/**
 * Sends one already-validated API request somewhere other than `fetch` (a server
 * hosting these tools dispatches in-process). `path` is relative to the API base,
 * starts with "/", and includes the query string.
 */
export type PaperclipApiTransport = (request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}) => Promise<{ status: number; body: unknown }>;

/**
 * Resolves `path` against the API base and refuses anything that would leave it:
 * another origin (`/https://host`, `/\\host`, `//host`) or a path outside the base
 * path (dot segments, encoded or not). Runs before any request is sent.
 */
export function resolveApiRequestUrl(apiUrl: string, path: string): { url: URL; relativePath: string } {
  if (!path.startsWith("/")) {
    throw new Error(`API path must start with "/": ${path}`);
  }
  if (path.startsWith("//") || path.includes("\\") || path.includes("://") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("API path must be a path under the Paperclip API, not a URL");
  }
  const base = new URL(`${apiUrl.replace(/\/+$/, "")}/`);
  const url = new URL(path.slice(1), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) {
    throw new Error("API path must stay under the Paperclip API base URL");
  }
  return { url, relativePath: `/${url.pathname.slice(base.pathname.length)}${url.search}` };
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class PaperclipApiClient {
  constructor(
    private readonly config: PaperclipMcpConfig,
    private readonly transport?: PaperclipApiTransport,
  ) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    const { url, relativePath } = resolveApiRequestUrl(this.config.apiUrl, path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }

    let status: number;
    let parsedBody: unknown;
    if (this.transport) {
      ({ status, body: parsedBody } = await this.transport({ method: method.toUpperCase(), path: relativePath, headers, body: options.body }));
    } else {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      status = response.status;
      parsedBody = await parseResponseBody(response);
    }

    if (status < 200 || status >= 300) {
      throw new PaperclipApiError({
        status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, status, parsedBody),
      });
    }

    return parsedBody as T;
  }
}

# Staples Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five quick wins from the UX review (`doc/plans/2026-10-14-ux-production-readiness-review.md`): the Assistant never runs without its tools, the weekly update reads as written, the sidebar stops showing seven "new" badges at once, Skills stops leaking filesystem paths and hides until needed, and the interview opens in the language of someone starting a business.

**Architecture:** Server and adapter guards for item 1 (a required tools server fails the run instead of being skipped, and hosted runs reach this instance over loopback). Pure-function changes for the excerpt and the surface resolver. Copy and instruction changes for the opening and the interview, with the Assistant stock version bumped.

**Tech Stack:** TypeScript, React 19, Express, Vitest. Monorepo with pnpm. Run single test files with `pnpm --filter <pkg> exec vitest run <file>`.

## Global Constraints

- Generic product: no company-specific content, no secrets. Never read `.env.local` or any key. Never commit `.claude/launch.json`.
- Person-facing copy is plain language. Banned in default views and in anything the Assistant says to a person: adapter, harness, runtime, session, heartbeat, MCP, API, tool names, JSON.
- Token-only UI (`DESIGN.md`): no hex, raw px, or arbitrary Tailwind values in `ui/src/components/**` or `ui/src/pages/**`. Run `pnpm check:token-gates` after any UI change.
- Keep contracts synced across db/shared/server/ui when a type changes.
- Bump the Assistant `stockVersion` in `server/src/services/built-in-agents.ts:393` (currently `"2026-10-14a"`) when its `AGENTS.md` or a bundled skill changes. One bump for this whole plan: `"2026-10-14b"`.
- No single command longer than 4 minutes (`timeout 240`). Run single test files, `-t` while iterating.
- Commit after each task with explicit `git add` paths and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work on branch `staples/quick-wins` (created from `master` by the controller).

## Background for Task 1 (read before touching it)

On 2026-10-14 a fresh company's first Assistant run answered with "The card tool and the company tools aren't available to me in this session, and nothing here connects to the Staples API" and dumped eight questions as plain text. The run log (`GET /api/heartbeat-runs/<id>/log`) showed:

```
[staples] Skipping tools from "Staples assistant": MCP server "Staples assistant" rejected the run token (HTTP 401)
[staples] Skipping tools from "Paperclip connections": MCP server "Paperclip connections" rejected the run token (HTTP 403)
[staples] Skipping tools from "paperclip": MCP server "paperclip" rejected the run token (HTTP 401)
```

Cause: the dev server's `PAPERCLIP_API_URL` was derived from a `PAPERCLIP_PUBLIC_URL` that points at a different instance, so the host-side tools proxy (`packages/adapters/claude-managed/src/server/tools-proxy.ts`) called another server with a token minted here. Two product defects made this a silent failure instead of a clear error:

1. `ToolsProxy.discover` skips any server whose tool list fails and carries on. The Assistant then has no tools and improvises.
2. For `claude_managed`, the tools proxy runs inside this server process, so it never needs the public URL. It should call this instance over loopback.

---

### Task 1: A required tools server fails the run instead of being skipped

**Files:**
- Modify: `packages/adapter-utils/src/types.ts:195-200` (`AdapterRuntimeMcpServer`)
- Modify: `packages/adapters/claude-managed/src/server/tools-proxy.ts:32-37` (`RuntimeMcpServerInput`), `:342-357` (`discover`)
- Modify: `server/src/services/heartbeat/assistant-mcp-server.ts:27-32`
- Test: `packages/adapters/claude-managed/src/server/tools-proxy.test.ts`
- Test: `packages/adapters/claude-managed/src/server/execute.test.ts`
- Test: `server/src/services/heartbeat/assistant-mcp-server.test.ts` (create if absent; check `ls server/src/services/heartbeat/*.test.ts` first)

**Interfaces:**
- Produces: `AdapterRuntimeMcpServer.required?: boolean` and `RuntimeMcpServerInput.required?: boolean`.
- Produces: `export class RequiredToolServerError extends Error { serverName: string; detail: string }` in `tools-proxy.ts`.
- `assistantRuntimeMcpServer(...)` now returns `{ ..., required: true }`.

- [ ] **Step 1: Read the existing discover test shape**

Run: `sed -n 1,80p packages/adapters/claude-managed/src/server/tools-proxy.test.ts`
Note how a fake MCP server is started and how a wrong token produces a 401 (`startFakeMcpServer({ token })` in `packages/adapters/claude-managed/src/testing/` or the test file's helpers).

- [ ] **Step 2: Write the failing proxy tests**

Add to `tools-proxy.test.ts` (adapt helper names to what Step 1 found):

```ts
it("skips an optional server that rejects the run token, with a warning", async () => {
  const mcp = await startFakeMcpServer({ token: "right", tools: [] });
  const warnings: string[] = [];
  const proxy = await ToolsProxy.discover(
    [{ name: "Other tools", url: mcp.url, token: "wrong", connectionId: "c1" }],
    { onWarning: (m) => { warnings.push(m); } },
  );
  expect(proxy.tools()).toEqual([]);
  expect(warnings[0]).toMatch(/Skipping tools from "Other tools".*HTTP 401/);
});

it("fails discovery when a required server rejects the run token", async () => {
  const mcp = await startFakeMcpServer({ token: "right", tools: [] });
  await expect(ToolsProxy.discover(
    [{ name: "Staples assistant", url: mcp.url, token: "wrong", connectionId: "staples-assistant-tools", required: true }],
  )).rejects.toMatchObject({ name: "RequiredToolServerError", serverName: "Staples assistant" });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd packages/adapters/claude-managed && timeout 240 pnpm exec vitest run src/server/tools-proxy.test.ts -t "required server"`
Expected: FAIL (`required` is not a known field; discovery resolves instead of rejecting).

- [ ] **Step 4: Add the field to both input types**

`packages/adapter-utils/src/types.ts`:

```ts
export interface AdapterRuntimeMcpServer {
  name: string;
  url: string;
  token: string;
  connectionId: string;
  /** The run must not start without this server's tools: discovery failure fails the run. */
  required?: boolean;
}
```

`tools-proxy.ts`:

```ts
export interface RuntimeMcpServerInput {
  name: string;
  url: string;
  token: string;
  connectionId?: string;
  /** Discovery failure for this server fails the run instead of skipping it. */
  required?: boolean;
}

export class RequiredToolServerError extends Error {
  readonly name = "RequiredToolServerError";
  constructor(readonly serverName: string, readonly detail: string) {
    super(`${serverName} tools could not be reached (${detail})`);
  }
}
```

In `discover`, change the catch block:

```ts
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const detail = connection.redact(error instanceof Error ? error.message : String(error));
        if (server.required) throw new RequiredToolServerError(server.name, detail);
        await options.onWarning?.(`Skipping tools from "${server.name}": ${detail}`);
        continue;
      }
```

Export `RequiredToolServerError` from the adapter's server index if `tools-proxy.ts` exports are re-exported there (check `packages/adapters/claude-managed/src/server/index.ts`).

- [ ] **Step 5: Run the proxy tests**

Run: `cd packages/adapters/claude-managed && timeout 240 pnpm exec vitest run src/server/tools-proxy.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing execute test**

In `execute.test.ts`, after the test at line 242 ("gives a read-only Staples API tool set…"), add:

```ts
  it("fails the run before any model call when a required tool server rejects the run token", async () => {
    mcp = await startFakeMcpServer({ token: "a-different-token", tools: [] });
    fake.queueTurns(turn("one", 1));
    const result = await execute(harness({
      servers: [{ name: "Staples assistant", url: mcp.url, token: RUN_TOKEN, connectionId: "staples-assistant-tools", required: true }],
    }).ctx);
    expect(result.errorCode).toBe("claude_managed_tools_failed");
    expect(result.errorMessage).toMatch(/Staples assistant tools could not be reached/);
    expect(requestsMatching("POST", /^\/v1\/agents$/)).toHaveLength(0);
  });
```

`harness()` at `execute.test.ts:66-70` types `servers` as `Array<{ name; url; token; connectionId }>`: add `required?: boolean` to that type. `startFakeMcpServer` is imported at the top of `execute.test.ts`; reuse the same import in `tools-proxy.test.ts` if it is not already there.

- [ ] **Step 7: Run it**

Run: `cd packages/adapters/claude-managed && timeout 240 pnpm exec vitest run src/server/execute.test.ts -t "required tool server"`
Expected: PASS already (the existing catch at `execute.ts:614-629` returns `claude_managed_tools_failed` for any thrown error). If it fails because `errorMessage` reads `Could not load tools: …`, that prefix is acceptable: loosen the regex to `/Staples assistant tools could not be reached/` which still matches.

- [ ] **Step 8: Mark the Assistant server required**

`server/src/services/heartbeat/assistant-mcp-server.ts`:

```ts
  return {
    name: "Staples assistant",
    url: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/mcp/assistant-tools`,
    token: input.authToken,
    connectionId: ASSISTANT_TOOLS_CONNECTION_ID,
    // The Assistant without its tools improvises; a run must fail instead.
    required: true,
  };
```

Also log the silent branch. Replace the first line of the function body:

```ts
  if (!(await isProvisionedAssistant(db, input.agent))) return null;
```

with:

```ts
  if (!(await isProvisionedAssistant(db, input.agent))) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, input.agent.id));
    if (readBuiltInAgentMarker(row?.metadata)?.key === ASSISTANT_BUILT_IN_AGENT_KEY) {
      logger.warn({ companyId: input.agent.companyId, agentId: input.agent.id, runId: input.runId ?? null },
        "Agent carries the Assistant marker but is not the company's provisioned Assistant: no Assistant tools");
    }
    return null;
  }
```

Imports: `agents` from `@paperclipai/db`, `eq` from `drizzle-orm`. `readBuiltInAgentMarker` and `ASSISTANT_BUILT_IN_AGENT_KEY` are not exported from `assistant-identity.ts`; import them from the module it imports them from (`grep -n "readBuiltInAgentMarker\|ASSISTANT_BUILT_IN_AGENT_KEY" server/src/services/assistant-identity.ts`).

- [ ] **Step 9: Test the server helper**

If `server/src/services/heartbeat/assistant-mcp-server.test.ts` exists, add a case; otherwise create it following the nearest heartbeat test (`ls server/src/services/heartbeat/*.test.ts`) for its db mocking pattern:

```ts
it("marks the provisioned Assistant's tools server required", async () => {
  // arrange: a db stub where resolveCompanyAssistantAgentId resolves to agent "a1"
  const server = await assistantRuntimeMcpServer(db, { agent: { id: "a1", companyId: "c1" }, authToken: "jwt", apiBaseUrl: "http://127.0.0.1:3100", runId: "r1" });
  expect(server).toMatchObject({ name: "Staples assistant", required: true, url: "http://127.0.0.1:3100/api/mcp/assistant-tools" });
});
```

Run: `cd server && timeout 240 pnpm exec vitest run src/services/heartbeat/assistant-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck the three packages**

Run: `timeout 240 pnpm --filter @paperclipai/adapter-utils typecheck && timeout 240 pnpm --filter @paperclipai/adapter-claude-managed typecheck && timeout 240 pnpm --filter @paperclipai/server typecheck`
(Confirm package names with `cat packages/adapters/claude-managed/package.json | grep '"name"'`.)
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/adapter-utils/src/types.ts packages/adapters/claude-managed/src/server/tools-proxy.ts packages/adapters/claude-managed/src/server/tools-proxy.test.ts packages/adapters/claude-managed/src/server/execute.test.ts server/src/services/heartbeat/assistant-mcp-server.ts server/src/services/heartbeat/assistant-mcp-server.test.ts
git commit -m "fix(assistant): fail a hosted run when the Assistant's tools server rejects it

A skipped tools server left the Assistant improvising without tools. A required
server now fails discovery, and the run reports it instead.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Hosted runs reach this instance's tools over loopback

**Files:**
- Modify: `server/src/services/heartbeat/run-preparation.ts:876-891`
- Modify: `server/src/services/heartbeat/runtime-execution.ts:774-791`
- Test: `server/src/services/heartbeat/run-preparation.test.ts` (create if absent; check for an existing `*.test.ts` beside it first)

**Interfaces:**
- Produces: `export function hostLocalApiBaseUrl(): string | null` in `run-preparation.ts`. Reads `PAPERCLIP_LISTEN_HOST` and `PAPERCLIP_LISTEN_PORT` (set at `server/src/index.ts:1003-1004`). Returns `http://127.0.0.1:<port>` for an unspecified bind host (`0.0.0.0`, `::`, empty), `http://[<host>]:<port>` for an IPv6 host, `http://<host>:<port>` otherwise, and `null` when no port is set.
- Produces: `export function toolsApiBaseUrlFor(adapterType: string): string | null` in `run-preparation.ts`: `adapterType === "claude_managed"` → `hostLocalApiBaseUrl() ?? configured`, else `configured`, where `configured = configuredPaperclipApiBaseUrl()`.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { hostLocalApiBaseUrl, toolsApiBaseUrlFor } from "./run-preparation.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("hostLocalApiBaseUrl", () => {
  it("uses loopback for an unspecified bind host", () => {
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    expect(hostLocalApiBaseUrl()).toBe("http://127.0.0.1:3100");
  });
  it("brackets an IPv6 bind host and keeps a named one", () => {
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    expect(hostLocalApiBaseUrl()).toBe("http://[::1]:3100");
    process.env.PAPERCLIP_LISTEN_HOST = "localhost";
    expect(hostLocalApiBaseUrl()).toBe("http://localhost:3100");
  });
  it("is null without a listen port", () => {
    delete process.env.PAPERCLIP_LISTEN_PORT;
    expect(hostLocalApiBaseUrl()).toBeNull();
  });
});

describe("toolsApiBaseUrlFor", () => {
  it("prefers loopback for claude_managed and the configured URL otherwise", () => {
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    process.env.PAPERCLIP_API_URL = "https://example.test";
    expect(toolsApiBaseUrlFor("claude_managed")).toBe("http://127.0.0.1:3100");
    expect(toolsApiBaseUrlFor("claude_local")).toBe("https://example.test");
  });
});
```

Run: `cd server && timeout 240 pnpm exec vitest run src/services/heartbeat/run-preparation.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 2: Implement the helpers**

Append to `run-preparation.ts` after `paperclipApiBaseUrl`:

```ts
/**
 * This process's own listen address. Adapters whose tools proxy runs inside
 * this server (claude_managed) must call the instance they run in, never the
 * public URL, which may name a reverse proxy or another instance.
 */
export function hostLocalApiBaseUrl(): string | null {
  const port = readNonEmptyString(process.env.PAPERCLIP_LISTEN_PORT);
  if (!port) return null;
  const rawHost = readNonEmptyString(process.env.PAPERCLIP_LISTEN_HOST) ?? "";
  const host = rawHost === "" || rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `http://${formatted}:${port}`;
}

/** Base URL an adapter's runtime tool servers are delivered on. */
export function toolsApiBaseUrlFor(adapterType: string): string | null {
  const configured = configuredPaperclipApiBaseUrl();
  if (adapterType === "claude_managed") return hostLocalApiBaseUrl() ?? configured;
  return configured;
}
```

- [ ] **Step 3: Use it in runtime execution**

In `runtime-execution.ts` replace lines 774-787 so every `configuredPaperclipApiBaseUrl() ? paperclipApiBaseUrl() : null` in that block reads from one local:

```ts
      const toolsApiBaseUrl = toolsApiBaseUrlFor(agent.adapterType);
      const assistantServer = await assistantRuntimeMcpServer(db, {
        agent, authToken, apiBaseUrl: toolsApiBaseUrl, runId: run.id,
      });
      // Project tools write as the agent itself; the Assistant's run token is
      // refused for REST writes (auth middleware), so it does not get them.
      if (authToken && toolsApiBaseUrl && issueRef && !assistantServer) {
        runtimeMcpServers.unshift({ name: "Paperclip projects", url: `${toolsApiBaseUrl}/api/mcp/project-tools`,
          token: authToken, connectionId: "paperclip-project-tools" });
      }
      if (assistantServer) runtimeMcpServers.unshift(assistantServer);
      const paperclipServer = paperclipRuntimeMcpServer({
        adapterType: agent.adapterType, authToken, apiBaseUrl: toolsApiBaseUrl,
      });
```

Import `toolsApiBaseUrlFor` from `./run-preparation.js` (next to the existing `configuredPaperclipApiBaseUrl`/`paperclipApiBaseUrl` imports; remove those two imports if nothing else in the file uses them: `grep -n "configuredPaperclipApiBaseUrl\|paperclipApiBaseUrl" server/src/services/heartbeat/runtime-execution.ts`).

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && timeout 240 pnpm exec vitest run src/services/heartbeat/run-preparation.test.ts && timeout 240 pnpm --filter @paperclipai/server typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heartbeat/run-preparation.ts server/src/services/heartbeat/run-preparation.test.ts server/src/services/heartbeat/runtime-execution.ts
git commit -m "fix(hosted): deliver runtime tool servers to claude_managed over loopback

The tools proxy for hosted runs lives in this server process, so it calls this
instance directly instead of a public URL that may point elsewhere.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The weekly update reads as written

**Files:**
- Modify: `server/src/services/assistant-weekly-update.ts:427-456` (`weeklyUpdateExcerpt`)
- Test: `server/src/__tests__/assistant-weekly-update.test.ts:53-63` and the expectation at `:332`

**Interfaces:**
- `weeklyUpdateExcerpt(body, title, max)` keeps its signature. New output shape: each section is its heading on one line followed by each of its items on its own line prefixed with `• `; sections are separated by one newline; at most the first 3 sections and at most 2 items per section.

Observed today on Home: `What shipped, The team is set up: Researcher and Newsletter editor were hired today…, No tasks have finished yet., Blocked and what I need from you, Connect beehiiv…`. The model wrote section names as bold lines (`**What shipped**`) and items as bullets; the current code joins everything with `, `.

- [ ] **Step 1: Write the failing test**

Replace the test at line 53 with:

```ts
  it("previews sections as a heading line and bullet lines, from markdown headings or bold-only lines", () => {
    const body = [
      "# Weekly update — Oct 13, 2026",
      "",
      "**What shipped**",
      "- The team is set up: Researcher and Newsletter editor were hired.",
      "- No tasks have finished yet.",
      "- A third item that is cut by the per-section cap.",
      "",
      "## Blocked and what I need from you",
      "- Connect beehiiv or Resend: the Newsletter editor is waiting.",
      "",
      "## Spend",
      "$0.95 of $60.",
      "",
      "## Next week",
      "Not shown: only three sections.",
    ].join("\n");
    expect(weeklyUpdateExcerpt(body, "Weekly update — Oct 13, 2026", 10_000)).toBe([
      "What shipped",
      "• The team is set up: Researcher and Newsletter editor were hired.",
      "• No tasks have finished yet.",
      "Blocked and what I need from you",
      "• Connect beehiiv or Resend: the Newsletter editor is waiting.",
      "Spend",
      "• $0.95 of $60.",
    ].join("\n"));
  });
```

Keep the existing test at line 59 ("keeps underscores inside words…") and update any expectation that asserts the old `Heading: a, b` shape (line 332: `excerpt: "What shipped: The pricing page and signup"` becomes whatever the new shape yields for that fixture; run the file and copy the actual output once it is correct).

Run: `cd server && timeout 240 pnpm exec vitest run src/__tests__/assistant-weekly-update.test.ts -t "previews sections"`
Expected: FAIL.

- [ ] **Step 2: Implement**

Replace the body of `weeklyUpdateExcerpt` from `const lines = segments.slice(0, 4)…` to the end with:

```ts
  const lines: string[] = [];
  for (const segment of segments.slice(0, 3)) {
    if (segment.heading) lines.push(segment.heading);
    for (const part of segment.parts.slice(0, 2)) lines.push(`• ${part}`);
  }
  const text = lines.join("\n");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
```

And treat a bold-only line as a heading. In the loop, before the `const text = plainInline(raw.replace(...))` line, add:

```ts
    const boldOnly = /^\s{0,3}(\*\*|__)(.+?)\1\s*:?\s*$/.exec(raw);
    if (boldOnly) {
      const text = plainInline(boldOnly[2]!);
      if (text) {
        current = { heading: text, parts: [] };
        segments.push(current);
      }
      continue;
    }
```

- [ ] **Step 3: Run the whole test file**

Run: `cd server && timeout 240 pnpm exec vitest run src/__tests__/assistant-weekly-update.test.ts`
Expected: PASS after updating the line-332 expectation to the new shape (for its fixture the output is the heading line followed by `• ` items; paste the actual string).

- [ ] **Step 4: Check the Home card still clamps**

`ui/src/staples/home/WeeklyUpdateCard.tsx:45` renders `whitespace-pre-line line-clamp-3`. No change needed: the person sees the first heading and two bullets. Confirm `BRIEFING_WEEKLY_UPDATE_EXCERPT_MAX` in `packages/shared/src/types/briefing.ts:167` is at least 400; if smaller, raise it to 400 and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/assistant-weekly-update.ts server/src/__tests__/assistant-weekly-update.test.ts packages/shared/src/types/briefing.ts
git commit -m "fix(home): show the weekly update as heading and bullet lines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Quiet reveals, and Skills becomes an advanced surface

**Files:**
- Modify: `ui/src/staples/surfaces/registry.ts` (`SurfaceDefinition`, entries `nav.dashboard`, `nav.chat`, `nav.projects`, `nav.routines`, `nav.goals`, `nav.skills`, `nav.brief` or however Company brief is keyed, `nav.costs`)
- Modify: `ui/src/staples/surfaces/resolve.ts:24`
- Test: `ui/src/staples/surfaces/resolve.test.ts`, `ui/src/staples/surfaces/useSurfaces.test.tsx`, `ui/src/staples/surfaces/SidebarMoreMenu.test.tsx` (update any assertion that Skills reveals from `extraSkills`)

**Interfaces:**
- Produces: `SurfaceDefinition.quietReveal?: boolean`. A quiet surface still reveals (becomes visible) by its rule, still persists the reveal and still has a `reason`, but never carries the "new" badge.

Observed: after the plan is applied, seven "new" badges appear at once (Chat, Routines, What we've made, Skills, Connectors, Company brief, Costs) because templates seed routines, skills, a brief and spend. Only surfaces a person must act on or that hold new output keep the badge: Connectors, What we've made, Decisions, Inbox.

- [ ] **Step 1: Write the failing resolver tests**

Add to `resolve.test.ts` inside the existing `describe` for `resolveSurface` (reuse `byId`, `ctx`, `signals`, `prefs` helpers):

```ts
  it("reveals a quiet surface without the new badge", () => {
    const routines = byId("nav.routines");
    const state = resolveSurface(routines, ctx({ signals: signals({ routines: 1 }) }), prefs());
    expect(state.visible).toBe(true);
    expect(state.source).toBe("grows");
    expect(state.shouldPersistReveal).toBe(true);
    expect(state.isNew).toBe(false);
  });

  it("keeps the new badge on surfaces that need the person", () => {
    const artifacts = byId("nav.artifacts");
    expect(resolveSurface(artifacts, ctx({ signals: signals({ artifacts: 1 }) }), prefs()).isNew).toBe(true);
    const connectors = byId("nav.connectors");
    expect(resolveSurface(connectors, ctx({ signals: signals({ connectionRequests: 1 }) }), prefs()).isNew).toBe(true);
  });

  it("never reveals Skills by signal; it is an advanced surface", () => {
    const skills = byId("nav.skills");
    const state = resolveSurface(skills, ctx({ signals: signals({ extraSkills: 3 }) }), prefs());
    expect(state.visible).toBe(false);
    expect(state.source).toBe("advanced");
    expect(resolveSurface(skills, ctx(), prefs({ showEverything: true })).visible).toBe(true);
  });
```

Run: `cd ui && timeout 240 pnpm exec vitest run src/staples/surfaces/resolve.test.ts -t "quiet|advanced surface|need the person"`
Expected: FAIL.

- [ ] **Step 2: Implement**

`registry.ts`: add to `SurfaceDefinition`:

```ts
  /** Reveal by rule but never show the "new" badge (seeded by templates, not by the person). */
  quietReveal?: boolean;
```

Set `quietReveal: true` on `nav.dashboard`, `nav.chat`, `nav.projects`, `nav.routines`, `nav.goals`, `nav.costs` and the Company brief entry. Change `nav.skills` to:

```ts
  {
    id: "nav.skills",
    label: "Skills",
    to: "/skills",
    matchRoots: ["skills"],
    icon: Boxes,
    group: "org",
    tier: "advanced",
  },
```

(remove its `revealWhen` and `reason`).

`resolve.ts:24`:

```ts
  const isNew = (revealed || growthFires) && surface.tier !== "core" && !surface.quietReveal && !(surface.id in prefs.seen);
```

- [ ] **Step 3: Run the surface tests and fix assertions that encoded the old behaviour**

Run: `cd ui && timeout 240 pnpm exec vitest run src/staples/surfaces/`
Expected: PASS after updating any test that asserted Skills reveals on `extraSkills` or that Routines/Chat carry `isNew`.

- [ ] **Step 4: Token gates and typecheck**

Run: `timeout 240 pnpm check:token-gates && timeout 240 pnpm --filter @paperclipai/ui typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/staples/surfaces/registry.ts ui/src/staples/surfaces/resolve.ts ui/src/staples/surfaces/resolve.test.ts ui/src/staples/surfaces/useSurfaces.test.tsx ui/src/staples/surfaces/SidebarMoreMenu.test.tsx
git commit -m "fix(nav): quiet reveals for seeded surfaces; Skills is advanced

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Skills never show a filesystem path

**Files:**
- Modify: `server/src/services/company-skills.ts:2816-2840` (local_path branch of the source descriptor)
- Test: `server/src/__tests__/company-skills-service.test.ts` (it already asserts the `"Paperclip workspace"` label; the function is the private `deriveSkillSourceInfo` at `company-skills.ts:2763`, exercised through the service's list/detail path used in that test).

**Interfaces:**
- The descriptor's `sourceLabel` for a `local_path` skill outside the managed root becomes `"Local folder"`; for a project scan it stays `"<project> / <workspace>"` and falls back to `"Local folder"` (not the locator) when both names are empty. `sourcePath` stays `null`. No shape change.

Observed: the Skills page author line read `by /Users/<name>/Metaplex/staples/tmp/…`.

- [ ] **Step 1: Find how the existing test reaches the label**

Run: `grep -n "Paperclip workspace\|sourceLabel\|local_path" server/src/__tests__/company-skills-service.test.ts | head -20` and read the surrounding test to see how a local-path skill fixture is created and listed.

- [ ] **Step 2: Write the failing test**

Next to that test, add one that creates (or fixtures) a `local_path` skill whose `sourceLocator` is `/Users/someone/private/skills/foo` outside the managed root, lists it the same way, and asserts:

```ts
    expect(listed.sourceLabel).toBe("Local folder");
    expect(JSON.stringify(listed)).not.toContain("/Users/");
```

Run: `cd server && timeout 240 pnpm exec vitest run src/__tests__/company-skills-service.test.ts -t "Local folder"`
Expected: FAIL (label is the path).

- [ ] **Step 3: Implement**

In the `local_path` branch replace the `sourceLabel:` expression:

```ts
      sourceLabel: isProjectScan
        ? [projectName, workspaceName].filter((value): value is string => Boolean(value)).join(" / ")
          || "Local folder"
        : "Local folder",
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd server && timeout 240 pnpm exec vitest run src/__tests__/company-skills-service.test.ts && timeout 240 pnpm --filter @paperclipai/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/company-skills.ts server/src/__tests__/company-skills-service.test.ts
git commit -m "fix(skills): label local folder skills without their filesystem path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Interview opening for people starting a business

**Files:**
- Modify: `ui/src/staples/assistant/AssistantOpening.tsx:4-9`
- Modify: `server/src/built-ins/agents/assistant/AGENTS.md:163` (round size) and add one rule under the same section
- Modify: `skills/staples-interview/SKILL.md:37-40`
- Modify: `server/src/services/built-in-agents.ts:393` (`stockVersion`)
- Test: `ui/src/staples/assistant/Assistant.test.tsx:190-205`, `server/src/__tests__/assistant-weekly-update.test.ts:65` (asserts the bumped stock version; update the expected string)

- [ ] **Step 1: Update the opening copy and its test**

`AssistantOpening.tsx`:

```ts
export const ASSISTANT_OPENING_MESSAGE = "Hi, I'm your Assistant. What business are you starting, or what do you want help with?";
export const ASSISTANT_OPENING_SUGGESTIONS = [
  "A dog-walking service in my neighborhood",
  "An online shop for my handmade candles",
  "A weekly newsletter for my customers",
] as const;
```

In `Assistant.test.tsx` lines 195-203 replace the expected message and suggestions with the new strings (the click assertion uses `"A weekly newsletter for my customers"`).

Run: `cd ui && timeout 240 pnpm exec vitest run src/staples/assistant/Assistant.test.tsx`
Expected: PASS.

- [ ] **Step 2: Shorter rounds and a no-tools rule in AGENTS.md**

At `AGENTS.md:163` change `up to 8 per card` to `up to 4 per card`. Immediately after that paragraph add:

```md
If `staples_ask_questions` or your other Staples tools are not available in a run, do not ask questions in plain text and do not describe which tools are missing. Reply with one line: "I'm not fully set up yet. Please try again in a minute." and end your turn. Never mention tools, APIs, sessions or sandboxes to the person.
```

- [ ] **Step 3: Same round size in the interview skill**

`skills/staples-interview/SKILL.md:39`:

```md
- One card per round. At most 4 questions per card. If the frontier is larger, ask the 4 that unblock the most later decisions and keep the rest for the next round. A person starting a business is answering on a phone or between other things: short rounds get answered.
```

- [ ] **Step 4: Bump the stock version and its test**

`built-in-agents.ts:393`: `stockVersion: "2026-10-14b",`. Update the expectation in `server/src/__tests__/assistant-weekly-update.test.ts` near line 65 to `"2026-10-14b"` (read the test first; it may compare against a constant).

Run: `cd server && timeout 240 pnpm exec vitest run src/__tests__/assistant-weekly-update.test.ts -t "stock version"`
Expected: PASS.

- [ ] **Step 5: Token gates**

Run: `timeout 240 pnpm check:token-gates`
Expected: clean (copy only).

- [ ] **Step 6: Commit**

```bash
git add ui/src/staples/assistant/AssistantOpening.tsx ui/src/staples/assistant/Assistant.test.tsx server/src/built-ins/agents/assistant/AGENTS.md skills/staples-interview/SKILL.md server/src/services/built-in-agents.ts server/src/__tests__/assistant-weekly-update.test.ts
git commit -m "feat(assistant): opening and interview written for people starting a business

Rounds of at most four questions, business-shaped examples, and a one-line
reply instead of improvising when the tools are missing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Live verification (controller)

- [ ] Add `PAPERCLIP_API_URL=http://localhost:3100` to the `staples-dev-hosted` launch configuration in `.claude/launch.json` (local only, never committed) and restart the preview server.
- [ ] On the `UXR` company, send one message to the Assistant. Expected: the run log has no `Skipping tools` line, a `staples_ask_questions` card appears with at most 4 questions, and the opening bubble shows the new copy on a fresh company.
- [ ] Temporarily set `PAPERCLIP_API_URL` back to the wrong host, send a message. Expected: the run fails with a visible error and Retry, and the Assistant never answers in plain text. Restore the setting.
- [ ] Home for the `LAN` company: the weekly update card shows a heading line and bullets.
- [ ] Sidebar after a fresh plan: only Connectors and What we've made carry "new"; Skills is absent from the sidebar and present under More.
- [ ] Skills page: no `/Users/` text anywhere (`get_page_text` grep).
- [ ] Run `timeout 240 pnpm -r typecheck` and `pnpm test:run` for the touched packages before hand-off.

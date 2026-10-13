# Deployment Modes

Status: Canonical deployment and auth mode model  
Date: 2026-02-23

### Paperclip Cloud sign-in

Cloud-managed instances use Cloud for human sign-in. The instance `/auth`
route waits for deployment metadata before rendering; it never renders the
email/password form when health identifies a Cloud-managed instance. A missing
instance session returns through Cloud's `/v1/stacks/:slug/entry-redirect`.
Cloud renews the tenant session from the existing Cloud session, or sends the
user through its sign-in flow. The original tenant path, query, and fragment
travel as `returnTo` so the user returns to the same task.

Both the Cloud origin and stack slug come from the server's health metadata
(`PAPERCLIP_CLOUD_API_ORIGIN` and `PAPERCLIP_STACK_SLUG`). Do not infer the
environment from the browser hostname or hardcode staging/production domains.
Missing configuration shows an unavailable state. An automatic recovery attempt
is limited per browser tab until a session is verified, with a five-minute
expiry and an explicit retry link if recovery fails. Network/server failures
show an error rather than treating the user as signed out.

Self-hosted authenticated instances retain their instance sign-in form, and
`local_trusted` instances retain their normal access path.

## 1. Purpose

Paperclip supports two runtime modes:

1. `local_trusted`
2. `authenticated`

`authenticated` supports two exposure policies:

1. `private`
2. `public`

This keeps one authenticated auth stack while still separating low-friction private-network defaults from internet-facing hardening requirements.

Paperclip now treats **bind** as a separate concern from auth:

- auth model: `local_trusted` vs `authenticated`, plus `private/public`
- reachability model: `server.bind = loopback | lan | tailnet | custom`

## 2. Canonical Model

| Runtime Mode | Exposure | Human auth | Primary use |
|---|---|---|---|
| `local_trusted` | n/a | No login required | Single-operator local machine workflow |
| `authenticated` | `private` | Login required | Private-network access (for example Tailscale/VPN/LAN) |
| `authenticated` | `public` | Login required | Internet-facing/cloud deployment |

## Reachability Model

| Bind | Meaning | Typical use |
|---|---|---|
| `loopback` | Listen on localhost only | default local usage, reverse-proxy deployments |
| `lan` | Listen on all interfaces (`0.0.0.0`) | LAN/VPN/private-network access |
| `tailnet` | Listen on a detected Tailscale IP | Tailscale-only access |
| `custom` | Listen on an explicit host/IP | advanced interface-specific setups |

## 3. Security Policy

## `local_trusted`

- loopback-only host binding
- no human login flow
- optimized for fastest local startup

## `authenticated + private`

- login required
- low-friction URL handling (`auto` base URL mode)
- private-host trust policy required
- Better Auth request rate limiting is off by default for private mode to keep local/LAN repair loops from locking out the operator; set `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=true` to opt in
- bind can be `loopback`, `lan`, `tailnet`, or `custom`

## `authenticated + public`

- login required
- explicit public URL required
- stricter deployment checks and failures in doctor
- Better Auth request rate limiting is on by default; set `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false` only when an explicit front-door limiter covers the deployment
- recommended bind is `loopback` behind a reverse proxy; direct `lan/custom` is advanced
- local stdio MCP runtime slots fail closed by default; set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` only when a trusted worker/runtime host is configured to supervise those processes. Remote HTTP MCP remains the preferred public-hosted path.

### Paperclip Cloud warm-pool identity

A Cloud-managed warm-pool process initially boots under a `pool-*` origin. It
receives only Cloud's public verification set in
`PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS`. Before Cloud activates a claimed stack,
the existing server-to-server health request carries a short-lived Ed25519 JWS
that binds the immutable `PAPERCLIP_CLOUD_STACK_ID`, pool claim, previous
origin, canonical HTTPS origin, and slug. Paperclip verifies and persists that
one-time assertion, updates its live public/API URL provider, and acknowledges
the exact origin in `/api/health` before the first user request is admitted.

The Harness signing private key is never present in Paperclip, browsers, or
other tenant stacks. A different claim or destination cannot replace the
persisted identity. On restart, the durable identity is loaded before auth,
routes, and child-runtime configuration, even when provider variables are
temporarily stale. Self-hosted deployments continue to use their configured
`PAPERCLIP_PUBLIC_URL` and do not participate in this protocol.

## 4. Onboarding UX Contract

Default onboarding remains interactive and flagless:

```sh
pnpm paperclipai onboard
```

Server prompt behavior:

1. quickstart `--yes` defaults to `server.bind=loopback` and therefore `local_trusted/private`
2. advanced server setup asks reachability first:
- `Trusted local` → `bind=loopback`, `local_trusted/private`
- `Private network` → `bind=lan`, `authenticated/private`
- `Tailnet` → `bind=tailnet`, `authenticated/private`
- `Custom` → manual mode/exposure/host entry
3. raw host entry is only required for the `Custom` path
4. explicit public URL is only required for `authenticated + public`

Examples:

```sh
pnpm paperclipai onboard --yes
npx paperclipai onboard --yes --bind lan
npx paperclipai run --bind tailnet
```

`configure --section server` follows the same interactive behavior.

## 5. Doctor UX Contract

Default doctor remains flagless:

```sh
pnpm paperclipai doctor
```

Doctor reads configured mode/exposure and applies mode-aware checks. Optional override flags are secondary.

## 6. Board/User Integration Contract

Board identity must be represented by a real DB user principal for user-based features to work consistently.

Required integration points:

- real user row in `authUsers` for Board identity
- `instance_user_roles` entry for Board admin authority
- `company_memberships` integration for user-level task assignment and access

This is required because user assignment paths validate active membership for `assigneeUserId`.

## 7. Local Trusted -> Authenticated Claim Flow

When running `authenticated` mode, if the only instance admin is `local-board`, Paperclip emits a startup warning with a one-time high-entropy claim URL.

- URL format: `/board-claim/<token>?code=<code>`
- intended use: signed-in human claims board ownership
- claim action:
  - promotes current signed-in user to `instance_admin`
  - demotes `local-board` admin role
  - ensures active owner membership for the claiming user across existing companies

This prevents lockout when a user migrates from long-running local trusted usage to authenticated mode.

## 8. First Admin Setup For Fresh Authenticated Installs

Fresh authenticated installs start in `bootstrap_pending` until the first
`instance_admin` exists.

For `authenticated/private`, Paperclip supports a browser-first setup path:

1. open the Paperclip URL from the private network or appliance UI
2. sign in or create a Paperclip account
3. choose `Claim this instance` on the setup screen

That browser claim promotes the signed-in session user to the first instance
admin and then falls through to normal onboarding. The endpoint is available
only to real browser session actors in `authenticated/private`; unauthenticated
requests, agent keys, board API keys, and local implicit board actors are
rejected.

This is intentionally a first-claim bootstrap contract: before an instance
admin exists, the first authenticated browser session that completes the claim
wins. Operators must keep a `bootstrap_pending` private deployment on a trusted
network and complete setup before admitting untrusted users. This behavior is
not an account-recovery or public-deployment mechanism.

The CLI fallback remains supported in all authenticated setup states:

```sh
pnpm paperclipai auth bootstrap-ceo
```

That command prints a one-time first-admin invite URL. Browser claim and
bootstrap invite acceptance share the same first-admin transaction, so whichever
path wins first makes later attempts return a conflict.

For `authenticated/public`, browser first-admin claim is intentionally disabled.
Public deployments must use the high-entropy bootstrap invite path unless a
future public-hosted setup design explicitly changes this policy.

### Self-serve company creation (authenticated only)

By default only an instance admin (or the local board in `local_trusted`) can
create a company with `POST /api/companies`. A signed-in user with no company
sees "Ask the person who invited you for access".

**Self-serve is for trusted users.** Anyone who can sign up can create a
company and spend the instance's hosted-inference key. Use it with invited
people only, and set `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` once your trial users
have signed up.

| Variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_SELF_SERVE_COMPANIES` | `false` | When `true` and the mode is `authenticated`, any user with a browser session can create a company. Ignored in `local_trusted`. Requires hosted inference (`STAPLES_HOSTED_ANTHROPIC_API_KEY`); without it self-serve creation returns `409 self_serve_hosted_inference_required`. |
| `PAPERCLIP_SELF_SERVE_COMPANY_LIMIT` | `3` | How many self-serve companies one user may create. The count is by creator, and archived companies count, so archiving never frees a slot. Unarchiving must also fit under the limit. A non-admin can't delete a self-serve company, so deleting can't free a slot either. At the limit, `POST /api/companies` (or an unarchive) returns `403 self_serve_company_limit`. Instance admins are not limited. **Use `1` for trials.** |
| `PAPERCLIP_SELF_SERVE_ADAPTERS` | `claude_managed` | Comma-separated agent adapters allowed in self-serve companies. `process` and every `*_local` adapter are always dropped from this list, because they run on the server host. |

#### What the creator gets

- A company marked `self_serve` (database column `companies.self_serve`, with
  the creator in `self_serve_created_by_user_id`).
- `owner` membership and the same default grants an admin creator gets.
- The Staples Assistant, on Claude (hosted).
- An activity-log entry: `company.created` with the user as actor and
  `details.selfServe: true`.
- Only browser sessions qualify. Board API keys, agents and Cloud tenants do not.

Creation runs in one short transaction that holds a per-user
`pg_try_advisory_xact_lock`. The count, the company row and the owner
membership are all written on that transaction. A concurrent create by the same
user gets `409 self_serve_company_create_in_progress` and can retry. The lock
never waits for a second pool connection, so concurrent creates can't stall the
pool. Built-in provisioning runs after commit.

#### Host-execution floor

While `PAPERCLIP_SELF_SERVE_COMPANIES` is on, every company marked `self_serve`
is held to the floor below, whatever the actor (its owner, an instance admin or
its agents). Admin-created companies keep normal behaviour, except that remote
MCP URLs are restricted instance-wide (see below).

**Turning the flag off lifts all of this for existing self-serve companies.**
That includes the floor, the admin-only delete and the unarchive limit; the
`self_serve` marker stays, so turning the flag back on restores them. Keep the
flag on while any self-serve company exists.

**Adapters.** Agents may only use the adapters in
`PAPERCLIP_SELF_SERVE_ADAPTERS`.

**Config keys (an allowlist).** An agent's `adapterConfig` may only carry
reviewed keys. Any other key, including keys a future version adds, is refused
with `403 self_serve_config_key_not_allowed`. For `claude_managed` the reviewed
keys are:

- `model`, `environmentId`, `promptTemplate`, `bootstrapPromptTemplate`,
  `inactivityTimeoutSec`, `networkingMode`, `networkAllowedHosts` and
  `networkAllowPackageManagers`;
- `apiBaseUrl`, only at its default `https://api.anthropic.com/v1`;
- `env`, only `ANTHROPIC_API_KEY` bound to a stored secret (`secret_ref` or
  `user_secret_ref`); a plain key value is refused;
- the server-managed `paperclipSkillSync`;
- the managed instructions bundle: `instructionsBundleMode` must be `managed`,
  `instructionsEntryFile` must be a relative name with no `..`, and
  `instructionsFilePath` / `instructionsRootPath` must resolve (symlinks
  included) inside `<instance>/companies/<companyId>/agents/`.

Host command keys, workspace commands, endpoint overrides, external instruction
paths (`agentsMdPath`, `instructionsBundleMode: external`) and runtime-only
fields are therefore refused.

**Where it is enforced.** These checks run where every path converges:

- **Agent record creation.** Every create, hire, plan hire, join approval,
  import, catalog install, onboarding seed and built-in goes through it.
- **Agent configuration updates.** This covers update, adapter switch, config
  rollback and Assistant setup.
- **Pending-hire activation.**
- **Approval filing.** A `hire_agent` approval with a disallowed adapter or
  config is rejected when it is created or resubmitted, not only when it is
  approved.
- **The heartbeat runtime backstop.** A run for an agent whose adapter or
  effective config (including issue adapter overrides) breaks the floor fails
  with `self_serve_adapter_not_allowed` before any workspace or adapter work.
  This catches anything written to the database some other way.

Independently of the flag, the `claude_managed` adapter only reads
`instructionsFilePath` when it resolves inside that managed folder. Any other
path is ignored with a warning, so the system prompt can never be a server file
such as `/proc/self/environ`. This applies to every company.

**Workspace folders and the file browser.** In a self-serve company nobody
chooses a server folder: a project workspace `cwd`, an execution workspace
`cwd` / `providerRef` change, and `worktreeParentDir` in a project, issue or
execution workspace policy are refused with
`403 self_serve_host_execution_forbidden`. The issue file browser
(`/issues/:id/file-resources/*`) only serves a self-serve company's local
workspace when its root resolves, symlinks included, inside that company's
server-managed folders: `<instance>/projects/<companyId>/`,
`<instance>/isolated-workspaces/<companyId>/` and `<instance>/workspaces/<agentId>/`
for its agents. Any other root is reported as unavailable
(`workspace_root_not_allowed`). For every company, the file browser never
serves anything under `/proc`, `/sys`, `/dev`, `/etc`, `/run/secrets`,
`/var/run/secrets`, or the instance's `db`, `secrets`, `data` and `logs`
folders, `config.json` or `.env` (`denied_host_path`).

**Built-in agents in a self-serve company run on Claude (hosted).** A built-in
that can't run hosted is skipped, never provisioned on a local CLI. The
onboarding seed's first agent is `claude_managed`.

**Refused in a self-serve company:**

- `claude-login`, which runs a CLI on the host;
- adapter environment tests whose adapter or config is not allowed (a
  `claude_managed` test with an allowed config still works);
- host-executed workspace commands on projects, issues and execution
  workspaces, and the workspace runtime-command routes;
- project workspace `cwd` (a server folder) and plugin local folders;
- skill imports from a server folder, and project skill browse/scan (GitHub and
  catalog sources still work);
- adding a local command (stdio) MCP template;
- company package imports.

**Refused on the whole instance while self-serve is on:**

- Remote MCP connection URLs that resolve to loopback, private or internal
  addresses (for example `*.railway.internal`, `127.0.0.1`, `10.x`).
  Link-local and metadata addresses are always refused.
- `POST /api/health/dev-server/restart` for anyone who is not an instance admin.

**Already admin-only and unchanged:** environments; plugin install, enable and
config; adapter install. The external-instructions route
(`PATCH /agents/:id/instructions-path`) is admin-only. In a self-serve company
the config allowlist also refuses external instruction paths that arrive
through hires or approvals.

#### Company boundaries

A self-serve user sees and changes only the companies they belong to. They
can't grant themselves access to another company, create invites for it or
approve its join requests. Joining needs an invite from that company.

These boundaries keep tenants apart in the API, but every company still runs in
one server process with one database. Treat self-serve users as trusted
colleagues, not hostile tenants.

#### Hosted spend exposure

Each self-serve company's hosted spend is capped per month by
`STAPLES_HOSTED_COMPANY_BUDGET_CENTS` (default $50). The company can raise its
cap up to `STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS` (default $200). The worst
case per month is:

```
users x PAPERCLIP_SELF_SERVE_COMPANY_LIMIT x STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS
```

For example, 10 users x 3 companies x $200 = $6,000. With a limit of 1 and a
$100 ceiling it is $1,000. Also set a spend limit on the Anthropic key at the
provider. That limit is the only cap that holds if Staples' own accounting is
wrong.

#### UI

`GET /api/health` reports `features.selfServeCompanies: true` to signed-in
callers. The UI then sends a user with no company to `/start` ("Name your
company") and shows "Create organization" in the company switcher. With the
flag off, creation stays admin-only and non-admins don't see "Create
organization".

## 9. Current Code Reality (As Of 2026-02-23)

- runtime values are `local_trusted | authenticated`
- `authenticated` uses Better Auth sessions and bootstrap invite flow
- `local_trusted` ensures a real local Board user principal in `authUsers` with `instance_user_roles` admin access
- company creation ensures creator membership in `company_memberships` so user assignment/access flows remain consistent

## 10. Naming and Compatibility Policy

- canonical naming is `local_trusted` and `authenticated` with `private/public` exposure
- no long-term compatibility alias layer for discarded naming variants

## 11. Relationship to Other Docs

- implementation plan: `doc/plans/2026-02-23-deployment-auth-mode-consolidation.md`
- V1 contract: `doc/SPEC-implementation.md`
- operator workflows: `doc/DEVELOPING.md` and `doc/CLI.md`
- invite/join state map: `doc/spec/invite-flow.md`

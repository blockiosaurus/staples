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
| `PAPERCLIP_SELF_SERVE_COMPANY_LIMIT` | `3` | How many companies a non-admin may own. Archived companies count, so archiving never frees a slot, and unarchiving must also fit under the limit. At the limit, `POST /api/companies` (or an unarchive) returns `403 self_serve_company_limit`. Instance admins are not limited. **Use `1` for trials.** |
| `PAPERCLIP_SELF_SERVE_ADAPTERS` | `claude_managed` | Comma-separated agent adapters that non-admins may use while self-serve is on. `process` and every `*_local` adapter are always dropped from this list, because they run on the server host. |

#### What the creator gets

- The creator becomes the company `owner` with the same membership, default
  grants and built-in agents (the Staples Assistant runs on Claude (hosted)) an
  admin creator gets.
- Creation is activity-logged as `company.created` with the user as actor and
  `details.selfServe: true`.
- Creation is serialized per user with a Postgres advisory lock, so parallel
  requests cannot overshoot the limit.
- Only browser sessions qualify. Board API keys, agents and Cloud tenants do not.

#### Host-execution floor

With self-serve on, a company owner is not a trusted operator. Every actor that
is not an instance admin (non-admin people and all agents, in every company) is
held to this floor:

- Agents may only use the adapters in `PAPERCLIP_SELF_SERVE_ADAPTERS`. This
  covers create, hire (including plan hires and approvals, which go through the
  hire route), update and adapter switch, config rollback, agent join-request
  approval, and team-catalog installs (catalog agents default to the first
  allowed adapter). `*_local` host-command keys (`command`, `args`, `cwd`, `env`,
  ...) are refused.
- Adapter environment tests and `claude-login` (both run a CLI on the host) are
  refused.
- Host-executed workspace commands (provision, teardown, cleanup, runtime
  services and jobs) cannot be set on projects, issues, execution workspaces or
  agents, and the workspace runtime-command routes cannot be run.
- Project workspace `cwd` (a server folder) and plugin local folders cannot be
  set.
- Local command (stdio) MCP templates cannot be added.
- Company package imports (`/companies/import`, `/companies/:id/imports/*`)
  are refused.
- `POST /api/health/dev-server/restart` is refused.

Already admin-only and unchanged: environments, plugin install, enable and
config, adapter install, and external instruction paths.

#### Company boundaries

A self-serve user sees and changes only the companies they belong to. They
can't grant themselves access to another company, create invites for it or
approve its join requests; joining needs an invite from that company. These
boundaries keep tenants apart in the API, but every company still runs in one
server process with one database. Treat self-serve users as trusted colleagues,
not hostile tenants.

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

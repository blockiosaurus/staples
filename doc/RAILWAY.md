# Deploying a Staples trial on Railway

This guide deploys one Staples instance to [Railway](https://railway.com) for a
small trial group: a Postgres database, a volume for agent workspaces and
files, and hosted inference under hard spending caps. `railway.toml` at the repo
root configures the build and health check.

## What you get

- The repo `Dockerfile`, built by Railway. Railway builds the last stage of the
  Dockerfile, which is `railway` (an alias of the lean `production` target), not
  the heavier `cloud` variant CI uses for managed deployments.
- `GET /api/health` as the health check, 300 s timeout, restart on failure.
- Authenticated mode with private exposure (the image default). Open sign-up
  is on until you turn it off.
- Port: Railway injects `PORT`; the server reads `PORT` (`server/src/config.ts`)
  and the service variable overrides the image's `PORT=3100`. No change needed.
  Do not set `PORT` yourself.

## 1. Create the project

1. In Railway: **New Project** > **Deploy from GitHub repo**, and pick your
   Staples fork. Railway reads `railway.toml` and uses the Dockerfile.
2. Do not deploy yet if you can avoid it. Add the database, volume and variables
   first (a deploy without them fails and you will just redeploy).

## 2. Add Postgres

1. In the project: **New** > **Database** > **PostgreSQL**.
2. On the Staples service, add the variable
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (a reference variable; adjust
   `Postgres` to your database service name).

Without `DATABASE_URL` the server falls back to an embedded PostgreSQL on the
volume, which is not what you want for a shared trial.

## 3. Add a volume

On the Staples service: **Settings** > **Volumes** > mount path `/paperclip`.
**The volume is required.** Without it, everything below is lost on every
deploy. `/paperclip` holds:

- `instances/default/secrets/master.key`, the key that encrypts stored company
  secrets. If it is lost, those secrets cannot be recovered.
- `instances/default/data/storage` (uploads), `data/backups`, agent workspaces,
  and `config.json`.

The image entrypoint fixes ownership of `/paperclip` on boot, so Railway's
root-owned volume works.

Protect the master key either by backing up `master.key` somewhere safe, or by
supplying it as a variable so it does not depend on the volume:
`PAPERCLIP_SECRETS_MASTER_KEY` = `openssl rand -base64 32` (it accepts 32-byte
base64, 64-char hex, or a raw 32-character string). Set it before any secret is
stored; changing it later makes existing secrets unreadable.

## 4. Set variables

Generate each secret yourself (never commit them):

| Variable | Value | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` | Signs sign-in sessions. Required. |
| `PAPERCLIP_AGENT_JWT_SECRET` | `openssl rand -hex 32` | Signs agent run tokens. Required in authenticated mode (if unset, `BETTER_AUTH_SECRET` is used as a fallback, but set both). |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | `openssl rand -hex 32` | Signs tool-action approvals. Without it those approvals cannot be issued. |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | `healthcheck.railway.app` | Required. The image runs in authenticated/private mode, which rejects any request whose `Host` is not allowed. Railway's health checker sends `Host: healthcheck.railway.app`, so without this the deploy fails its health check. Comma-separate to add more hosts. |
| `PAPERCLIP_PUBLIC_URL` | `https://<your-service>.up.railway.app` | The public origin, no trailing slash. Also the base for connector OAuth callbacks and sign-in origin checks. Generate the domain first (**Settings** > **Networking** > **Generate Domain**), then set this. |
| `STAPLES_HOSTED_ANTHROPIC_API_KEY` | your Anthropic API key | Turns on hosted inference. Use a dedicated key with its own provider-side spend limit. |
| `PAPERCLIP_SELF_SERVE_COMPANIES` | `true` | Lets each signed-in trial user create their own company. Default `false`. |
| `PAPERCLIP_SELF_SERVE_COMPANY_LIMIT` | `3` | Max self-serve companies per user. Default `3`. |

Optionally, Railway can generate a secret for you with a template variable such
as `${{ secret(64, "abcdef0123456789") }}` in the raw editor.

### Trial caps (hosted inference)

Hosted-key spend is capped per month and the caps are enforced as hard stops
(see [Hosted inference](adapters/claude-managed.md#hosted-inference)). The
defaults are Assistant $20, other agents $20, company $50, plan ceiling $200.
Recommended trial values, in cents:

| Variable | Trial value | Meaning |
| --- | --- | --- |
| `STAPLES_HOSTED_ASSISTANT_BUDGET_CENTS` | `2000` | Assistant, $20 |
| `STAPLES_HOSTED_AGENT_BUDGET_CENTS` | `2000` | Each other agent, $20 |
| `STAPLES_HOSTED_COMPANY_BUDGET_CENTS` | `10000` | Company, $100 |
| `STAPLES_HOSTED_COMPANY_BUDGET_MAX_CENTS` | `30000` | Ceiling a plan or approval may raise the company cap to, $300 |

`0` means uncapped; avoid that on a trial. These are code defaults when unset;
this guide only recommends values.

`STAPLES_HOSTED_INFERENCE=off` disables the hosted key path only. With it set
(or with no hosted key), agents use a key their owner supplies, or the server's
plain `ANTHROPIC_API_KEY` if you set one, with no forced caps. Use it to stop
all hosted spend without removing the key.

## 5. Deploy

Click **Deploy** (or push to the tracked branch). Expect:

- **A slow first build.** The Dockerfile compiles a Rust runner and installs
  several agent CLIs. A local build took about 241 s on a warm cache and produced
  a 5.21 GB image; a cold build (Railway's first one) will be slower. Later
  builds reuse layers.
- **Migrations on first boot.** The server applies database migrations
  automatically and only then starts listening, so the health check can fail
  briefly. The 300 s health-check timeout covers this.
- Logs show the listening address when it is ready.

## 6. Claim the instance before sharing the URL

The first account to sign in on a private-exposure instance becomes the instance
admin. Open `PAPERCLIP_PUBLIC_URL` yourself, create your account, and confirm you
are the admin before sending the link to anyone.

## 7. Optionally close sign-up

Once your trial users have accounts, set `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`
and redeploy to stop new sign-ups. (Sign-up is open by default.) Existing users
still sign in.

## 8. Share the URL

Send trial users the Railway domain (or a custom domain; if you add one, update
`PAPERCLIP_PUBLIC_URL`). With `PAPERCLIP_SELF_SERVE_COMPANIES=true` each user can
create their own company after signing in.

## Connector OAuth redirect URLs

OAuth callbacks are built from `PAPERCLIP_PUBLIC_URL`. When you register an
OAuth app with a provider (for example GitHub or Google), allow this redirect URI:

```
https://<your-service>.up.railway.app/api/tools/oauth/callback
```

For a Slack app, the redirect URI is
`https://<your-service>.up.railway.app/api/chat-slack/oauth/callback`.

If you change the domain, update both `PAPERCLIP_PUBLIC_URL` and the redirect
URI at the provider.

## Troubleshooting

- **Requests fail with "This hostname is not allowed for this Paperclip
  instance".** The private-hostname guard rejected the request's `Host`. Add the
  hostname to `PAPERCLIP_ALLOWED_HOSTNAMES` (the `PAPERCLIP_PUBLIC_URL` host is
  allowed automatically). Railway's health checker needs
  `healthcheck.railway.app`; this was verified locally: that Host returns 403
  without the variable and 200 with it.
- **Origin mismatch / sign-in or API calls rejected as forbidden origin.**
  `PAPERCLIP_PUBLIC_URL` does not match the URL in the browser (scheme, host,
  or trailing slash). Fix it to the exact public origin and redeploy. If you
  serve from additional hostnames, add them to `PAPERCLIP_ALLOWED_HOSTNAMES`
  (comma-separated).
- **Agents run without Staples tools / logs say no agent run-token secret is
  configured.** Set `PAPERCLIP_AGENT_JWT_SECRET` (and `BETTER_AUTH_SECRET`).
- **Health check fails on first deploy.** First confirm
  `PAPERCLIP_ALLOWED_HOSTNAMES=healthcheck.railway.app` is set. Then check the deploy logs for migration
  or `DATABASE_URL` errors; confirm the Postgres reference variable resolves.
  Note the volume must be mounted at `/paperclip`.
- **"Cap reached" / "reached its monthly spending cap for hosted inference".**
  The company or agent hit its hosted cap. Raise the relevant
  `STAPLES_HOSTED_*_BUDGET_CENTS` (up to the ceiling), or wait for the month
  rollover. Self-serve company creation refusing with a limit message means the
  user is at `PAPERCLIP_SELF_SERVE_COMPANY_LIMIT`.
- **Out of credit.** Two sources: Railway (trial or usage credit exhausted;
  the service stops, add credit in Railway billing) or Anthropic (the hosted key
  has no balance; runs fail with a provider billing error. Top up, or set
  `STAPLES_HOSTED_INFERENCE=off`).

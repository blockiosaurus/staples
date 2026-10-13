# Staples: Railway Trial Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Staples on Railway so a teammate can sign up in a browser, start their own company, and use the hosted Assistant and hosted agents. They need no model setup.

**Architecture:**
- (1) An opt-in instance setting lets any signed-in user create a company and become its owner.
- (2) A local dry run in `authenticated` mode with two users walks the full first-company journey and fixes what breaks.
- (3) Railway config and a short deploy guide: Dockerfile builder, health check, port, Postgres, volume, env vars, trial caps.

**Tech Stack:** TypeScript, Express + Drizzle, React 19, Docker, Railway.

## Global Constraints

- Generic product. No company-specific content. No secrets in the repo, docs or commits; examples use placeholders.
- Self-serve company creation is off by default. Existing upstream behaviour is unchanged unless the operator turns it on.
- Company-scope everything. Activity-log mutations. Keep contracts synced across db/shared/server/ui. Token-only UI.
- Never read `.env.local` or any key. Commit with explicit `git add` paths and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -f` under `.superpowers/`. Never commit `.claude/launch.json`.
- No single command longer than 4 minutes (`timeout 240`). Run single test files.

---

### Task 1: Self-serve company creation

**Files:** `server/src/config.ts`, `server/src/routes/companies.ts` (`POST /companies` admin gate ~1210), the company create service (owner membership), `packages/shared` (instance or health flags), UI (`/start` access, the post-sign-up landing, the company switcher's "New company"), tests, `doc/DEPLOYMENT-MODES.md`.

- [ ] New env `PAPERCLIP_SELF_SERVE_COMPANIES=true` (default false). It is read in config and exposed as a boolean on health (`features.selfServeCompanies`).
- [ ] When it is on and the mode is `authenticated`, any signed-in user with a verified session can call `POST /companies`. The creator becomes the company's owner, with the same membership and permissions an admin creator gets today.
  - Add a per-user limit: `PAPERCLIP_SELF_SERVE_COMPANY_LIMIT`, default 3 active companies the user owns. Return 429 or 403 with a plain message when the limit is reached.
  - Instance admins are not limited.
  - Activity-log the creation with the user actor.
- [ ] When it is off, the behaviour is unchanged (admin-only). Tests for both cases, including that a non-admin cannot read or join other users' companies.
- [ ] UI:
  - A signed-in user with no companies lands on `/start` ("Name your company").
  - The "New company" entry shows when the flag is on or the user is an admin.
  - With the flag off and no companies, the user sees a plain "Ask the person who invited you for access" screen instead of an error.
- [ ] Docs: the flag and the limit in `doc/DEPLOYMENT-MODES.md`.

### Task 2: Authenticated-mode dry run (controller-led)

- [ ] Run the dev server in `authenticated` / `private` mode on a fresh data dir. Use explicit `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_PUBLIC_URL=http://localhost:3100`, `PAPERCLIP_SELF_SERVE_COMPANIES=true`, and the hosted key mapped from `.env.local` (never printed).
- [ ] Walk the journey with screenshots:
  - claim the instance as admin;
  - sign up a second user;
  - the second user starts a company;
  - the hosted Assistant is ready;
  - the Assistant proposes a plan, and the user applies it;
  - hosted agents run;
  - Home, "What we've made" and "Update me now".
- [ ] Every break becomes a fix with a test, dispatched to an implementer. Re-run the journey after the fixes.

### Task 3: Railway config and guide

**Files:** `railway.toml` (new), `Dockerfile` (only if needed for the port or a health check), `doc/RAILWAY.md` (new), `README.md` (one link).

- [ ] `railway.toml`:
  - Dockerfile builder (default target `production`);
  - health check path `/api/health` with a sensible timeout;
  - restart policy on failure.
  - Make sure the server listens on Railway's injected `PORT`: check how `PORT=3100` in the image interacts with Railway's PORT, and fix it so either works.
- [ ] `doc/RAILWAY.md`, step by step:
  - create the project from the repo;
  - add Postgres (`DATABASE_URL` reference);
  - add a volume at `/paperclip`;
  - set the env vars, with how to generate each secret: `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, `PAPERCLIP_PUBLIC_URL`, `STAPLES_HOSTED_ANTHROPIC_API_KEY`, `PAPERCLIP_SELF_SERVE_COMPANIES`, and the trial caps;
  - deploy;
  - claim the instance before sharing the URL;
  - optionally disable sign-up after the trial users join;
  - share the URL;
  - what to expect on first boot (migrations, the slow build);
  - connector OAuth redirect URLs on the Railway domain;
  - troubleshooting: origin mismatch, missing JWT secret, cap reached, out of credit.
- [ ] Trial caps: document recommended trial values (e.g. Assistant $20, agent $20, company $100, ceiling $300) and how `STAPLES_HOSTED_INFERENCE=off` works. Don't change code defaults.
- [ ] Verify the image builds locally if feasible in the background. Report the build time and image size, or say why it wasn't run.

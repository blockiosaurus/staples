# Staples "looks like a product" pass (design)

Status: approved design (2026-10-14)
Source: items 3, 4, 7, 6, 9, 8 of `doc/plans/2026-10-14-ux-production-readiness-review.md`

## Goal

A mainstream person starting a business should see one product, named Staples, from sign-up through Home, Connectors, Settings and Costs, with no developer vocabulary in default views.

## Decisions

- Product name: **Staples**, driven by one shared constant. No white-label map.
- Logo: a typographic wordmark component and a generated letter-mark favicon. No external asset.
- Legal links: in-app `/terms` and `/privacy` placeholder pages marked "Draft", linked from sign-up and Settings.
- Feedback and docs links come from constants; a feedback link renders only when an operator sets the address.
- Rebrand scope: a full mechanical sweep of person-facing "Paperclip" strings with an exclusion list and a guard test.

## 1. Rebrand

- `packages/shared/src/branding.ts`: `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `DOCS_URL`, `FEEDBACK_URL` (env-driven, may be null), `TERMS_PATH`, `PRIVACY_PATH`.
- `ui/src/components/ProductWordmark.tsx` replaces `PaperclipLockup` everywhere; `ui/index.html` title and the document-title suffix use the constant; `ui/public/favicon.svg` and the PNG icons become a letter mark.
- Sweep: person-facing string literals and JSX text containing "Paperclip" in `ui/src/**` and in `server/src/built-ins/**`, `server/src/services/built-in-agents.ts`, `server/src/services/plan-templates.ts` and the teams catalog templates become the constant (or "Staples" in markdown instructions). Excluded: `@paperclipai/*`, `paperclip_*` and `paperclip__*` tool names, the `paperclip` skill name, `PAPERCLIP_*` env vars, API paths, CSS comments, test fixtures that assert upstream behaviour, and links to upstream docs inside Advanced-only views.
- Guard test: a vitest that greps the sweep roots for `Paperclip` outside the exclusion patterns and fails with the offending lines.
- Bump the Assistant stock version once for this pass.

## 2. Sign-up and first screen

- `Auth.tsx`: wordmark; headline "Run your business with a team of AI agents you direct"; three example lines (a candle shop, a dog-walking service, a newsletter); "Create your Staples account" / "Sign in to Staples"; no "instance" or "v1" wording; footer "By continuing you agree to the Terms and Privacy policy" with links.
- `/terms` and `/privacy`: static pages (shared layout, product name, "Draft, not yet reviewed" notice) reachable signed out.
- `StartCompanyPage`: "What's your business called?", helper "You can change this later", placeholder "Lantern Candle Co".
- Out of scope: email verification (auth library configuration).

## 3. Jargon sweep of default views

- Guard test `ui/src/__tests__/person-facing-copy.test.ts`: scans the default-view roots (`ui/src/staples/**`, `Sidebar.tsx`, `Auth.tsx`, `AgentDetail.tsx` overview, `AgentActionButtons.tsx`, `TaskChatThread.tsx` composer strings, `CompanySettings.tsx`, `Costs.tsx` overview) for string literals containing: adapter, harness, runtime, session, heartbeat, MCP, API, JSON, provider trace, lifecycle. An allowlist file names strings that live behind an Advanced disclosure.
- Fixes the test forces, at minimum: "Run with provider trace" moves into the "…" menu; "Set as my primary" becomes "Make this my main agent"; "From template: Researcher v1.2.0" becomes "Ready-made: Researcher"; "Latest Run · <hash>" becomes "Latest work"; raw model ids show a display name; skills chips render only when the Skills surface is visible; the board avatar reads "You"; the composer placeholder reads "Message <agent name>…"; "No capability summary has been added." becomes "Not described yet."

## 4. Connectors

- Sections in order: **Needed by your team** (apps in hired agents' `requiredApps` that are not connected, plus open connection requests, each with "<Agent> needs it to <purpose>"), **Popular** (app definitions flagged `featured`, grouped by their `categories`), **All** (search), and an **Advanced** toggle that holds model providers, raw API connectors (Chat Completions, Messages, Responses, Local endpoint, Bedrock), aggregators (Composio, Arcade, Executor) and the "Assistant Connection (MCP)" card.
- Descriptions of the form "Connect X's provider-hosted MCP server." render as "Let agents use X."
- The "Couldn't load your connection status" error (401 on `/api/mcp/connections` in local mode) is diagnosed and fixed.
- Curate `featured` on roughly 15 definitions: Gmail, Google Calendar, Slack, Notion, Stripe, Shopify, GitHub, Resend, beehiiv, Klaviyo, AgentMail, Linear, Vercel, Netlify, Webflow.

## 5. Settings split

- `/company/settings` (Company): name, description, logo; "Require approval for new hires"; Members; Export; Archive; the interaction governance table and decision model behind an "Advanced" disclosure.
- `/company/settings/instance/general` (Admin): deployment and auth readiness, backup retention, username censoring, AI feedback sharing, sign-out. The settings sidebar shows an "Admin" group only for instance admins.

## 6. Costs for owners

- Top of `/activity/costs`: a meter "$X of $Y this month" (company budget or hosted cap, else "no limit set"), projected month end, a per-agent list with amounts and a "Paused by limit" badge where applicable, and "Raise limit" (opens the existing raise flow).
- Everything else (API spend with token counts, subscriptions, finance ledger, billers, decisions) under a "Details" disclosure, closed by default.
- Breadcrumb "Audit" becomes "Activity".

## Testing

Component tests per task; the brand and banned-terms guard tests; `pnpm check:token-gates`; typecheck; a live walkthrough of sign-up (authenticated mode read from code), Home, Connectors, Settings and Costs.

## Delivery order

1. Branding constants, wordmark, favicon, sweep, guard test.
2. Auth, legal pages, start page.
3. Banned-terms test and the fixes it forces.
4. Connectors.
5. Settings split.
6. Costs overview.
7. Live verification.

# Staples Phase 6: Agent Templates (Marketplace Foundation) — Design

Status: approved in conversation 2026-10-11. Builds on Phases 1–5
(`doc/plans/2026-10-10-staples-adaptive-ux-design.md`).

## Goal

A person can hire a ready-made agent for a common job (email secretary,
newsletter, support triage, and so on) in one conversation. The agent
arrives with real instructions, skills, routines, the services it needs, and
safe defaults for anything it does outward. The Assistant's plans use the
same templates. This is the foundation for a later public marketplace and a
hosted SaaS with first-party inference; this phase is first-party templates
only, and it works on self-hosted instances.

## Decisions

- Launch set: Researcher, Content creator, Email secretary, Newsletter,
  Support triage, Social media manager, Website builder, Bookkeeper
  (read-only), Coding agent.
- Discovery: both a browsable marketplace page and the Assistant (interview,
  plans, and direct requests).
- Autonomy: outward actions require approval by default; per agent and per
  category, the person can switch to "send without asking". Destructive
  actions can never be put on autopilot in this phase.
- Format and install path: templates are single-agent `agentcompanies/v1`
  packages; they are installed only through the Assistant's governed
  `plans/apply` path (approach A). The existing teams-catalog import route is
  unchanged and is not used for templates.

## 1. Template format

Location: `packages/teams-catalog/catalog/staples/<slug>/`.

```
<slug>/
  TEAM.md                          # card + Staples vendor metadata
  agents/<slug>/AGENTS.md          # role, title, skills, instructions body
  skills/<skill>/SKILL.md          # template-specific skills (vendored)
  tasks/<task>/TASK.md             # recurring: true + schedule → routine;
                                   # otherwise a one-off starter task
```

TEAM.md frontmatter keeps the core spec fields (`name`, `description`,
`schema: agentcompanies/v1`, `slug`, `category`, `key`, `manager`, `includes`,
`tags`) and adds a `staples:` vendor block:

```yaml
staples:
  version: 1.0.0                  # semver
  tagline: Keeps your inbox under control
  icon: mail                      # lucide icon name
  marketplaceCategory: communication   # communication | content | operations | engineering | finance | research
  requiredApps:
    - capability: email
      anyOf: [gmail, agentmail]   # app-definition slugs
      why: Reads and drafts replies in your inbox
    - capability: calendar
      anyOf: [google-calendar]
      optional: true
      why: Suggests meeting times
  setupQuestions:                 # paperclip.question_set.v1 questions
    - id: owner_name
      prompt: What should it call you?
      answerMode: text
      initialText: "{{person.name}}"
    - id: sweep_time
      prompt: When should it sweep your inbox?
      answerMode: single_select
      options:
        - { id: "08:00", label: "8am on weekdays", recommended: true }
        - { id: "07:00", label: "7am on weekdays" }
  outwardActions:
    - category: send_email
      label: Sending email
      tools: ["gmail.send*", "agentmail.send*"]   # tool-name patterns
      default: approve
    - category: delete_email
      label: Deleting email
      tools: ["gmail.delete*", "gmail.trash*"]
      default: approve
      destructive: true
  recommendedModel: claude_local  # adapter type recommendation (optional)
  defaultBudgetMonthlyCents: 2000
```

Rules:
- Every setup question carries a recommendation (Phase 4 rule). Setup
  questions may use only the fixed context placeholders (`{{person.name}}`,
  `{{company.name}}`); the server resolves them in `staples_get_template`
  before the Assistant asks.
- `{{placeholders}}` in AGENTS.md and TASK.md bodies reference setup question
  ids (`{{answers.sweep_time}}`) or a small fixed context (`{{company.name}}`,
  `{{person.name}}`). Unknown placeholders fail validation.
- TASK.md gains an optional `schedule:` (5-field cron) plus `timezone:`
  (`person` = the person's timezone at install, or an IANA name). A recurring
  task becomes a routine; a non-recurring task becomes a starter task.
- `requiredApps[].anyOf` must name existing app-definition slugs (or a
  documented aggregator form for apps reachable only via Composio/Arcade).

## 2. Install flow

One creation path, governed:

1. **Discovery.** New Assistant read tools: `staples_list_templates` (cards)
   and `staples_get_template` (full detail incl. setup questions and access
   summary). The `staples-plan` skill prefers a template whenever one fits a
   hire.
2. **Setup.** The Assistant asks the template's `setupQuestions` with the
   existing question card (`staples_ask_questions`).
3. **Proposal.** Plan agent entries gain `templateRef` (`staples/<slug>`) and
   `templateAnswers`. When the proposal is pinned, the server resolves the
   template, validates answers, renders the instructions, and pins the
   template version. The plan card shows a compact access summary per
   templated hire.
4. **Apply.** `plans/apply`, inside its existing lease/idempotency/approval
   flow:
   - hires the agent through the real hire route with the template's role,
     title, rendered instructions, skills, recommended adapter (if usable)
     and budget;
   - imports the template's vendored skills into the company and attaches
     them to the agent;
   - creates routines from recurring tasks and starter tasks from the rest;
   - seeds per-agent tool-access rules: every `outwardActions` tool pattern
     requires approval for that agent;
   - for each required app with no usable connection, raises a connection
     request card addressed to the person; the agent's starter task is
     blocked on it and the agent is woken when the service connects;
   - records `installedTemplate { ref, version }` on the agent.
5. **Marketplace page.** "Install" opens the Assistant with a pre-filled
   request ("Set up Email secretary"); the Assistant runs steps 2–4.

## 3. Autopilot

- Outward tool calls already go through the tool gateway as approval
  requests tagged read / write / destructive; approving with "remember"
  creates a trust rule via `toolAccessPolicyService`.
- Install seeds "require approval" rules for each template outward category.
- The agent page gets an **Autopilot** panel (in the always-visible Agent
  group): one row per outward category, "Ask first" / "Send without asking".
  Switching creates or removes an allow rule scoped to that agent and that
  category's tool patterns. Categories marked `destructive: true` show
  "Always asks" with no toggle.
- Approval cards show the actual draft (email body, issue, reply) and offer
  "Always allow this" for non-destructive categories, which flips the
  category to autopilot.
- Every outward action, approved or automatic, appears in the agent's
  activity; Home's Done recently adds a per-agent daily roll-up
  ("Email secretary sent 3 emails").

## 4. Templates

| Template | Needs | Routines | Asks before |
|---|---|---|---|
| Researcher | nothing (web) | weekly market brief | — |
| Content creator | nothing; optional social/CMS | weekly content plan | publishing |
| Email secretary | Gmail or AgentMail | weekday inbox sweep + daily digest | sending, deleting (always) |
| Newsletter | Beehiiv, Resend or Klaviyo | research → draft → schedule at chosen cadence | sending to the list |
| Support triage | AgentMail/Gmail or Slack | every 2h triage + draft replies + escalate | replying to customers |
| Social media manager | X/LinkedIn via aggregator | weekly post plan, daily engagement check | posting |
| Website builder | Vercel, Netlify or Webflow | weekly site check | going live / deploying to production |
| Bookkeeper (read-only) | Stripe and/or Xero | weekly revenue + spend summary, monthly close notes | nothing outward; never moves money |
| Coding agent | GitHub or a local project workspace | daily issue triage, weekly dependency/health check | merging, pushing to the default branch, closing issues |

Each template ships real instructions with placeholders, 1–3 skills (the
Coding agent reuses `github-pr-workflow`, `issue-triage`, `qa-acceptance`
from the skills catalog), 2–4 setup questions with recommendations, and a
first-week starter task ("learn the business from the Company Brief, then
propose adjustments"). Content is generic (no company-specific material).

Social media manager, Website builder and Bookkeeper depend on connections
that may not be end-to-end ready (aggregator social apps, per-host deploy
instructions, S4 Stripe read-only scopes). They ship with honest "Needs"
lines; if a dependency is not ready, the template is marked `preview` and is
hidden from the marketplace and the Assistant until it is.

## 5. UI

- **Marketplace (`/agents/new`).** Becomes the default New Agent destination;
  the existing custom form stays as "Build your own". Card grid grouped by
  marketplace category: icon, name, tagline, "Needs: …", "Asks before: …".
  A card opens a detail sheet (what it does, routines, services and access,
  setup questions) with **Install** → Assistant hand-off.
- **Navigation.** A "Hire an agent" entry in the Agents section, shown once
  an Assistant exists.
- **Plan card.** Each templated hire shows "Email secretary · needs Gmail ·
  asks before sending · 2 routines · $20/mo".
- **Agent page.** "From template: Email secretary v1.0.0" chip and the
  Autopilot panel.
- **Home.** Connection request cards from templates appear in Needs you
  ("Connect Gmail so Email secretary can start"); autopilot roll-ups appear in
  Done recently.
- **Stage 0 / interview.** Opening chips become business examples drawn from
  templates ("An assistant for my inbox", "A weekly newsletter", "A landing
  page for my idea"); the plan skill prefers templates.

## 6. Error handling

- Unknown template, invalid answers, or a missing required answer fail at
  proposal time with a 422 and a clear message, never at apply time.
- The template version is pinned at proposal; apply uses the pinned version.
- A required app never connected leaves the agent idle with its starter task
  blocked on the connection request; Home shows it under Needs you.
- Setup answers are untrusted person-typed text: inserted into placeholders
  as plain text, length-capped, never interpreted as instructions to the
  platform.
- Templates cannot grant more than a normal hire: no extra permissions,
  no access rules looser than "require approval".

## 7. Testing

- Template validator over every shipped template: frontmatter schema,
  recommendations on every question, placeholders resolve, app slugs exist,
  cron and timezone valid, outward tool patterns well-formed.
- `plans/apply` with `templateRef`: agent + instructions + skills + routines
  + starter tasks + connection requests + access rules + `installedTemplate`;
  idempotent re-apply; version pinning; invalid answers rejected at proposal.
- Autopilot: toggling creates/removes allow rules for the agent's category
  tools only; destructive categories refused.
- UI: marketplace grid and detail sheet, Install hand-off, plan card block,
  Autopilot panel, template chip.
- End-to-end: the Assistant installs the Researcher template (no services
  needed) and its routine exists.

## Out of scope

Third-party publishing, reviews and revenue share; template updates/upgrade
flow beyond recording the version; multi-agent team templates; hosted
inference and billing.

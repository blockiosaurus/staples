---
name: staples-plan
description: Turn a finished interview into a plan (brief, goal, project, agent roles, 0 to 12 starter tasks with blocking order; 0 when a template brings its own) and propose it for the person to confirm in one card. Use right after staples-interview ends with a confirmed understanding, or to turn an agreed idea into a team and tasks.
---

# Plan

Turn what you and the person already agreed into a plan they can confirm in one step. Do **not** interview here: synthesize what you know. If an important decision is still open, go back to the `staples-interview` skill first.

## 1. Gather what exists

Before you draft, look up what the company already has so the plan builds on it instead of duplicating it:

- `staples_get_company_brief` for the current brief and its `revisionId`.
- `paperclip_list_agents` for existing agents (and their ids), `paperclip_list_projects`, `paperclip_search_tasks`.
- `staples_company_signals` for overall counts and spend.

Use the company's glossary words everywhere in the plan.

## 2. Draft the plan

**Brief** (first plan only, or when the interview changed it): the working draft from the `staples-company-brief` skill, as the whole document.

**Goal**: one outcome, written from the person's point of view. Title under 200 characters; a short description of what success looks like and how you will know.

**Project** (optional): one project that holds the starter tasks, when the work is more than a handful of tasks.

**Agents**: only the roles the work needs that no existing agent covers. Usually one to four. For each:

- `clientKey`: short lowercase id such as `writer` or `researcher` (letters, digits and dashes).
- `name`, optional `title`, and `capabilities`: one or two sentences on what this agent does and what it does not do.
- `role`: one of `cto`, `cmo`, `cfo`, `security`, `engineer`, `designer`, `pm`, `qa`, `devops`, `researcher`, `general`. **Never `ceo`**: CEO-level hires are done by the person on the Agents page.
- `adapterType`: must be one of the company's `hiring.adapterTypes` from `paperclip_connection`: the local adapters `claude_local`, `codex_local`, `cursor`, `gemini_local`, `grok_local`, `kimi_local`, `opencode_local` or `pi_local`, plus `claude_managed` (Claude hosted) only when it is listed there. When `hiring.recommendedAdapterType` is `claude_managed` (the company runs on Claude hosted; `hiring.hostedInference` true means the server provides it, under monthly spending caps), use `claude_managed` for every hire: it needs no setup on this computer. Otherwise reuse the adapter the company's existing agents use when it is in the list. In a new company (no staff agents yet), recommend the Assistant's own adapter: `paperclip_connection` returns it as `assistant.adapterType` (and as `hiring.recommendedAdapterType`), and hires on that adapter get the model connection the person already set up for you. Otherwise ask the person which of these to use, with that recommendation.
- Optional `budgetMonthlyCents` if a budget was agreed, and `reportsToClientKey` when one new agent reports to another.

**Prefer a template.** If a role matches a hireable template (`staples_list_templates`), do not design that agent: read it with `staples_get_template`, ask its setup questions, and use `clientKey`, `templateRef` and `templateAnswers` only (name, role, title and capabilities are optional and default from the template; adapterType defaults to `hiring.recommendedAdapterType`, so leave it out). Never write instructions for a templated hire. A templated agent brings its own starter tasks and routines, so a plan of only templated hires may have no tasks.

No other fields. Do not put instructions, secrets, commands or credentials in a hire.

**Tasks**: 0 to 12 starter tasks (0 when every hire is a template that brings its own; otherwise usually 3 or more), cut as **tracer bullets**:

- Each task delivers a thin but complete, visible result end to end, not one layer of the work. "Publish one short article from topic to published page" beats "write all the outlines".
- Each task can be checked on its own when done. Put a short "Done when:" list in the `description`.
- Each task fits in one working session for one agent.
- Any setup the other tasks need (accounts, templates, a style guide) comes first.

For each task: `clientKey`, `title`, `description`, an assignee (`assigneeClientKey` for a new agent in this plan, or `assigneeAgentId` for an existing agent; never the Assistant), optional `parentClientKey`, and `blockedByClientKeys`: the tasks that must finish before this one can start. A task with no blockers starts right away. Only add a blocker when it truly gates the work; false blockers slow everything down.

## 3. Check it with the person

Before proposing, show the plan in chat, compactly:

- Goal, project, and each new agent as "name: role (adapter)".
- Tasks as a numbered list, each with its assignee and "after: <titles>" for blockers.

Then ask one `staples_ask_questions` card with your recommendations, for example:

- "Does the size of the tasks feel right?" (recommend yes; other options: too big, too small)
- "Are the blockers right: each task only waits on tasks it truly needs?" (recommend yes)
- "Should I propose this plan now?" (recommend yes)

Adjust and ask again until they agree. Skip this step if the person already said "just go".

## 4. Propose it

Use `staples_propose_plan` with the whole plan and a one-sentence `summary`:

```json
{
  "summary": "Set up a two-agent content team with 5 starter tasks toward the first published article.",
  "plan": {
    "brief": { "body": "<whole brief markdown>", "baseRevisionId": null },
    "goal": { "title": "Publish one useful article every week", "description": "..." },
    "project": { "name": "Weekly articles", "description": "..." },
    "agents": [
      { "clientKey": "writer", "name": "Writer", "role": "general", "capabilities": "Drafts articles from approved outlines.", "adapterType": "claude_local" }
    ],
    "tasks": [
      { "clientKey": "style", "title": "Write a one-page style guide", "description": "Done when: ...", "assigneeClientKey": "writer", "blockedByClientKeys": [] },
      { "clientKey": "first", "title": "Publish the first article", "description": "Done when: ...", "assigneeClientKey": "writer", "blockedByClientKeys": ["style"] }
    ]
  }
}
```

- `brief.baseRevisionId` is the `revisionId` from `staples_get_company_brief`, or `null` when there is no brief yet. Leave `brief` out if it did not change.
- Nothing is created until the person confirms the card. End your turn after proposing; you are woken with the result.
- If the company requires approval for new agents, the hires stay pending until approved, and their tasks are created unassigned in the backlog, linked to the hire approval. Tell the person, and offer to assign those tasks once the hires are approved.

**If `staples_propose_plan` is not available** (older servers): propose the brief alone with `staples_propose_action` (`PUT /api/companies/<companyId>/brief`, see `staples-company-brief`), and list the goal, agents and tasks in chat as a clear plan the person can act on. Do not try to create the agents or tasks one by one yourself.

## After it is applied

Summarize what was created in two or three lines (the Assistant's instructions list what to cover) and point to the first task that can start. If a hire or task failed, say which one and why, and offer to fix it. If it stopped partway, the result names the agents already hired; proposing the same plan again reuses them instead of hiring twice.

Adapted from the to-spec and to-tickets skills in mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock).

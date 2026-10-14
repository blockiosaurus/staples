---
name: staples-interview
description: Interview a person until you both understand what they want to build or change, in rounds of question cards with a recommended answer each. Use when someone describes a new company, team, project or initiative, when a request is too vague to act on, or when they ask to be challenged on a plan.
---

# Interview

Interview the person until you reach a shared understanding of what they want. Do not plan, hire or create work while decisions are still open. When the interview is done, hand off to the `staples-plan` skill.

## The decision tree

Keep a **decision tree** in your head (or in your notes for this conversation). Each decision branches into the decisions that depend on it. For example, "what does the team produce?" comes before "which roles do we need?", which comes before "who reviews the work?".

The **frontier** is every open decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you have not heard yet. A question that depends on another open question belongs to a later round, not this one.

Typical branches for a new company or initiative (skip any that are already settled):

- The outcome: what "done" or "working" looks like, and for whom.
- Scope: what is in, and what is explicitly out.
- The work: what gets produced, how often, and to what standard.
- People and agents: which roles are needed, who reviews, who decides.
- Constraints: budget, deadlines, tools, accounts, rules that must not be broken.
- Words: terms the person uses that could mean more than one thing (see `staples-company-brief`).

## Facts are your job, decisions are theirs

Never ask the person for a fact you can look up. Before each round, check what the company already has:

- `staples_company_signals` for counts of agents, tasks, projects, approvals and spend.
- `staples_get_company_brief` for the mission, glossary and past decisions.
- `paperclip_list_agents`, `paperclip_list_projects`, `paperclip_search_tasks`, `paperclip_read_task`, `paperclip_list_skills` for what already exists.

If a lookup answers a question, treat the decision as settled and say so briefly. The person makes the decisions: put each one to them and wait.

## Rounds

Ask the whole frontier in one round, as one `staples_ask_questions` card:

- One card per round. At most 4 questions per card. If the frontier is larger, ask the 4 that unblock the most later decisions and keep the rest for the next round. A person starting a business is answering on a phone or between other things: short rounds get answered.
- Number the question ids in order: `q1`, `q2`, ... Give the card a short `title` such as "Round 2: the team".
- Every question carries your **recommendation**, worded so that answering "yes" accepts it.
  - `single_select`: mark exactly one option `recommended: true`.
  - `multi_select`: mark one or more options `recommended: true`.
  - `text`: put your suggested answer in `initialText` so the person can accept or edit it.
- Use `helpText` for one or two lines of context: why the question matters, or what you found when you looked it up.
- Allow an "other" answer with `customAnswer: { enabled: true }` when your options might not cover it.
- Set `required` on every question: `true` only when the next round cannot go ahead without it, otherwise `false`.

Only one question card can be pending at a time. After you send a card, end your turn. You are woken with the answers. Never guess the answers or ask the same thing again in plain text.

Example question (single choice):

```json
{
  "id": "q1",
  "header": "Review",
  "prompt": "Should a person approve every piece of work before it goes out?",
  "helpText": "This decides whether we add a reviewer role.",
  "required": true,
  "answerMode": "single_select",
  "options": [
    { "id": "yes", "label": "Yes, a person approves each piece first", "recommended": true },
    { "id": "spot", "label": "No, spot-check a sample each week" },
    { "id": "none", "label": "No review" }
  ],
  "customAnswer": { "enabled": true }
}
```

## After each round

1. Record the answers as settled decisions.
2. Recompute the frontier: settled decisions unblock the questions that depended on them, and answers can open new branches.
3. Update the working brief draft if a term, constraint or key decision became clear (see `staples-company-brief`).
4. Ask the next round.

If the person answers "I don't know" or "someone else knows", do not push. Mark the branch as waiting on that person and offer the `staples-questionnaire` skill. Keep going with the rest of the tree.

If the person wants to stop early, list the open decisions you would otherwise have asked and your recommended answer for each. Ask whether to proceed on those recommendations.

## When the interview is done

The interview is done only when both are true:

1. **The frontier is empty.** Every branch was visited and nothing is silently assumed.
2. **The person confirms a shared understanding.** Ask one last card with a single question, for example "Is this summary right, and should I draft the plan from it?", recommending yes. Put the summary itself in that question's `helpText`: the outcome, the scope, the work, the roles, the constraints and the key decisions, as short lines. The card is what the person sees; text you write while working is folded away, so never leave the summary only in chat.

If they correct the summary, update the tree and continue with new rounds as needed.

Once confirmed, use the `staples-plan` skill to turn the settled decisions into a plan.

## Keep it light

- Plain words. No jargon the person did not use first.
- Short questions. One idea per question.
- Do not repeat decisions that are already settled in the brief or the company's existing work.
- Small requests need small interviews: if one round settles everything, stop after one round.

Adapted from the grilling skill in mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock).

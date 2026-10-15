---
name: staples-company-brief
description: Build and keep the Company Brief (mission, glossary of terms, key decisions, constraints) that every agent reads. Use during an interview, when the person uses a vague or conflicting term, when a lasting decision is made, or when they ask to change the brief.
---

# Company Brief

The Company Brief is the short shared document every agent in the company sees. It holds the company's language and its lasting decisions. Your job is to build it actively while you talk with the person: challenge fuzzy words, test them with concrete cases, and write terms and decisions down as soon as they are settled.

Read the current brief with `staples_get_company_brief` before you change anything. It returns `null` when there is none yet.

## What goes in the brief

Use this shape. Leave out a section until there is something to put in it.

```md
# <Company name>

## Mission
One or two sentences: what the company does and for whom.

## Glossary
**Order**:
A customer's request for one or more products, placed through the shop.
_Avoid_: purchase, transaction

**Customer**:
A person or business that places orders.
_Avoid_: client, buyer, account

## Where this is going
- In 6 months: a working shop with its first repeat customers.
- In a year: a small team running it with little day-to-day input.

## Key decisions
- Every outgoing message is approved by a person first, because mistakes reach customers directly.

## Constraints
- Monthly spend stays under the agreed budget.
- No posting on social media without approval.
```

Rules:

- **Mission**: one or two sentences. No slogans.
- **Glossary**: only terms specific to this company. Define what a thing *is* in one or two sentences, not what it does. When several words mean the same thing, pick one and list the rest under `_Avoid_`. Group terms under small headings if natural groups appear.
- **Where this is going**: the person's 6-month and 1-year answers from the interview, two lines each at most. Leave it out if they skipped those questions.
- **Key decisions**: one line each, with the reason. Only record a decision when all three are true:
  1. It is hard to reverse.
  2. Someone new would be surprised by it without context.
  3. It was a real trade-off: there were real alternatives and one was chosen for a reason.
  If any of the three is missing, leave it out.
- **Constraints**: rules that are not visible from the work itself: budgets, deadlines, legal or policy limits, tools that must or must not be used.

The brief contains **no implementation chatter**: no task lists, no status updates, no meeting notes, no step-by-step instructions, no agent configuration. It is the company's language and its lasting decisions, nothing else. Keep it well under the size limit the brief tool states.

## During a conversation

### Challenge conflicting terms

When the person uses a word differently from the glossary, say so straight away: "Your brief defines 'lead' as someone who has booked a call, but you seem to mean anyone who signed up. Which is it?"

### Sharpen fuzzy words

When a word is vague or overloaded, propose one precise term: "You said 'client'. Do you mean the person who pays, or the person who uses the product? Those may be different."

### Test with concrete cases

When the person describes how things relate, invent a specific case at the edge and ask what happens: "If a customer cancels half an order after it ships, is that still one order?" This forces precise boundaries.

### Check against what exists

When the person states how the company works, look at the company's tasks, projects and agents. If something disagrees, raise it: "Your tasks treat refunds as a separate process, but you just said refunds are part of support. Which is right?"

## Keep a working draft

As terms and decisions settle, keep a working draft of the whole brief in your notes for this conversation. Update it the moment something is settled; do not batch changes up for later. You do not need to show the draft every turn, but show it when you propose it.

## Proposing the brief

Changing the brief is governed: the person confirms it on a card.

- **During the first interview** (the company has no plan yet), do not propose the brief on its own. It goes into the plan together with the goal, roles and tasks; see the `staples-plan` skill.
- **Otherwise**, propose it at natural checkpoints: when the person confirms a summary, when a topic is settled, or when they ask. Use `staples_propose_action` with method `PUT`, path `/api/companies/<companyId>/brief`, and body `{ "body": "<the whole new brief in markdown>", "baseRevisionId": "<revisionId from staples_get_company_brief>" }`. Leave `baseRevisionId` out when there is no brief yet.
- Send the whole brief, not a fragment. One proposal per topic, not one per sentence.
- Write a one-sentence `summary` for the card that says what changed, for example "Add 'order' and 'customer' to the glossary and record the review rule."

If the proposal is refused because the brief changed since you read it, read it again, merge your changes into the new text, and propose again.

Adapted from the domain-modeling skill in mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock).

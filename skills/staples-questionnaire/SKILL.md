---
name: staples-questionnaire
description: Turn a decision the person cannot answer alone into a short questionnaire for someone else to fill in, tracked as an unassigned task. Use when the person says "I don't know", "ask my co-founder", "legal would know", or when an interview branch is waiting on knowledge only another person has.
---

# Questionnaire

Some decisions need knowledge the person does not have. Instead of guessing or stalling, write a **questionnaire**: a short document the person sends to someone who knows, to fill in on their own time or together in a meeting.

**Ask about the send, not the subject.** The person cannot answer the subject; that is why you are here. Ask them only what they can always answer: who it goes to, and what they need back. The questions in the document then aim at the **gap** between what the recipient knows and what the person needs.

## Steps

### 1. Who is it going to?

Ask in one `staples_ask_questions` card: the recipient's role, what they know that the person does not, and how they relate to the company (co-founder, adviser, outside expert, customer). This sets the tone and how much context the document must carry. Offer your best guess as the recommended answer where you can.

### 2. What do you need back?

Ask in one card: the specific decisions or facts the person needs from the recipient. If this came out of an interview, recommend the open branches that were waiting on this person. You are done with this step when you have a concrete list of what the person must be able to decide afterwards.

### 3. Write the questionnaire

Draft it with the template below. Put the most important questions first: an answer by message may only get one pass. Group questions under headings by theme once there are more than five or six.

Each question:

- Covers one idea. Never two questions in one.
- Has an empty answer line under it.
- Gets a one-line *why this matters* only when it could be misread or invite a throwaway answer.

Every item from step 2 must be covered by at least one question.

### 4. Track it as a task

Show the questionnaire in chat first, then track it as a task that is **assigned to nobody**, so no agent starts working on it:

- Use `staples_propose_plan` with a single task: the title "Questionnaire: <topic>", the whole questionnaire as the `description`, no assignee and no blockers. Write a `summary` such as "Track the pricing questionnaire for the co-founder."
- If `staples_propose_plan` is not available, leave the questionnaire in chat for the person to copy and send, and say so.

Tell the person how to bring the answers back: paste them into the conversation or the task. When answers arrive, return to the interview and settle the waiting decisions.

## Template

```md
# <Questionnaire title>

**Purpose:** why this exists and the decision that depends on it.

**From:** <the person>  **To:** <the recipient>
**How your answers will be used:** <where they go, who sees them>

## Context

One short paragraph for someone who was not in the conversation. Enough to answer well, not a page.

## How to answer

When answers are needed and roughly how long it takes. Partial answers and "I don't know" are useful: mark anything you are unsure of rather than skipping it.

## <Theme>

### <One question, most important first>

_Why this matters: <only if needed>._

>

### <Next question>

>

## Anything else?

Is there anything we did not ask that we should know?
```

## Keep it short

- Aim for 5 to 15 questions. Fewer is better when they cover the need.
- Plain words. No internal jargon the recipient will not know; if a company term is needed, define it in Context.
- Never include secrets, passwords or private data about other people in the questionnaire.

Adapted from the to-questionnaire skill in mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock).

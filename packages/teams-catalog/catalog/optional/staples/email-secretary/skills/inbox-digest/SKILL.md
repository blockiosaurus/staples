---
name: inbox-digest
description: Write a short end-of-day email digest for a business owner — what still needs them, what was handled, what came in — readable in under two minutes.
slug: inbox-digest
tags:
  - email
  - digest
  - summary
---

# Inbox Digest

The digest closes the owner's working day. It answers three questions in under two minutes: what still needs me, what got handled, and is there anything I should know.

## When to use

- The daily digest routine.
- The owner asks for "a summary of today's email".

## Procedure

1. **Collect the day.** Read today's `sweep` document, the urgent tasks you created, and email that arrived after the sweep.
2. **Check what happened.** For each item that needed a reply: did the owner send it, did you send it (after approval), or is the draft still waiting? For each urgent task: is it done?
3. **Pick what still needs them.** Anything unanswered, any draft waiting with a `[confirm: ...]` gap, any approval still pending, anything due tomorrow.
4. **Write the digest** in the format below. Save it as the task document `digest`, comment with the first line of the digest, and mark the task done.

## Format

```md
# Email digest — <date>

**Still needs you (<n>):**
1. <Sender> — <subject>: <what to do>. <link to draft or task>
2. ...

**Handled today (<n>):**
- <one line each: replied to X about Y; draft for Z sent by you>

**Came in after the morning sweep (<n>):**
- <Sender> — <subject>: <one line>

**Worth knowing:**
- <Optional: a pattern, e.g. "Three customers asked about delivery times this week — worth a line on the website?">

<Totals: n emails today, n need you, n handled.>
```

## Rules

- Lead with what still needs them. If nothing does, say "Nothing needs you tonight." first.
- At most 7 items under "Still needs you". If there are more, list the 7 most important and say how many others there are.
- One line per item. Name the sender and subject; never paste whole emails.
- Gmail drafts: say "draft waiting in your Gmail". AgentMail: say whether it was sent or is waiting for approval.
- Point out patterns only when they suggest a useful action, and say what you recommend.
- Quiet day: keep it to two lines.

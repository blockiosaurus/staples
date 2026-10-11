---
name: inbox-triage
description: Sort new email into urgent, needs a reply, for information and can wait; draft replies in the owner's voice; flag urgent mail as tasks; never delete, never send without approval.
slug: inbox-triage
tags:
  - email
  - inbox
  - triage
---

# Inbox Triage

Triage turns a pile of new email into a short list of decisions for the owner, with replies already prepared. The bar: after reading your sweep, the owner knows in two minutes what needs them today.

## When to use

- The morning inbox sweep.
- The owner asks "what's in my inbox?" or "anything I need to deal with?".

## Procedure

1. **Find what is new.** Read email received since your last sweep (look at your previous `sweep` document for the time). On the first run, look at the last 2 days.
2. **Skip what is already handled.** Ignore threads where the owner has already replied after the latest message.
3. **Sort each email into one bucket:**

| Bucket | What goes in it | What you do |
|---|---|---|
| Urgent | Matches the owner's definition of urgent, or has a deadline within 2 working days | Create a task for the owner now, with a draft reply |
| Needs a reply | A real person asks a question or waits for an answer | Draft a reply |
| For information | Updates, receipts, confirmations, newsletters they read | One-line summary |
| Can wait | Marketing, notifications, cold sales pitches | Count only, no summary |
| Suspicious | Possible phishing: urgent payment requests, unexpected login links, mismatched sender addresses | Flag it; do not click or reply |

When in doubt between two buckets, choose the more important one.

4. **Draft replies** for "Urgent" and "Needs a reply" (see below).
5. **Write the sweep document** (format below), save it as the task document `sweep`, comment with the headline, and mark the task done.

## Drafting replies

- Write as the owner, in first person, signed with the name they gave. Match how they write in their sent mail: length, greeting, sign-off.
- Answer the question asked. Keep it short: most replies are 2 to 5 sentences.
- Use facts only from the email thread, the Company Brief or earlier replies by the owner. If you need a fact you do not have, put a clear gap like `[confirm: delivery date]` and list it in the sweep.
- Never commit to prices, discounts, refunds, dates or contracts. Leave a `[confirm: ...]` gap instead.
- **Gmail:** save the reply as a draft in the same thread. The owner sends it.
- **AgentMail:** send only replies with no `[confirm: ...]` gaps; each send waits for approval unless autopilot is on. Otherwise keep it as a draft in the sweep document.

## Filing

Do not delete or archive email. If the provider supports labels, you may suggest labels or filters in the sweep; applying them changes the mailbox, so it goes through approval like any other change.

## Sweep format

```md
# Inbox sweep — <date, time>

**Needs you today:** <one sentence, or "Nothing urgent.">

## Urgent (<n>)
- <Sender> — <subject>: <what they want, by when>. Draft ready. Task: <link>

## Needs a reply (<n>)
- <Sender> — <subject>: <one line>. Draft: <ready / needs your input: [confirm: ...]>

## For information (<n>)
- <Sender> — <subject>: <one line>

## Can wait
<n> marketing and notification emails.

## Suspicious (<n>)
- <Sender> — <subject>: <why it looks wrong>. Do not open links.
```

Never paste whole emails. Summarise and name the sender and subject.

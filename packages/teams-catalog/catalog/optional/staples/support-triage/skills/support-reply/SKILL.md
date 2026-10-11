---
name: support-reply
description: Triage customer support messages and draft replies — sort by urgency and type, answer only from known facts (FAQ, Company Brief, the owner), match the chosen tone, and escalate money, complaints and anything uncertain.
slug: support-reply
tags:
  - support
  - customer-service
  - writing
---

# Support Reply

Every customer message deserves an answer that is correct, kind and short. This skill covers sorting new messages and drafting replies. The bar: the customer knows exactly what happens next after reading your reply.

## Procedure for each sweep

1. **Collect new messages** since the last sweep (see the previous `triage` document for the time). Skip threads where someone from the business has already replied after the customer's latest message.
2. **Sort each message:**

| Type | Examples | Action |
|---|---|---|
| Simple question | Opening hours, delivery times, how to use the product | Answer from the FAQ or Company Brief |
| Order or account issue | Where is my order, wrong item, cannot log in | Answer what you can; escalate if it needs an action you cannot take |
| Money | Refund, charge, discount request, dispute | Escalate with a suggested reply |
| Complaint | Unhappy, angry, threatening a bad review | Escalate with a suggested reply |
| Sensitive | Legal, safety, personal data, press | Escalate at high priority |
| Not support | Sales pitches, spam, partnerships | List in the triage document; do not reply |

3. **Set urgency:** "now" (money, safety, angry customer, a deadline today), "today", or "can wait".
4. **Draft replies** (below) and **escalate** what needs it (see the agent instructions for what to include).
5. **Write the triage document** (format below), save it as `triage`, comment with the headline, and mark the task done.

## Writing a reply

1. **Thank or acknowledge** in one short line. Use their first name.
2. **Answer the question** directly, in the first two sentences.
3. **Say what happens next** and when, only if you know it.
4. **Close** with a simple offer of more help and the business's name.

Keep it to 3 to 6 sentences. One question per reply at most.

- **Warm:** friendly, reassuring, contractions, "we" and "you". Show you understand before you explain.
- **Concise:** polite and direct. Answer first, no small talk, still never cold.

## Facts

- Use only facts from the `faq` document, the Company Brief, or answers the owner gave.
- If a fact is missing, do not guess. Escalate, or reply that you are checking and will come back (only if that is allowed by the owner's rules).
- Never promise refunds, discounts, compensation, replacements or dates. Write "I've passed this to <name>, who will get back to you" instead, and escalate.

## Sending

- **Gmail:** save the reply as a draft in the same thread.
- **AgentMail or Slack:** send the reply; it waits for approval unless autopilot is on for replying to customers.
- Never delete or archive messages.

## Triage format

```md
# Support triage — <date, time>

**Headline:** <n> new, <n> answered, <n> escalated. <Anything urgent in one line.>

## Escalated (<n>)
- <Customer first name> — <type>, <urgency>: <one line>. Task: <link>

## Answered (<n>)
- <Customer first name> — <one line question> → <one line answer>. <Sent / waiting for approval / draft in Gmail>

## Not support (<n>)
- <one line each>

## New FAQ candidates
- <A question that came up and is not in the FAQ yet>
```

Never paste whole messages or personal details (addresses, phone numbers, payment details).

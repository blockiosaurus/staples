---
name: support-faq
description: Build and maintain a support FAQ from real customer messages — group repeated questions, write short confirmed answers in the business's words, mark unconfirmed answers, and keep it current.
slug: support-faq
tags:
  - support
  - faq
  - knowledge-base
---

# Support FAQ

The FAQ is the support assistant's source of truth: short, confirmed answers to the questions customers really ask. Every answer in it can be sent to a customer without checking again.

## When to use

- Building the first FAQ from past support messages.
- After each sweep, when "New FAQ candidates" appear.
- When the owner answers a question you asked.

## Building the first FAQ

1. **Read past support messages:** the last 30 days, or the last 200 messages, whichever is fewer. Only support-like messages: the dedicated support address, label or channel if there is one, otherwise customer messages about the business's products, orders or service.
2. **Group them** by what the customer really wants to know, not by their exact words. "Where's my parcel?" and "Has my order shipped?" are the same question.
3. **Count** how often each group comes up. Keep groups that appear at least twice.
4. **Write one entry per group** (format below), most frequent first.
5. **Find the answer** in the Company Brief or in how the business already replied. If the business's past replies disagree, or there is no answer, mark the entry "Needs your answer" with your suggested answer.
6. **Save** as the task document `faq`, then ask the owner to confirm the "Needs your answer" entries in one question card, each with your suggested answer as the starting text.

## Entry format

```md
## <The question, in the customer's plain words>
**Answer:** <2-4 sentences, in the business's words>
**Status:** Confirmed | Needs your answer
**Asked:** <how often, e.g. "about 12 times in 30 days">
**Escalate when:** <optional: when this question needs a person, e.g. "the order is more than 10 days late">
```

## Rules

- Only "Confirmed" answers may be sent to customers without escalating.
- An answer is confirmed when it comes from the Company Brief or the owner said it is right.
- Use the Company Brief's words for products, orders and policies.
- No promises beyond the business's stated policy. Policies on refunds and returns are quoted exactly.
- Keep each answer short. Link to a page on the business's website if one explains more.
- Never include customer names or personal details in the FAQ.

## Keeping it current

- After each sweep, add new candidates that appeared twice or more, as "Needs your answer".
- When a policy or product changes, update every affected entry and note the date at the top.
- Remove entries nobody has asked about in 90 days, unless they cover money or safety.
- Put a "Last updated" date and a count of entries at the top of the document.

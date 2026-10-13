---
name: Build a FAQ from past support messages
slug: build-the-faq
assignee: support-triage
project: support
---

Build the first support FAQ for {{company.name}} with the `support-faq` skill.

If the inbox is not connected yet, wait: work your "Connect <service>" task first, then come back to this one.

What {{person.name}} said customers buy and ask about: {{answers.product}}

1. Read the last 30 days of support messages (or the last 200, whichever is fewer), and the Company Brief. Only read support-like messages: the dedicated support address, label or channel if there is one, otherwise messages from customers about the business's products, orders or service. Skip personal and unrelated email.
2. Group repeated questions, count them, and write one FAQ entry per group, most frequent first.
3. Mark each entry "Confirmed" (the answer is in the Company Brief or in replies the business already sent consistently) or "Needs your answer" (with your suggested answer).
4. Save it as this task's `faq` document.
5. Ask {{person.name}} to confirm the "Needs your answer" entries in one question card: one text question per entry, with your suggested answer as the starting text. Ask at most 8 at a time, most frequent first.
6. Comment with a short summary (how many questions, how many confirmed) and a link to the document, then set this task to `in_review` while you wait.

When they answer, update the FAQ and mark this task done. From then on, use the FAQ in every triage run.

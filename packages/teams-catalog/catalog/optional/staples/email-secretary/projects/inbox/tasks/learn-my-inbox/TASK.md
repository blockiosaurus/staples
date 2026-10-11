---
name: "Learn my inbox: summarize the last 2 weeks and propose filing rules"
slug: learn-my-inbox
assignee: email-secretary
project: inbox
---

Get to know how {{answers.callMe}}'s inbox works, so your sweeps and drafts fit from day one.

If email is not connected yet, wait: work your "Connect <service>" task first, then come back to this one.

1. Read the last 2 weeks of email, including what {{answers.callMe}} sent.
2. Write a task document `report` with:
   - "Who writes to you": the main groups of senders (customers, suppliers, team, services, newsletters), with rough counts.
   - "What needs you": the kinds of email that need their reply, and how quickly they usually answer.
   - "How you write": their usual greeting, length and sign-off, so your drafts sound like them.
   - "Urgent, by your definition": examples from the last 2 weeks that match "{{answers.urgent}}", and anything you think should be added.
   - "Proposed filing rules": three to six simple rules, for example "Receipts from suppliers → label Receipts". Do not apply them; they change the mailbox.
   - "Still open": up to 5 emails from the last 2 weeks that seem to be waiting for a reply.
3. Ask {{person.name}} in one question card:
   - Which filing rules to use (multiple choice, with the ones you recommend marked).
   - Whether your summary of urgent email is right (recommended: "Yes").
4. Set your schedule. Your "Morning inbox sweep" routine runs at 8:00 on weekdays. They chose {{answers.sweepTime}}. If that is not 8am, change the routine's schedule trigger to the same minute at the chosen hour (7am is cron `0 7 * * 1-5`, 9am is `0 9 * * 1-5`), keeping the time zone. If you cannot change it, tell them they can do it on the Routines page.
5. Comment with a short summary and a link to the document, then set this task to `in_review` while you wait.

When they answer, apply the chosen filing rules only if the email service supports it (each change waits for approval unless autopilot is on), note the decisions in the document, and mark this task done.

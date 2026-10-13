---
name: Daily digest
slug: daily-digest
assignee: email-secretary
project: inbox
recurring: true
schedule: "0 17 * * 1-5"
timezone: person
---

Write today's email digest for {{answers.callMe}} with the `inbox-digest` skill.

1. Read today's `sweep` document, the urgent tasks you created today, and email that arrived after the sweep.
2. Check which replies were sent and which drafts or approvals are still waiting.
3. Save the digest as this task's `digest` document. Lead with what still needs them.
4. Comment with the digest's first line and a link to the document, then mark this task done.

If email is not connected yet, comment that the digest is waiting for the connection and mark this task done.

This routine runs at 17:00 on weekdays. {{person.name}} can change the schedule on the Routines page.

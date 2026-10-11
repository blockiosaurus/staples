---
name: Morning inbox sweep
slug: morning-inbox-sweep
assignee: email-secretary
project: inbox
recurring: true
schedule: "0 8 * * 1-5"
timezone: person
---

Sweep the inbox for {{answers.callMe}} with the `inbox-triage` skill.

- What counts as urgent: {{answers.urgent}}

Steps:

1. Read email received since your last sweep (the last 2 days if this is the first one).
2. Sort it, draft replies, and create a task straight away for anything urgent.
3. With Gmail, save replies as drafts for {{answers.callMe}} to send. With AgentMail, send only complete replies; each one waits for approval unless autopilot is on for sending email.
4. Save the result as this task's `sweep` document. Do not delete or archive anything.
5. Comment with one or two sentences on what needs them today and a link to the document, then mark this task done.

If email is not connected yet, comment that the sweep is waiting for the connection and mark this task done.

This routine runs at 8:00 on weekdays by default. {{person.name}} chose {{answers.sweepTime}}; the schedule can be changed on the Routines page.

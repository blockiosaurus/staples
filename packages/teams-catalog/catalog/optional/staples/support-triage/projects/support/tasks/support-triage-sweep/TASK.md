---
name: Support triage
slug: support-triage-sweep
assignee: support-triage
project: support
recurring: true
schedule: "0 */2 * * *"
timezone: person
---

Check for new customer messages and handle them with the `support-reply` skill.

- Tone: {{answers.tone}}
- Escalate to: {{answers.escalation}}

Steps:

1. Read messages that arrived since your last triage. If there are none, comment "Nothing new." and mark this task done.
2. Sort each message, draft replies from the `faq` document and the Company Brief, and escalate money, complaints and anything you cannot answer with a task for {{answers.escalation}}.
3. With Gmail, save replies as drafts for a person to send. With AgentMail or Slack, send each reply; it waits for {{person.name}}'s approval unless autopilot is on for replying to customers.
4. Save the result as this task's `triage` document, including new FAQ candidates.
5. Comment with the headline (new, answered, escalated) and a link to the document, then mark this task done.

If the inbox is not connected yet, comment that triage is waiting for the connection and mark this task done.

This routine runs every two hours. {{person.name}} can change the schedule on the Routines page.

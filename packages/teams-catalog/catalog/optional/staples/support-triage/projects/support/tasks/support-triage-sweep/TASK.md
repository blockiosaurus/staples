---
name: Support triage
slug: support-triage-sweep
assignee: support-triage
project: support
recurring: true
schedule: "0 8-18/2 * * 1-5"
timezone: person
---

Check for new customer messages and handle them with the `support-reply` skill.

- Tone: {{answers.tone}}
- Escalate to: {{answers.escalation}}

Steps:

1. Read messages that arrived since your last triage. Only look at support-like messages: the dedicated support address, label or channel if there is one, otherwise messages from customers about the business's products, orders or service. Leave personal and unrelated email alone. If there are none, comment "Nothing new." and mark this task done.
2. Sort each message, draft replies from the `faq` document and the Company Brief, and escalate money, complaints and anything you cannot answer with a task for {{answers.escalation}}.
3. With Gmail, save replies as drafts for a person to send. With AgentMail or Slack, send each reply; it waits for {{person.name}}'s approval unless autopilot is on for replying to customers.
4. Save the result as this task's `triage` document, including new FAQ candidates.
5. Comment with the headline (new, answered, escalated) and a link to the document, then mark this task done.

If the inbox is not connected yet, comment that triage is waiting for the connection and mark this task done.

This routine runs every two hours from 8:00 to 18:00 on weekdays. {{person.name}} can change the schedule on the Routines page, for example to cover weekends.

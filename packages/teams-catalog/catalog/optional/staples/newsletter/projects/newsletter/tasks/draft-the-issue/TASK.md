---
name: Research and draft the issue
slug: draft-the-issue
assignee: newsletter-editor
project: newsletter
recurring: true
schedule: "0 9 * * 0"
timezone: person
---

Research and draft the next newsletter issue with the `newsletter-issue` skill.

- What it is about: {{answers.topic}}
- How often: {{answers.cadence}}

Steps:

1. Check whether an issue is due this week for this cadence, using the `issue-log` document. If not, comment one line saying when the next one is due, and mark this task done.
2. Read the Company Brief, the newsletter `plan` and the `issue-log`.
3. Gather ideas, choose two to four items, and write the issue with three subject line options.
4. Save it as this task's `issue` document.
5. Comment with the recommended subject line and a link to the document. If any facts need confirming, ask them in one question card with your recommended answers and set this task to `in_review`; otherwise mark it done.

This routine runs at 9:00 two days before the send day ({{answers.sendDay}}). {{person.name}} can change the schedule on the Routines page.

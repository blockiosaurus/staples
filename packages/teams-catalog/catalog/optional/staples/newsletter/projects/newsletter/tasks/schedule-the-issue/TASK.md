---
name: Schedule the issue
slug: schedule-the-issue
assignee: newsletter-editor
project: newsletter
recurring: true
schedule: "0 9 * * 2"
timezone: person
---

Schedule this period's newsletter issue with the `newsletter-sending` skill.

Steps:

1. Check whether an issue is due this week (cadence: {{answers.cadence}}). If not, comment one line and mark this task done.
2. Find the latest `issue` document. If it is missing or still has facts to confirm, comment what is missing and set this task to `in_review`.
3. Create the issue in the newsletter service, send a test to {{person.name}} if possible, and schedule it for 10:00 today. Scheduling waits for {{person.name}}'s approval unless autopilot is on for sending to the list.
4. Comment with the subject line, the audience, the scheduled time and whether a test was sent. Add the issue to the `issue-log`.
5. Mark this task done once the schedule is approved, or set it to `in_review` while the approval is pending.

If the newsletter service is not connected, deliver the final issue as a document for {{person.name}} to paste into their own tool, and say so.

This routine runs on Tuesdays at 9:00 by default. {{person.name}} chose {{answers.sendDay}}; the schedule can be changed on the Routines page.

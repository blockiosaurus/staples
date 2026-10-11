---
name: Propose a name, format and first 3 issue outlines
slug: plan-the-newsletter
assignee: newsletter-editor
project: newsletter
---

Set up the newsletter for {{company.name}}.

- What it is about: {{answers.topic}}
- How often: {{answers.cadence}}
- Send day: {{answers.sendDay}}

1. Read the Company Brief: what the business offers, to whom, and how it talks.
2. If the newsletter service is connected, look at any issues already sent, so you build on what exists instead of starting over.
3. Write a task document `plan` with:
   - "Name": three name ideas, your recommended one first, each with one line on why.
   - "Format": the sections every issue has (for example: one tip, one story, one offer), length, and the voice.
   - "First three issues": an outline of each, with a working subject line and two to four items.
   - "What I need from you": facts, offers or dates the first issues depend on.
4. Create an empty `issue-log` document on this task, with a one-line heading. You will add a line for every issue sent.
5. Set your schedule. Your routines are "Research and draft the issue" (Sundays at 9:00) and "Schedule the issue" (Tuesdays at 9:00). If the send day is not Tuesday, move them: for Thursday, draft on Tuesdays (cron `0 9 * * 2`) and schedule on Thursdays (cron `0 9 * * 4`), keeping the time zone. If you cannot change them, tell {{person.name}} they can do it on the Routines page.
6. Ask {{person.name}} in one question card: which name (single choice, your recommendation marked), whether the format works (recommended: "Yes"), and the facts you need, each with your best guess as the starting text.
7. Comment with a short summary and a link to the plan, then set this task to `in_review` while you wait.

When they answer, update the `plan` document and mark this task done.

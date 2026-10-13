---
name: staples-weekly-update
description: Write the company's weekly update (what shipped, what's blocked and what you need from the person, spend against budget, next week) from read-only tools, and save it with staples_save_weekly_update. Use when the weekly update routine wakes you (on its Monday schedule, or when the person presses Update me now on Home).
---

# Weekly update

Once a week you tell the people running the company how the week went, in a few short lines they can read on Home. You only read, then save the update. Nothing else changes.

## 1. Read

Use your read tools; never guess.

- `staples_get_briefing`: what needs the person, what is in progress, what finished in the last 7 days, and this month's spend against the company budget and the hosted limit.
- `paperclip_search_tasks` with status `done`, and `paperclip_list_deliverables` on the finished tasks: what shipped and what was made.
- `staples_company_signals`: how many agents, tasks and approvals there are.

If a read fails, say in the update what you could not check.

## 2. Write

At most about 300 words, in plain language, as Markdown. Use these four headings, in this order, and keep each to a few bullets:

- **What shipped**: finished tasks and deliverables, each with a link. Name tasks by title, never by id alone.
- **Blocked and what I need from you**: each blocked task or open decision, and the one thing the person can do about it, with a link. Write "Nothing is blocked." when that is true.
- **Spend**: this month's spend against the budget, for example "$12.40 of $50.00 this month". When there is no budget, say so and give the spend.
- **Next week**: what is queued or in progress, and what you expect to finish.

Do not add a title: the update is saved as "Weekly update — <date>". Do not invent progress; a quiet week gets a short update.

## 3. Save

Call `staples_save_weekly_update` with the Markdown as `body`. The server saves it as the document "Weekly update — <date>" on the company's "Weekly updates" task; you do not choose the task. Saving again the same day replaces that day's update.

If the result has `timezoneKnown: false`, add this last line and save again: "Dates use UTC because I don't know your time zone yet."

The save also closes the routine's task: end your run. Do not comment, create tasks, answer questions or propose actions in that run.

The save works only in the weekly update routine's run. In a chat it is refused: a chat reads with the person's own access, which can include private tasks, and the update is shown to the whole company. If the person asks in chat for an update now, tell them to press "Update me now" on Home.

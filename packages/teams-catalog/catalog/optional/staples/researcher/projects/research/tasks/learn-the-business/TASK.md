---
name: Learn the business from the Company Brief and propose 3 research questions
slug: learn-the-business
assignee: researcher
project: research
---

Get to know {{company.name}} and agree on what to research first.

1. Read the Company Brief carefully: what the business sells, to whom, its words for things, and its constraints.
2. Do a first quick scan of the market around this focus: {{answers.focus}}. Note the main competitors, customer groups and trends you find, with sources.
3. Write a task document `report` with:
   - "What I understood": the business in three or four sentences, in the Company Brief's words.
   - "Who you compete with": a short list, each with one line and a source.
   - "Three research questions": three questions you recommend investigating first. For each, say why it matters to {{company.name}} and what decision it could help with.
   - "Gaps in the Company Brief": anything missing or unclear that would help your research (leave this out if nothing).
4. Ask {{person.name}} which questions to start with, using one question card: a multiple-choice question listing the three questions, with your top one or two marked as recommended.
5. Set your schedule. Your "Weekly market brief" routine runs on Mondays at 9:00. {{person.name}} chose {{answers.reportDay}}. If that is not Monday, change the routine's schedule trigger to the same time on that day (Friday is cron `0 9 * * 5`), keeping the time zone. If you cannot change it, tell {{person.name}} they can do it on the Routines page.
6. Comment with a short summary and a link to the document, then set this task to `in_review` while you wait for their answer.

When they answer, create one task per chosen question, assigned to yourself, and mark this task done.

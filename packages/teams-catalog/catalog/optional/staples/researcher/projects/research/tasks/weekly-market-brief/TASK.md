---
name: Weekly market brief
slug: weekly-market-brief
assignee: researcher
project: research
recurring: true
schedule: "0 9 * * 1"
timezone: person
---

Write this week's market brief for {{person.name}} using the `market-brief` skill.

- What to watch: {{answers.focus}}
- How detailed: {{answers.depth}}

Steps:

1. Read the Company Brief and your previous `brief` document, so you do not repeat yourself.
2. Research the last 7 days (14 days if this is the first brief). Cite every claim, following the `research-sources` skill.
3. Save the brief as this task's `brief` document.
4. Comment with a two to four sentence summary and a link to the document, then mark this task done.

If you find something urgent, also create a separate task for {{person.name}} with your recommended next step.

This routine runs every Monday at 9:00 by default. {{person.name}} chose {{answers.reportDay}}; the schedule can be changed on the Routines page.

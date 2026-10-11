---
name: Weekly content plan
slug: weekly-content-plan
assignee: content-creator
project: content
recurring: true
schedule: "0 9 * * 1"
timezone: person
---

Plan and draft this week's posts for {{company.name}}.

- Audience: {{answers.audience}}
- Tone: {{answers.tone}}
- How often: {{answers.cadence}}

Steps:

1. Read the Company Brief and the latest `content-calendar` document. If there is no calendar yet, make one first with the `content-calendar-planning` skill.
2. Pick this week's posts from the calendar to match the chosen frequency. Add anything timely: news, launches, or questions customers asked.
3. Draft every post with the `post-writing` skill. List any facts you need confirmed.
4. Save the plan and drafts as this task's `content-plan` document, and roll the calendar forward one week.
5. If a social account or the website is connected, publish each post on its planned day. Each post waits for {{person.name}}'s approval unless autopilot is on for publishing. If nothing is connected, say the drafts are ready to copy and post.
6. Comment with a two to four sentence summary and a link to the document. Mark this task done when every post is published, or when the drafts are ready for {{person.name}} to post.

If you need facts confirmed, ask them in one question card with your recommended answers, and set this task to `in_review` while you wait.

This routine runs every Monday at 9:00. {{person.name}} can change the schedule on the Routines page.

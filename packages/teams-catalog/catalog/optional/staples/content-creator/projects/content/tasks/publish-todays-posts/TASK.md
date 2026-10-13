---
name: Publish today's posts
slug: publish-todays-posts
assignee: content-creator
project: content
recurring: true
schedule: "0 10 * * 1-5"
timezone: person
---

Publish the posts planned for today, and nothing else.

1. Open this week's `content-plan` document and find the posts planned for today that are marked "queued". If there are none, comment "Nothing to publish today." and mark this task done.
2. If the service for a post is not connected, skip it: its draft is already ready for {{person.name}} to copy and post.
3. Check each post once more with the `post-writing` skill. If it still has facts to confirm, do not publish it; mention it in your comment.
4. Publish each remaining post. Each one waits for {{person.name}}'s approval unless autopilot is on for publishing. Never publish a post planned for another day.
5. In the `content-plan` document, mark each post "published" with its link, or "waiting for approval".
6. Comment with one or two sentences on what went out and what is waiting, then mark this task done. If approvals are still pending, set it to `in_review` instead.

This routine runs at 10:00 on weekdays. {{person.name}} can change the schedule on the Routines page.

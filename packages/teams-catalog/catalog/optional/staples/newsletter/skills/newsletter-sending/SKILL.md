---
name: newsletter-sending
description: Put an approved-ready newsletter issue into Beehiiv, Resend or Klaviyo, send a test, pick the right list, and schedule it — with the send itself waiting for the owner's approval.
slug: newsletter-sending
tags:
  - newsletter
  - email-marketing
  - scheduling
---

# Newsletter Sending

Getting an issue from a draft to subscribers' inboxes safely. Mistakes here reach every subscriber at once, so go slowly and check everything.

## When to use

- The "Schedule the issue" routine on send day, when this period's issue is drafted.
- The owner asks you to send a special issue.

## Before you start

1. Find this period's `issue` document. If there is none, or it still has "Facts to confirm", do not schedule. Comment what is missing, and set the task to `in_review` with a question card if the owner needs to answer something.
2. Check that the newsletter service is connected. If it is not, deliver the final issue as a document the owner can paste into their tool, and say so.

## Procedure

1. **Create the issue in the service** as a draft (this changes the service, so it may wait for approval):
   - Beehiiv: a new post, sent as an email to subscribers.
   - Resend: a broadcast to the newsletter audience.
   - Klaviyo: an email campaign to the newsletter list.
   Use the recommended subject line and the preview text. Keep the service's own footer and unsubscribe link.
2. **Choose the audience.** Use the list or audience the owner normally sends to. If there are several and you are not sure which, ask with your recommendation before going further.
3. **Send a test** to the owner only if the service has a test send that goes to them alone and never to the list. If it does not, skip this step and say so in your comment. Never send to the list as a test.
4. **Schedule** for 10:00 on the send day in the owner's time zone. If that time has already passed, schedule for the next full hour. Scheduling is the step that waits for the owner's approval, unless autopilot is on for sending to the list.
5. **Report.** Comment with: subject line, audience and size if known, scheduled time, and "test email sent" if you sent one. Then mark the task done once the schedule is approved, or set it to `in_review` while the approval is pending.
6. **Log it.** Add the issue to the `issue-log` document.

## If something goes wrong

- Approval declined: do not retry with different wording. Ask what to change, update the draft, and try again only after they answer.
- Service error: do not retry more than once. Describe the error in plain words in your comment and leave the draft in the service.
- Never delete a sent issue, a list or subscribers. Never resend an issue that has already gone out.

## Never

- Add, remove or import subscribers.
- Change list settings, sender address or sending domain.
- Remove the unsubscribe link.

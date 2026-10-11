---
name: Email secretary
description: Sorts your inbox every morning, drafts replies in your voice, flags what is urgent, and sends you a short end-of-day digest.
schema: agentcompanies/v1
slug: email-secretary
category: staples
key: paperclipai/optional/staples/email-secretary
manager: agents/email-secretary/AGENTS.md
includes:
  - skills/inbox-triage/SKILL.md
  - skills/inbox-digest/SKILL.md
  - projects/inbox/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - solo-founder
  - agency
tags:
  - email
  - inbox
  - assistant
  - communication
---

# Email secretary

A secretary who keeps your inbox under control, so the important messages get your attention and the rest get handled.

## What it does

- Every weekday morning, sorts new email: what is urgent, what needs your reply, what is just for information, and what can wait.
- Drafts replies in your voice for the messages that need one.
- Every weekday at 5pm, sends you a short digest of the day: what came in, what was handled, and what still needs you.
- Optionally checks your Google Calendar when an email asks for a meeting, and suggests times.

## What it needs

An email account: Gmail or AgentMail.

- **With Gmail**, it prepares drafts in your Gmail for you to read and send yourself. Sending from Gmail is not available on this platform.
- **With AgentMail**, it can send replies itself, after you approve each one (or automatically, if you turn on autopilot for sending email).

## What it will never do

It never sends anything without your approval unless you turn on autopilot for sending. It never deletes email; deleting always needs your approval, even on autopilot. It never makes commitments for you (prices, dates, contracts) that you have not confirmed.

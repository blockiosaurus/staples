---
name: Support triage
description: Checks your support inbox every two hours, sorts customer messages, drafts friendly answers, and passes anything tricky to the right person.
schema: agentcompanies/v1
slug: support-triage
category: staples
key: paperclipai/optional/staples/support-triage
manager: agents/support-triage/AGENTS.md
includes:
  - skills/support-reply/SKILL.md
  - skills/support-faq/SKILL.md
  - projects/support/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - ecommerce
  - startup
tags:
  - support
  - customer-service
  - inbox
  - communication
---

# Support triage

A support assistant who makes sure every customer gets a quick, accurate answer, and that problems reach the right person.

## What it does

- Every two hours, checks for new customer messages and sorts them: simple questions, problems, complaints, and anything urgent.
- Drafts answers in your tone, using your FAQ and Company Brief.
- Passes refunds, complaints and anything it cannot answer to the person you name, with a summary and a suggested reply.
- Builds and keeps up an FAQ from the questions customers actually ask.

## What it needs

Somewhere customer messages arrive: an AgentMail inbox, Gmail, or Slack.

- **With Gmail**, it prepares replies as drafts for you to send. Sending from Gmail is not available on this platform.
- **With AgentMail or Slack**, it can reply itself, after you approve each reply (or automatically, if you turn on autopilot for replying to customers).

## What it will never do

It never replies to a customer without your approval unless you turn on autopilot for replies. It never promises refunds, discounts or compensation, never deletes messages, and never shares one customer's details with another.

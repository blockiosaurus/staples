---
name: Bookkeeper
description: Reads your Stripe payments (and optionally Xero) to send a plain weekly summary of revenue and spending, monthly close notes, and early warnings about anything unusual. Strictly read-only.
schema: agentcompanies/v1
slug: bookkeeper
category: staples
key: paperclipai/optional/staples/bookkeeper
manager: agents/bookkeeper/AGENTS.md
includes:
  - skills/revenue-spend-summary/SKILL.md
  - skills/month-close-notes/SKILL.md
  - projects/books/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - ecommerce
  - solo-founder
tags:
  - finance
  - bookkeeping
  - revenue
  - reporting
---

# Bookkeeper

A bookkeeper who keeps an eye on the numbers, so you always know how the business is doing without opening a dashboard.

## What it does

- Every week, on the day you choose, sends a short summary: revenue, refunds, fees, payouts, and what the business spent on AI work.
- On the first of every month, writes close notes for the month before: totals, changes from last month, and anything to tidy up.
- Flags anything unusual (a spike in refunds, a failed payout, a disputed payment) as soon as it sees it, with where it found it.

## What it needs

A Stripe account. Xero is optional and adds invoices, bills and bank transactions.

## What it will never do

It only reads. It never creates charges, refunds, payouts, transfers, invoices or payment links, never sends anything to your customers, and never changes anything in Stripe or Xero. It is not an accountant: it reports numbers and flags questions, and leaves tax and accounting decisions to you and your accountant.

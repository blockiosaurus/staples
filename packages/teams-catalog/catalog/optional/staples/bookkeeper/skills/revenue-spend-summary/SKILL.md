---
name: revenue-spend-summary
description: Read-only weekly summary of a small business's revenue (payments, refunds, disputes, fees, payouts) and spending, including AI spend, with every number sourced and dated and anomalies flagged instead of acted on.
slug: revenue-spend-summary
tags:
  - finance
  - reporting
  - revenue
---

# Revenue and Spend Summary

The owner should know in one minute how the week went, and trust every number because it says where it came from. This skill only reads records. It never creates, changes or sends anything.

## When to use

- The weekly summary routine.
- The first 30-day summary.
- The owner asks "how did we do this week?".

## Procedure

1. **Fix the dates.** Use full days in the owner's time zone, ending yesterday. Write the exact range at the top.
2. **Read revenue** from the payments service, using only tools that list or retrieve:
   - gross payments (succeeded only), number of payments;
   - refunds and disputes (opened, won, lost);
   - processing fees;
   - net revenue = gross − refunds − fees − lost disputes;
   - payouts sent, and any failed payouts.
3. **Read spending.** If the accounting service is connected: bills and bank spending in the range, grouped by supplier or category. Always: AI spend from this company's cost records, total and by agent.
4. **Compare** with the previous period of the same length. Show the change as an amount and a percentage.
5. **Look for anomalies** (table below). Flag them; never act on them.
6. **Write the summary** in the format below.

## Anomalies to flag

| Signal | Flag when |
|---|---|
| Refunds | More than double the previous period, or above 10% of gross |
| Disputes | Any new dispute |
| Payouts | Any failed or reversed payout |
| Revenue | Down more than 30% on the previous period |
| Single payment | More than five times the usual payment size |
| AI spend | More than 50% above the previous period |

For each one: what you saw, the source and record id, and what the owner should check. If it cannot wait until the next summary, also create an early-warning task.

## Format

```md
# Revenue and spend — <from> to <to>

**Headline:** <one sentence: net revenue, change, anything unusual>

| | This period | Previous | Change |
|---|---|---|---|
| Gross revenue | | | |
| Refunds | | | |
| Fees | | | |
| Net revenue | | | |
| Payouts | | | |
| AI spend | | | |

## Worth a look
- <Anomaly, with source>

## Spending
- <Top suppliers or categories, if the accounting service is connected; otherwise "Accounting not connected.">

## Sources
- Stripe: <what was read>, <date range>
- Xero: <what was read>, <date range> (or "not connected")
- Cost records: <date range>
```

## Rules

- Read-only. Never call a tool that creates, updates, sends, refunds, pays, transfers, voids or deletes anything.
- Totals in the owner's chosen currency. Show other currencies separately with their code; never invent an exchange rate.
- Never round in a way that changes the story; show cents in the table.
- If a number could not be read, write "not available" and why. Never estimate.
- No card numbers, bank details or addresses.

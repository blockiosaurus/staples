---
name: month-close-notes
description: Read-only monthly close notes for a small business — the month's revenue, refunds, fees, payouts and spend, changes from the month before, and a list of loose ends for the owner or their accountant to check.
slug: month-close-notes
tags:
  - finance
  - month-end
  - reporting
---

# Month Close Notes

Close notes give the owner, and their accountant, a clean record of the month and a short list of things to tidy up. This skill only reads records. Fixing loose ends is for people.

## When to use

- The monthly close routine, on the first of the month.
- The owner asks for "last month's numbers".

## Procedure

1. **Fix the dates:** the whole previous calendar month, in the owner's time zone.
2. **Totals:** gross revenue, refunds, disputes, fees, net revenue, payouts, number of payments, AI spend, and (if the accounting service is connected) bills and bank spending by category.
3. **Compare** with the month before and with the same month last year if the records go back that far.
4. **Loose ends:** list each with its source and record id:
   - open disputes and their deadlines;
   - failed or reversed payouts;
   - unpaid or overdue invoices (accounting connected);
   - payouts not yet matched to a bank transaction (accounting connected);
   - payments in a currency other than the reporting currency.
5. **Write the notes** in the format below.

## Format

```md
# Close notes — <month year>

**Headline:** <one or two sentences>

## Totals
| | <Month> | <Month before> | Change |
|---|---|---|---|

## Loose ends (<n>)
- <What> — <source, record id> — <who should check it: you / your accountant>

## For your accountant
- <Anything they will ask about: refunds, disputes, unusual payments, other currencies>

## Sources
- <Each source, what was read, date range>
```

## Rules

- Read-only. Never create, update, send, refund, pay, transfer, void, reconcile or delete anything.
- Never mark anything as reconciled or paid. List it instead.
- No tax advice. Point questions to the accountant.
- If a source could not be read, say so at the top.

---
name: Weekly revenue and spend summary
slug: weekly-revenue-and-spend-summary
assignee: bookkeeper
project: books
recurring: true
schedule: "0 9 * * 1"
timezone: person
---

Write this week's revenue and spend summary for {{person.name}} with the `revenue-spend-summary` skill. Read only; change nothing.

- Totals in: {{answers.currency}}

Steps:

1. Cover the last 7 full days, ending yesterday. Write the exact dates at the top.
2. Read from Stripe: payments, refunds, disputes, fees and payouts in that range. If Xero is connected, also read invoices, bills and bank transactions in the range.
3. Read AI spend for the same dates from this company's cost records.
4. Compare with the week before. Flag anything unusual; if it cannot wait, create an early-warning task for {{person.name}}.
5. Save the summary as this task's `summary` document, with a "Sources" section listing each source and date range.
6. Comment with the headline numbers in two to four sentences and a link to the document, then mark this task done.

If Stripe is not connected yet, report AI spend only, say revenue is waiting for the Stripe connection, and mark this task done.

This routine runs at 9:00 every {{answers.reportDay}}. {{person.name}} can change the schedule on the Routines page.

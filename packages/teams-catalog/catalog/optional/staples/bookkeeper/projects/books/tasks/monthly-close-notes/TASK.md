---
name: Monthly close notes
slug: monthly-close-notes
assignee: bookkeeper
project: books
recurring: true
schedule: "0 9 1 * *"
timezone: person
---

Write close notes for last month with the `month-close-notes` skill. Read only; change nothing.

- Totals in: {{answers.currency}}

Steps:

1. Cover the whole previous calendar month. Write the exact dates at the top.
2. Read the month's payments, refunds, disputes, fees and payouts from Stripe, and invoices, bills and bank transactions from Xero if it is connected. Read the month's AI spend from this company's cost records.
3. Compare with the month before, and list loose ends: unpaid invoices, open disputes, failed payouts, payouts not yet matched to the bank (if Xero is connected).
4. Save the notes as this task's `close-notes` document, with a "Sources" section.
5. Comment with the month's headline in two to four sentences and a link to the document, then mark this task done.

Do not fix loose ends yourself. List each one with what {{person.name}} or their accountant should check.

This routine runs at 9:00 on the first of every month. {{person.name}} can change the schedule on the Routines page.

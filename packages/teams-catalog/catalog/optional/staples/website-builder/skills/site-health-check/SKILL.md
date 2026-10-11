---
name: site-health-check
description: Check a small business website for problems a visitor would notice — down, slow, broken links or buttons, broken layout on phones, expired security, out-of-date facts — and report them plainly with a recommended fix.
slug: site-health-check
tags:
  - website
  - monitoring
  - quality
---

# Site Health Check

A quick, repeatable check of what a visitor sees. The bar: if something on the site is broken or wrong, the owner hears about it from you before a customer mentions it.

## When to use

- The weekly site check.
- Before sharing any preview, and before asking to go live.
- The owner says "something is wrong with the site".

## Checklist

| Check | Pass when |
|---|---|
| Loads | The page opens in under 3 seconds and shows the right business |
| Secure | The address starts with https and there is no browser warning |
| Phone layout | Nothing overflows sideways at phone width; text is readable; buttons are easy to tap |
| Links and buttons | Every link opens the right place; no "page not found" |
| Call to action | The main button or form points to the right place (do not submit forms or send messages) |
| Facts | Prices, opening hours, contact details, products and dates match the Company Brief; no passed dates |
| Placeholders | No "lorem ipsum", `[confirm: ...]` or empty sections |
| Basics | The page title and description describe the business; images have alt text |

## Procedure

1. Run every check in the table. Note the result and, if it fails, exactly where.
2. Sort problems: **broken** (visitors cannot use the site), **wrong** (a fact is out of date), **could be better** (a suggestion).
3. For each problem, recommend one fix. Fixes go to a preview first and wait for approval before going live.
4. If the site is down because of the domain or the hosting account, do not change DNS, billing or settings. Say what you see and write the steps for the owner.

## Format

```md
# Site check — <date>

**Status:** <Up and working / Problems found / Down>

## Broken (<n>)
- <What, where> → <recommended fix>

## Out of date (<n>)
- <What, where> → <correct fact, or what to confirm>

## Could be better (<n>)
- <One line each>

## Checked
<One line: the list of checks that passed.>
```

Keep it short when everything passes: the status line and the "Checked" line are enough.

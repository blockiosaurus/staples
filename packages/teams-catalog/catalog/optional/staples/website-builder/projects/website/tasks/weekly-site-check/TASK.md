---
name: Weekly site check
slug: weekly-site-check
assignee: website-builder
project: website
recurring: true
schedule: "0 8 * * 1"
timezone: person
---

Check {{company.name}}'s live website with the `site-health-check` skill.

1. If there is no live site yet, comment "No live site yet." and mark this task done.
2. Open the live site on a phone-sized and a computer-sized screen. Check that it loads, every link and button works, the contact form or call to action points where it should (do not submit forms), and the security padlock shows.
3. Compare the page with the Company Brief. Note anything out of date: prices, opening hours, products, dates that have passed.
4. Save the result as this task's `site-check` document.
5. If everything is fine, comment "Site is up and working." with a link to the document and mark this task done.
6. If something is broken or out of date, comment with what is wrong and what you recommend. Fixes go to a preview first and wait for {{person.name}}'s approval before going live, exactly like the first build. Set this task to `in_review` if you asked a question.

Never change DNS, billing or account settings, even to fix an outage. If the site is down because of the domain or the hosting account, say so plainly and write the steps for {{person.name}}.

This routine runs every Monday at 8:00. {{person.name}} can change the schedule on the Routines page.

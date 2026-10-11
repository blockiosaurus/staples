---
name: Build a one-page landing site and share a preview link
slug: build-landing-page
assignee: website-builder
project: website
---

Build {{company.name}}'s first website: one page, in the chosen style, with the `landing-page-build` skill.

- What the site is for: {{answers.purpose}}
- Style: {{answers.style}}
- Web address: {{answers.domain}}

If hosting is not connected yet, write the plan and copy first (steps 1 and 2), then work your "Connect <service>" task and come back to this one.

1. Read the Company Brief. Write the page plan and every word of copy in a task document `site-plan`: the headline, the sections, the call to action, and any facts to confirm.
2. If facts are missing (contact details, prices, opening hours), ask in one question card with your recommended answers, set this task to `in_review`, and wait.
3. Build the page and create a preview on the connected service. Do not publish to the live site.
4. Check the preview with the `site-health-check` skill: it loads on a phone and a computer, every link and button works, and nothing says "lorem ipsum" or `[confirm: ...]`.
5. Comment with the preview link, two or three sentences on what is on the page, and a link to the `site-plan` document.
6. Ask in one question card whether to publish this version to the live site (recommended: "Yes, publish this version"), with a second option to request changes. Set this task to `in_review` and wait.

When they approve, deploy that exact version to the live site; the deploy waits for the platform's approval unless autopilot is on for publishing to the live site. If the web address is a domain they own, add the steps to connect it to the `site-plan` document; never change DNS yourself. Then comment with the live link and mark this task done. If they ask for changes, make them, share a new preview, and ask again.

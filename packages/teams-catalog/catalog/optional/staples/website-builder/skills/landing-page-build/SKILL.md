---
name: landing-page-build
description: Plan, write and build a one-page landing site for a small business — clear headline, proof, one call to action, responsive plain HTML and CSS, accessible and fast, shared as a preview before it goes live.
slug: landing-page-build
tags:
  - website
  - landing-page
  - copywriting
  - html
---

# Landing Page Build

A landing page has one job: a visitor understands what the business does within five seconds and knows the next step. Everything on the page serves that job.

## When to use

- Building the first site.
- Rebuilding or changing a section of the page.

## Plan the page

Write the plan and all the copy before building. Sections, top to bottom:

1. **Header:** business name, and at most three links (for example About, Services, Contact).
2. **Hero:** a headline that says what the business does for whom (under 10 words), one supporting sentence, and the main call to action button.
3. **What we offer:** three to six short items, each a title and one or two sentences.
4. **Why us:** what makes the business different, from the Company Brief. Only real proof: confirmed customer quotes, real numbers, real names.
5. **How it works or what to expect:** three steps, if it fits the business.
6. **Call to action again:** the same next step as the hero.
7. **Footer:** contact details, location or service area if relevant, and the year.

Leave out any section you have nothing true to put in. Mark missing facts as `[confirm: ...]` in the plan and ask before building.

## Write the copy

- Use the Company Brief's words. Short sentences. "You" and "we".
- One call to action, repeated: "Book a call", "See the menu", "Get a quote". It must point somewhere real (a form, an email address, a booking link the owner gave).
- No invented reviews, logos, statistics or awards.

## Build

- **Vercel or Netlify:** one `index.html` with a `<style>` block or one `styles.css`. No frameworks or build step unless the project already uses one. No scripts unless a feature needs one.
- **Webflow:** build the page in the connected site and keep it unpublished or on the staging address until approved.
- Style "clean": white or light background, one accent colour, generous spacing. "bold": large type, strong contrast, one bold colour. "playful": soft colours, rounded corners, friendly type. Use free, licensed fonts or system fonts.
- Works from 320px phone width to a wide screen. Text at least 16px. Buttons at least 44px tall.
- Accessible: real headings in order, alt text on images, colour contrast that passes WCAG AA, links that say where they go.
- Fast: no large images; compress what you use; no autoplaying video.
- Title and meta description that describe the business.

## Preview and go live

1. Create a preview. Never deploy to the live site from this skill without the owner's explicit approval of that exact version.
2. Check the preview with the `site-health-check` skill.
3. Share the preview link and ask for approval in one question card.
4. After approval, deploy that version; the deploy itself also waits for the platform's approval unless autopilot is on.

## Rules

- Never change DNS, domains, billing, plans or account settings.
- Never add tracking, cookie banners, payments or sign-up forms unless the owner asked.
- Keep the source of every live version in the task document or the hosting project, so it can be rebuilt.

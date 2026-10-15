# Idea to first win (roadmap)

Status: proposed roadmap (2026-10-15)
Source: Stephen's feedback (2026-10-14) plus items 4, 5, 12, 13, 17, 19, 20 of
`doc/plans/2026-10-14-ux-production-readiness-review.md`.

## Goal

A person types one sentence about the business they want to start. Within a few
minutes they see something real their team made for it, before they have
answered a questionnaire, approved a plan, or connected a vendor.

## Principles

- One field in, work out. The description is the input; everything else is derived or asked later.
- Work starts before the questions finish. The interview continues inside the thread while agents produce output.
- The first win needs no vendor sign-up. Branding qualifies; publishing does not.
- One system voice. The Assistant stays the only voice in Stage 0; hires arrive with the plan.
- One vertical, end to end, before breadth.

## What exists today (grounding)

- `/start` asks only for a business name, then opens the Assistant thread (`ui/src/staples/start/StartCompanyPage.tsx`).
- Stage 0 is a chat with an opening bubble and chips (`ui/src/staples/assistant/AssistantOpening.tsx`); the Assistant runs Interview, Brief, Plan, What happens next (`server/src/built-ins/agents/assistant/AGENTS.md`).
- The interview runs one question card per round, up to four questions each (`skills/staples-interview/SKILL.md`). It writes the brief, not goals.
- Plan approval is already in-thread ("Create plan" card); `plans.ts` applies brief, goal, project, hires, tasks, routines.
- Agents may rename the company and set its logo through the branding route; the Assistant has no tool that proposes it.
- "What we've made" (`/artifacts`) appears once the company has one artifact work product, attachment or document.
- No image generation exists anywhere in the stack. SVG wordmarks are already produced by `scripts/brand/generate-icons.mjs` for Staples itself.
- Team templates for a content and marketing vertical already exist: content-creator, social-media-manager, newsletter, researcher.

## Phases

### A. Single-field start — effort S

- `/start` asks "What business do you want to start?" (multi-line). "Have a name already?" expands an optional name field.
- Company is created with a working name derived from the description; the description is sent as the first message of the Assistant thread, so the opening question is never asked twice.
- Add a `rename company` governed action so the Assistant can propose the final name once the brand work lands (confirm card, same as budget raises).
- Review items closed: 4 (remainder), 19.

### B. Work before the questions finish — effort M

- Interview round one shrinks to three questions, the recommended answer pre-selected, with country and time zone read from the browser (item 20).
- After round one the Assistant starts the brand starter (phase C) and keeps interviewing while it runs. Remaining rounds arrive one card at a time as the brief fills.
- Technical prerequisite: a tool that lets the Assistant publish a document and a file as an artifact work product from Stage 0, before any hire exists. Without it nothing can appear in "What we've made" until the plan is applied.
- Review items closed: 5, 12 (Stage 0 part).

### C. Brand starter as the first win — effort M (text and SVG), L with images

- New skill `staples-brand-starter`: three name options, a tagline, a one-paragraph positioning statement, a palette, a type pairing, and an SVG wordmark for the chosen name. Output is a "Brand starter" document plus the SVG file, published as artifacts.
- The thread shows a card "Your brand starter is ready" with the three names as choices; choosing one applies the name and wordmark to the company through the branding route, so the company switcher and Home show it immediately.
- "What we've made" reveals with this artifact, giving the person a first screen that is not empty.
- Images: a raster logo needs an image model. Add an image app definition (OpenAI Images or fal) as a follow-on; it must stay optional so the first win never depends on a connector.
- Review items closed: 13 (first win), 17 (first checklist item becomes "pick a name").

### D. One vision question — effort S

- While the brand starter runs, the Assistant asks one card: "What would success look like in 30 days? 6 months? A year?"
- The 30-day answer becomes the plan's goal; the 6-month and 1-year answers go into the brief under "Where this is going" and onto the Goals page as context.
- Review items touched: 5, 17.

### E. Plan after the first win — effort S

- The plan is proposed only after the brand starter has landed and the vision card is answered. The card leads with "what happens next" and the team, in plain words, and keeps "Create plan" as the single action.
- Hires that require approval stay on Approvals as today; the card says so in one line.
- Review items touched: 12, 21 (undo stays a later item).

### F. One vertical, end to end — effort L

- Pick one vertical and make its golden path work without touching settings: small-brand content and marketing (content-creator, social-media-manager, researcher; newsletter optional). Both Keith's and Stephen's examples are this vertical, and the templates exist.
- Deliverables: a plan template that hires this team from the brand starter and vision answers; a first week of posts drafted as artifacts before any connector is attached; the publish step is the first and only "Connect X" ask, with the explanation from item 13.
- A scripted walkthrough (e2e) from `/start` to the first drafted post, run before each release.
- Review items closed: 13 (vendor explanation), 1 (verified on the path).

### G. Keep it going — effort L, depends on item 10

- The vertical's routines (weekly plan, daily check) already ship with the templates. What is missing is the person hearing about it: email when something needs them, and a weekly update that reads well (items 10, 11).
- Without this the first win is a one-shot and the "autonomous content loop" Stephen describes stops the first time the person closes the tab.

## Sequencing

| Pass | Phases | Effort | Outcome |
| --- | --- | --- | --- |
| 1 | A, B, C (text + SVG), D | M | One sentence in, brand starter and a named company out, in minutes |
| 2 | E, F | L | The content vertical runs from `/start` to a drafted first week of posts |
| 3 | G, C images | L | The loop survives the person leaving; raster logos |

Pass 1 can start now. Pass 2 needs the vertical decision below. Pass 3 depends on item 10 (notifications) and item 2 (billing) landing in some form.

## Parked

- Restyling the app chrome to the brand: show the brand on the artifact, not the shell; conflicts with the token-only design system.
- A 140-character limit: usable as marketing copy, not enforced in the input.
- Billing interrupt in the flow: item 2, XL; the hosted cap covers it until then.
- Stablecoin or neobank positioning: a business-model conversation, not a UX item.

## Decisions (2026-10-15)

1. Vertical for pass 2: small-brand content and marketing.
2. Logos: a dedicated brand designer agent with SVG generation skills, no raster image model. Research in progress; the design doc for pass 1 records the outcome.
3. The working company name is derived from the description, with an optional "Have a name already?" field.

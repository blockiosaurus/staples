# Idea to first win, pass 1 (design)

Status: approved design (2026-10-15)
Source: `doc/plans/2026-10-15-idea-to-first-win-roadmap.md` phases A, B, C, D and its decisions

## Goal

A person types one sentence about the business they want to start. Within a few minutes, without answering a questionnaire or connecting anything, they have a named company, three logo concepts to choose from, a palette and a one-page brand starter, and the Assistant has asked them one question about what success looks like.

## Research outcome (brand designer)

- No published agent skill covers the pipeline. The ones that exist (rampstackco logo-design and brand-identity, MIT; anthropics theme-factory and frontend-design, Apache-2.0) are prompt-only. Their structure is borrowed; rknall's svg-logo-designer has no licence and is not used.
- Benchmarks (Chat2SVG, SVGenius) show models are good at concept and layout and poor at fine geometry; accuracy falls steeply with SVG complexity. So the agent decides, code draws.
- Wordmarks must be outlined to paths with a real font (opentype.js, OFL fonts), never `<text>`, so they render the same everywhere.
- Palettes come from a deterministic OKLCH recipe (culori) with contrast gates in code.
- Every output is linted (element allow-list, viewBox, bounding box) and rendered to PNG so the agent can look at its own work once before publishing.

## Decisions

- **The brand designer is a built-in agent**, provisioned with the Assistant on company creation, tagged `paperclipBuiltInAgent` so Stage 0 continues. It runs on the same adapter as the other built-ins.
- **Drawing is server code, not agent code.** A new package `packages/brand-kit` turns a small JSON spec into SVG files, palette, and PNG previews. The agent calls it through one authenticated endpoint. Fonts (OFL, TTF) ship inside the package.
- **The person picks.** Name and logo are applied by the person on a card in the Stage 0 thread, through the board's own branding permission. No agent permission changes.
- **The brand starter is a task.** Company creation creates one "Brand starter" task assigned to the brand designer, so uploads have a task to attach to and the work shows under "What we've made".
- Company name is derived from the description; "Have a name already?" reveals an optional field.

## 1. Start page and company creation

- `/start` asks **"What business do you want to start?"** with a multi-line field, helper "One or two sentences is plenty", and a disclosure "Have a name already?" revealing a name field.
- `POST /api/companies` accepts `description` (max 2,000 chars) and `kickoff` (boolean). Name is required by the schema; the UI sends the typed name or the derived working name.
- `deriveWorkingName(description)` lives in `packages/shared/src/working-name.ts`: first capitalised noun phrase of up to four words, otherwise the first four words, otherwise "New business". Tested.
- With `kickoff`, the server, after creating the company and provisioning the Assistant, also provisions the brand designer and creates the "Brand starter" task (description in the body, assignee the brand designer, `metadata.staplesBrandStarter: true`). Existing companies and the Cloud path are unchanged.
- The UI navigates to the Assistant thread with the description in router state; `AssistantConversation` sends it as the first message, so the opening question is never asked twice.

## 2. Brand designer agent

- Definition in `server/src/services/built-in-agents.ts` with `server/src/built-ins/agents/brand-designer/AGENTS.md`, `bypassHireApproval`, stock version `"2026-10-15"`, default skill `staples-brand-kit`, auto-provisioned with the Assistant.
- Behaviour on the brand starter task: read the description; write a concept plan (industry, mood, three distinct concepts: a geometric mark, a monogram, a wordmark-only); choose a font pairing and palette seed from the catalogue; call the render endpoint; look at the 512px and 32px previews; revise at most once; upload the chosen set as artifacts; post a comment with the three names and concepts; mark the task done.
- Outputs per concept: `concept-N.svg` (lockup), `concept-N-mark.svg`, `concept-N.png` preview. Plus `palette.json`, `brand-starter.md` (name options, tagline, positioning paragraph, palette, type pairing, dos and don'ts), uploaded as artifact work products with `metadata.brandStarter = { concept: N, kind: "lockup" | "mark" | "preview" | "palette" | "document", name }`.
- The agent never emits raw SVG into the thread or edits SVG by hand.

## 3. `packages/brand-kit` and the render endpoint

- Pure functions, tested with vitest and golden PNG snapshots:
  - `buildPalette({ hue, mood })` → OKLCH recipe: primary, accent, four neutrals, tonal ramp, dark variant; WCAG gates (4.5:1 text, 3:1 marks) with lightness nudging.
  - `outlineText(text, fontId, size)` → path data via opentype.js from bundled TTFs.
  - `renderConcept(spec)` → lockup and mark SVG from templates: `geometric` (circle, square, arc, bar primitives on an 8-unit grid, at most 12 shapes), `monogram` (one or two outlined letters inside a shape), `wordmark`.
  - `lintSvg(svg)` → element allow-list (no text, script, foreignObject, filter, external href), viewBox present, bbox within margin.
  - `rasterize(svg, size)` → PNG via sharp (already a server dependency).
- Catalogue files: `fonts.json` (about twelve OFL pairings with mood and industry tags, with `OFL.txt`), palette moods.
- `POST /api/companies/:companyId/brand-kit/render` (any company agent or board): body is the spec, response is `{ files: [{ name, contentType, base64 }], palette, lint }`. Company-scoped, activity-logged, size-capped.
- New dependencies: `opentype.js`, `culori`, `svgo`. Fonts: six to eight TTF families under `packages/brand-kit/fonts/`.

## 4. Brand starter card in the Stage 0 thread

- `BrandStarterCard` renders above the composer once the brand starter task has artifacts (poll `GET /companies/:id/artifacts` filtered by `metadata.brandStarter`, every 10 s while Stage 0 is open; stop when done).
- States: "Your brand designer is working on name and logo ideas" (with the task's latest comment line), then three concept tiles (name, mark, lockup preview), then "Applied" with a link to "What we've made".
- Choosing a tile calls `PATCH /companies/:id/branding` with the name and `POST /companies/:id/logo` with the mark SVG as the board user, invalidates the company queries, and the switcher and Home show the new name and logo.
- "Keep my name" keeps the typed name and applies only the logo.

## 5. Interview pacing and the vision question

- `skills/staples-interview/SKILL.md`: round one holds at most three questions; country and time zone are read from the browser (sent with the first message as hidden context) and never asked.
- Round two is exactly one card: **"What would success look like in 30 days? In 6 months? In a year?"** (three short-answer fields). The Assistant asks it right after round one, while the brand work runs.
- `skills/staples-plan/SKILL.md`: the plan's goal is the 30-day answer; the 6-month and 1-year answers go to the brief under "Where this is going".
- The Assistant mentions the brand starter once after round one and proposes the plan after the vision card is answered or skipped. It does not wait for the brand work and does not propose a rename; the person picks on the card.
- Bump the Assistant stock version to `"2026-10-15"`.

## Out of scope

- Raster logos and image models; plan reordering beyond the wait above (phase E); the content vertical (phase F); notifications (phase G).
- Applying palette or fonts anywhere in the app chrome.

## Testing

- Unit: working-name derivation; palette gates; outline fits and centres; lint rejects `<text>`, scripts, out-of-box shapes; golden PNGs for the three templates.
- Route: render endpoint is company-scoped and rejects other companies' agents.
- Component: start page submit sends description and derived name; brand card states and apply calls.
- Live walkthrough: `/start` → thread with first message → brand card appears → pick concept → switcher shows name and logo → "What we've made" lists the files → vision card asked → plan proposed after brand work.

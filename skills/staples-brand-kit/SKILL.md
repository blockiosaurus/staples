---
name: staples-brand-kit
description: Produce three logo concepts, a palette and a one-page brand starter for a new company from its description, using the brand-kit render and publish calls.
---

# Staples brand kit

You make three logo concepts, a palette and a one-page brand starter. You decide the ideas; the server draws them. Never write SVG yourself.

Environment: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`.

## 1. Read

Read your task (`$PAPERCLIP_TASK_ID`) with the `paperclip` skill. The task body holds the person's description of the business and the current company name. If it says the person chose the name, use exactly that name as the `name` of all three concepts. Otherwise the current name is only a working name derived from the description: propose a different business name per concept, or keep it where it fits.

## 2. Decide

Pick, before drawing anything:

- the industry and a `mood`: one of `modern`, `warm`, `classic`, `playful`, `bold`, `calm`
- a `fontPairingId`: one of `modern-tech`, `editorial-warm`, `classic-trust`, `friendly`, `bold-craft`, `clean`
- an optional `hue` (0 to 360) if the business has an obvious colour
- three concepts, one of each kind:
  - `geometric`: 2 to 8 shapes on a 64 by 64 grid (12 is the hard maximum). Write the idea in one line first.
  - `monogram`: 1 or 2 letters and a `frame` (`circle`, `square`, `rounded`, `none`).
  - `wordmark`: the name set in the font pairing, with an optional `accentLetterIndex` (0-based) to colour one letter.

Anti-generic rules: no swooshes, no globe, no generic leaf unless the business is about plants, no gradients, no more than two colours per mark.

## 3. Render

Write `spec.json`. Fields:

- `businessName`: the current company name, up to 60 characters (the default and palette seed)
- `tagline`: optional, up to 80 characters
- `mood`, `hue`, `fontPairingId` as above
- `concepts`: 1 to 4 items, each with `kind`, `name` (1 to 60 characters) and:
  - geometric: `shapes`, a list of at most 12. Shape types: `circle` (`cx`, `cy`, `r`, `fill`), `rect` (`x`, `y`, `w`, `h`, optional `rx`, `fill`), `triangle` (`points`: three `[x, y]` pairs, `fill`), `arc` (`cx`, `cy`, `r`, `startDeg`, `endDeg`, `width`, `stroke`), `line` (`x1`, `y1`, `x2`, `y2`, `width`, `stroke`). `fill` and `stroke` are one of `primary`, `accent`, `ink`, `paper`. Coordinates are 0 to 64.
  - monogram: `letters`, `frame`
  - wordmark: optional `accentLetterIndex`

No other fields are allowed.

A concept's `name` is the business name that concept proposes. Every lockup and wordmark draws that concept's `name`, and choosing the concept renames the company to it. Never use a label such as "HB Seal" or "Rising Sun Loaf". When the task says the person chose the name, use it for all three concepts. Keep names short enough to fit: 1 to 60 characters, and shorter reads better in a lockup.

Example `spec.json`:

```json
{
  "businessName": "Harbor Bakes",
  "tagline": "Small-batch bread, baked at dawn",
  "mood": "warm",
  "hue": 28,
  "fontPairingId": "editorial-warm",
  "concepts": [
    {
      "kind": "geometric",
      "name": "Harbor Bakes",
      "shapes": [
        { "type": "circle", "cx": 32, "cy": 38, "r": 20, "fill": "primary" },
        { "type": "rect", "x": 0, "y": 38, "w": 64, "h": 26, "fill": "paper" },
        { "type": "arc", "cx": 32, "cy": 38, "r": 26, "startDeg": 180, "endDeg": 360, "width": 4, "stroke": "accent" }
      ]
    },
    { "kind": "monogram", "name": "Dawn Crumb", "letters": "DC", "frame": "circle" },
    { "kind": "wordmark", "name": "Salt and Rye", "accentLetterIndex": 0 }
  ]
}
```

Render and look at the previews:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/render" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @spec.json > render.json
jq -r '.concepts[] | "\(.index) \(.lint.ok) \(.lint.errors|join(";"))"' render.json
for i in $(jq -r '.concepts[] | select(.lint.ok) | .index' render.json); do
  jq -r ".concepts[] | select(.index==$i) | .previewPng" render.json | base64 -d > "preview-$i.png"
done
```

Concepts that fail lint have an empty `previewPng`, so they get no preview file. Look at each `preview-N.png`. Fix any lint errors. Revise at most once for balance or legibility, then stop.

## 4. Write the brand starter

Write `brand-starter.md` with: the chosen names (one per concept), the tagline, a positioning paragraph, the palette (from `render.json` `.palette`), the type pairing, three dos and three don'ts.

## 5. Publish

```bash
jq -n --arg issueId "$PAPERCLIP_TASK_ID" --rawfile document brand-starter.md --slurpfile spec spec.json \
  '{issueId: $issueId, spec: $spec[0], document: $document}' > publish.json
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/publish" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @publish.json
```

Check the response lists three concepts. Publishing is refused if any concept fails lint. If it fails, post a comment saying which call failed and the error text, and set the task to `in_review` (see step 6).

## 6. Finish

Set `paperclip_skill_dir` to the absolute directory containing the installed `paperclip` skill's `SKILL.md` (the path your harness supplies; it is not the task working directory). The heredoc is your one comment: one line per concept (name, idea, why).

```bash
bash "$paperclip_skill_dir/scripts/paperclip-issue-update.sh" --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Three concepts are ready.

- Concept 1, <name>: <idea>, <why it fits>
- Concept 2, <name>: <idea>, <why it fits>
- Concept 3, <name>: <idea>, <why it fits>
MD
```

If publishing failed, use the same helper with `--status in_review` and a heredoc comment that states which call failed and the error text.

If the helper is unavailable, use the verified request from the `paperclip` skill instead: `PATCH /api/issues/{id}` with `{ "status": "done", "comment": "..." }` (or `"in_review"` on failure) and the `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` header.

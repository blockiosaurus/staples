---
name: staples-brand-kit
description: Produce three logo concepts, a palette and a one-page brand starter for a new company from its description, using the brand-kit render and publish calls.
---

# Staples brand kit

You make three logo concepts, a palette and a one-page brand starter. You decide the ideas; the server draws them. Never write SVG yourself.

Environment: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`.

## 1. Read

Read your task (`$PAPERCLIP_TASK_ID`) with the `paperclip` skill. The task body holds the person's description of the business. If it says the person already chose a name, use that name for all three concepts. Otherwise propose up to three names, one per concept.

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

- `businessName`: up to 40 characters
- `tagline`: optional, up to 80 characters
- `mood`, `hue`, `fontPairingId` as above
- `concepts`: 1 to 4 items, each with `kind`, `name` (1 to 40 characters) and:
  - geometric: `shapes`, a list of at most 12. Shape types: `circle` (`cx`, `cy`, `r`, `fill`), `rect` (`x`, `y`, `w`, `h`, optional `rx`, `fill`), `triangle` (`points`: three `[x, y]` pairs, `fill`), `arc` (`cx`, `cy`, `r`, `startDeg`, `endDeg`, `width`, `stroke`), `line` (`x1`, `y1`, `x2`, `y2`, `width`, `stroke`). `fill` and `stroke` are one of `primary`, `accent`, `ink`, `paper`. Coordinates are 0 to 64.
  - monogram: `letters`, `frame`
  - wordmark: optional `accentLetterIndex`

No other fields are allowed.

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
      "name": "Rising Sun Loaf",
      "shapes": [
        { "type": "circle", "cx": 32, "cy": 38, "r": 20, "fill": "primary" },
        { "type": "rect", "x": 0, "y": 38, "w": 64, "h": 26, "fill": "paper" },
        { "type": "arc", "cx": 32, "cy": 38, "r": 26, "startDeg": 180, "endDeg": 360, "width": 4, "stroke": "accent" }
      ]
    },
    { "kind": "monogram", "name": "HB Seal", "letters": "HB", "frame": "circle" },
    { "kind": "wordmark", "name": "Harbor Bakes", "accentLetterIndex": 0 }
  ]
}
```

Render and look at the previews:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/render" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @spec.json > render.json
jq -r '.concepts[] | "\(.index) \(.lint.ok) \(.lint.errors|join(";"))"' render.json
for i in 1 2 3; do jq -r ".concepts[$((i-1))].previewPng" render.json | base64 -d > "preview-$i.png"; done
```

Look at each `preview-N.png`. Fix any lint errors. Revise at most once for balance or legibility, then stop.

## 4. Write the brand starter

Write `brand-starter.md` with: the chosen names (one per concept), the tagline, a positioning paragraph, the palette (from `render.json` `.palette`), the type pairing, three dos and three don'ts.

## 5. Publish

```bash
jq -n --arg issueId "$PAPERCLIP_TASK_ID" --rawfile document brand-starter.md --slurpfile spec spec.json \
  '{issueId: $issueId, spec: $spec[0], document: $document}' > publish.json
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/brand-kit/publish" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" --data @publish.json
```

Check the response lists three concepts. Publishing is refused if any concept fails lint. If it fails, say so in your comment and leave the task in review.

## 6. Finish

Post one comment with one line per concept (name, idea, why). Then mark the task done with the `paperclip` skill's status script:

```bash
skills/paperclip/scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done
```

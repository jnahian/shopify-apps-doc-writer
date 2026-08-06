# Annotation Pipeline (0.4) — Design

Decided 2026-08-06. Implements SPEC.md §13's 0.4 item: an optional per-shot
`annotate` list in the manifest, applied at capture time. The §13 constraint —
annotations must be deterministic on re-capture, or `/docs-check` reports
phantom drift on every annotated doc — is the design's spine.

## Central decision: selector-anchored, drawn in-browser

§13 deferred one question to this pass: raw-pixel coordinates or
selector-anchored? **Selector-anchored, rendered as a DOM/SVG overlay injected
into the live page before the screenshot** — chosen over raw-pixel
post-processing of the PNG in Node, and over a hybrid with a raw-rect escape
hatch.

Why:

- **Determinism for free.** The overlay is just more DOM, rendered by the same
  browser pass that `settle()` already stabilizes byte-for-byte. Same base UI +
  same annotate spec → identical render → identical PNG. No post-capture
  decode/draw/re-encode step exists to introduce nondeterminism.
- **Survives UI shifts.** The annotation stays attached to the element it
  describes — the same reasoning as the selector policy. Raw pixels silently
  point at the wrong thing after any layout change, a failure `/docs-check`
  cannot distinguish from legitimate drift.
- **Loud failure.** A missing annotation target is the existing
  `SELECTOR_TIMEOUT` path (exit 20), not a silently misplaced box.
- **Zero new dependencies.** Blur — the hardest primitive to implement in
  Node — is one CSS property in the browser.

Accepted costs: annotations exist only at capture time (re-annotating means
re-capturing — which is the reproducibility story anyway), and only elements
can be annotated. If a region has no stable selector, that is the existing
"report the `data-testid` gap" finding, not a reason for a pixel escape hatch.
The hybrid can be added later without breaking this schema.

## Manifest schema

A shot gains one optional field, `annotate`: an ordered array drawn
back-to-front. Every annotation names a `target` selector (same selector
policy and frame transparency as `waitFor`/actions). Fully configurable
styling, but **every knob is optional with a house default** — a bare
annotation renders in a consistent look, and configurability is never
mandatory boilerplate.

```json
{
  "id": "02-sov-dashboard",
  "path": "/admin/apps/storeseo/ai-insights",
  "waitFor": "[data-testid='sov-chart']",
  "crop": "iframe",
  "caption": "Share of Voice dashboard",
  "annotate": [
    { "type": "highlight", "target": "[data-testid='sov-score']" },
    { "type": "arrow", "target": "[data-testid='add-keyword']", "side": "left" },
    { "type": "blur", "target": "[data-testid='store-email']", "fill": "#1a1a1a" }
  ]
}
```

Three types (the set committed in §13 — highlight rects, arrows,
blur/redaction; no numbered badges in 0.4):

| Type | Knobs (default) | Renders as |
|---|---|---|
| `highlight` | `color` (`#d72c0d`), `strokeWidth` (3), `radius` (6), `padding` (4) | Rounded rectangle around the target |
| `arrow` | `color` (`#d72c0d`), `strokeWidth` (3), `side` (`"left"`), `length` (56), `gap` (8) | Arrow pointing at the midpoint of the target's given side, tip `gap` px away |
| `blur` | `padding` (0), `blur` (12), `fill` (none) | Frosted blur over the target; setting `fill` makes it an opaque redaction box instead |

- All types also take `offset: {x, y}` (px, default 0/0) to nudge the anchored
  position; `padding` grows the box beyond the element's bounds.
- Default color is Polaris's critical red (`#d72c0d`) so annotations read as
  documentation ink, not app UI; per-annotation `color` covers apps whose UI
  clashes with red.
- **Blur and redaction are one type** — same geometry, different paint:
  `fill` present → solid box; absent → backdrop blur.
- `annotate` targets are exempt from the `DESTRUCTIVE_PATTERN` read-only
  check — they are measured, never interacted with. Highlighting a "Save"
  button is a legitimate and expected use.
- Output contract unchanged: annotation happens in place;
  `screenshots/<id>.png` is the annotated artifact. No raw copies — the raw
  shot is reproducible by running the manifest without the `annotate` field.

## Capture pipeline

One new step in `captureShot`, after the wait, before settle:

1. Navigate → run actions → `applyWaitStrategy` (unchanged).
2. **Annotate**: for each entry, resolve `target` via the existing
   `findInPageOrIframe`, take `locator.boundingBox()` (Playwright reports
   iframe-nested elements in main-viewport coordinates, so `crop: "iframe"`
   needs no special casing), round to integers, apply `padding`/`offset`, and
   inject one absolutely-positioned element into the **top document** under a
   single container div (`position: fixed`, `pointer-events: none`, max
   `z-index`). Highlights are bordered divs, arrows inline SVG, blur
   `backdrop-filter: blur(Npx)` (or a solid-`fill` div). The container is
   removed and rebuilt if present, so re-running a shot is idempotent.
3. `settle()` → screenshot → save (unchanged). Element screenshots clip the
   full page render, so top-document overlays appear in `crop: "iframe"`
   shots too.

### Code layout

- `scripts/lib/annotate.js` — pure functions, no Playwright imports:
  - `resolveGeometry(box, annotation)` — integer rounding, padding, offset,
    arrow endpoint math per `side`.
  - `overlayHtml(geometries)` — deterministic HTML/SVG string.
- `scripts/capture.js` — `validateManifest` gains `annotate` checks (known
  `type`, non-empty `target`, numeric knobs); `captureShot` resolves boxes and
  injects `overlayHtml`'s output via `page.evaluate`.

No new dependencies. Shots without `annotate` are untouched.

## Error handling

- Annotation target never visible → the existing `SELECTOR_TIMEOUT` coded
  error → exit 20 ("UI changed, fix the manifest"), inheriting the
  bot-challenge reclassification to exit 30 for free (classified centrally in
  `capture.js`'s catch).
- Malformed `annotate` (unknown `type`, missing `target`, non-numeric knob) →
  `validateManifest` failure, exit 1, before any browser launches.
- Multiple matches resolve to the first, matching action-selector behavior.

## Drift interplay

`staleness.js` is unchanged. The annotated PNG is the artifact, so its bytes
are what's hashed: editing an `annotate` spec and re-shooting reports as a
screenshot change (correct), and an unchanged UI with unchanged annotations
re-captures byte-identical (see determinism above), so no phantom drift.

## Docs kept consistent

- `references/manifest-schema.md` — the `annotate` field, types/knobs table,
  and the note that targets follow the selector policy but skip the
  destructive-pattern check.
- `SKILL.md` — manifest-phase authoring guidance: annotate sparingly,
  selectors over guesswork, blur anything merchant-identifying.
- SPEC.md §13 — mark 0.4 shipped when it lands.
- Release mechanics (bump `.claude-plugin/plugin.json` + `package.json` to
  0.4.0, CHANGELOG entry) belong to the implementation plan.

## Testing (TDD)

- `scripts/lib/annotate.test.js` — geometry: rounding, padding growth,
  offset, arrow endpoints for all four sides; `overlayHtml` is byte-stable for
  identical input and correct per type (border vs SVG vs backdrop-filter vs
  fill).
- `scripts/capture.test.js` — `validateManifest` accepts a valid `annotate`
  array and rejects unknown type / missing target; annotate targets don't trip
  `checkReadOnly` even when the selector text matches a destructive word.
- Live verification: one real capture using all three types on a real admin
  page, run twice, outputs byte-identical — the determinism claim is checked
  empirically, not just argued.

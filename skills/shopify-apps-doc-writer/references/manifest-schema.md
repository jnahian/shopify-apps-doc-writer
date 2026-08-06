# Shot Manifest Schema

The shot manifest is the contract between adaptive discovery and deterministic capture. It lives at `docs/<feature-slug>/manifest.json`, git-versioned with the doc. `scripts/capture.js` executes it; re-running it after a UI change regenerates every screenshot in the doc.

## Top-level shape

```json
{
  "app": "storeseo",
  "feature": "ai-brand-visibility",
  "viewport": { "width": 1440, "height": 900 },
  "browser": "chrome",
  "shots": [ … ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `app` | yes | App key — must match a config file (`~/.config/shopify-apps-doc-writer/<app>.json`) |
| `feature` | yes | Feature slug — must match the containing `docs/<slug>/` directory |
| `viewport` | no | Overrides the config viewport for this manifest (default 1440×900) |
| `browser` | no, but always write it | Pins the rendering engine so re-capture on any machine reproduces the doc's original look: `chrome` (default) \| `msedge` \| `chromium` \| `firefox` \| `webkit`. Precedence: `--browser` CLI flag > manifest > config `capture.browser` > `chrome`. Omitting it lets a re-shooter's own `capture.browser` win, which re-encodes every screenshot and shows up as false drift in `/docs-check`. |
| `shots` | yes | Ordered array of shot objects |

## Shot object

```json
{
  "id": "02-sov-dashboard",
  "path": "/admin/apps/storeseo/ai-insights",
  "actions": [
    { "click": "[data-testid='sov-tab']" },
    { "fill": { "selector": "[data-testid='keyword-input']", "value": "seo app" } }
  ],
  "waitFor": "[data-testid='sov-chart']",
  "waitStrategy": "networkidle+selector",
  "crop": "iframe",
  "caption": "Share of Voice dashboard"
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Ordered, zero-padded (`01-`, `02-`, …). Becomes the filename: `screenshots/<id>.png` |
| `path` | yes | Admin-relative path, starting `/admin/…`. Resolved against the configured store |
| `actions` | no | Actions run after navigation, before the wait. Default `[]` |
| `waitFor` | **yes** | Selector that must be visible before the screenshot. Required on every shot — Polaris skeleton loaders photobomb otherwise |
| `waitStrategy` | no | `"networkidle+selector"` (default) or `"selector"` (skip the network-idle wait — for pages with long-polling/websockets that never go idle) |
| `crop` | no | `"full-admin"` (default; full viewport — context/navigation shots showing where the feature lives) or `"iframe"` (crops to the app iframe bounding box — feature detail) |
| `caption` | yes | Used as the image alt/caption in the doc |
| `driftCheck` | no | Set `false` to exclude this shot from `/update-docs` drift comparison. The shot is still re-shot, but reported as "not compared (volatile)" instead of changed. Use it for shots whose pixels nobody controls — host-app chrome, third-party widgets that render intermittently — which otherwise report drift on an unchanged feature. Prefer `crop: "iframe"` first; reach for this when a `full-admin` context shot proves unstable |
| `annotate` | no | Ordered list of annotations drawn onto this shot at capture time — see [Annotations](#annotations). Default `[]` |
| `mutation` | no | **Forbidden in v1.** `capture.js` refuses destructive-looking actions unless this is `true`, and the orchestrator must never set it |

## Actions (v1)

| Action | Shape | Notes |
|---|---|---|
| `click` | `{ "click": "<selector>" }` | |
| `fill` | `{ "fill": { "selector": "…", "value": "…" } }` | Clears then types |
| `select` | `{ "select": { "selector": "…", "value": "…" } }` | `<select>` option by value |
| `hover` | `{ "hover": "<selector>" }` | For tooltips/popovers |
| `press` | `{ "press": { "selector": "…", "key": "Enter" } }` | `selector` optional — omit to press on the page |
| `waitMs` | `{ "waitMs": 500 }` | Last resort, discouraged. Prefer `waitFor` |

Selectors in actions and `waitFor` are resolved first against the admin page, then inside the embedded app iframe — write them the same way regardless of frame.

## Annotations

Optional per-shot `annotate` array. Each annotation anchors to a **selector** (same policy and frame transparency as `waitFor` and actions) and is drawn as a browser overlay just before the screenshot — the annotated PNG is the artifact. Determinism holds: an unchanged UI with an unchanged `annotate` list re-captures byte-identical, so `/docs-check` reports no phantom drift. If a target moves or disappears, capture fails with exit `20` instead of drawing a misplaced box. Entries are drawn in order, back-to-front.

```json
"annotate": [
  { "type": "highlight", "target": "[data-testid='sov-score']" },
  { "type": "arrow", "target": "[data-testid='add-keyword']", "side": "left" },
  { "type": "blur", "target": "[data-testid='store-email']", "fill": "#1a1a1a" }
]
```

| Type | Knobs (default) | Renders as |
|---|---|---|
| `highlight` | `color` (`#d72c0d`), `strokeWidth` (3), `radius` (6), `padding` (4) | Rounded rectangle around the target |
| `arrow` | `color` (`#d72c0d`), `strokeWidth` (3), `side` (`"left"`), `length` (56), `gap` (8) | Arrow pointing at the midpoint of the target's given side, tip `gap` px away |
| `blur` | `padding` (0), `blur` (12), `fill` (none) | Frosted blur over the target; setting `fill` makes it an opaque redaction box instead |

All types also take `offset: {x, y}` (px, default 0/0) to nudge the anchored position; `padding` grows the box beyond the element's bounds. Every knob is optional — a bare annotation renders in the house style (Polaris critical red, so annotations read as documentation ink, not app UI).

Annotation targets follow the selector policy but are **exempt from the destructive-pattern check** — they are measured, never interacted with, so highlighting a "Save" button is fine.

## Selector policy (enforced)

Prefer, in order:

1. `data-testid` — `[data-testid='sov-chart']`
2. aria-label / role — `[aria-label='Add keyword']`, `role=button[name='Add keyword']` style
3. Visible text — `text=Add keyword` (least stable across copy changes)

**Never** hashed Polaris class names (`.Polaris-Box--xyz123`) — they change every release and silently break re-capture. If the app lacks `data-testid` coverage where you need it, that's a finding to report to the user, not a reason to use fragile selectors.

## Read-only guarantee

Actions exist to *reach* UI states, never to change store data. `capture.js` refuses any manifest whose actions target elements matching destructive/submit patterns (delete, remove, save, submit, publish, confirm, …) unless the shot sets `"mutation": true` — and setting that flag is forbidden in v1. If a state is only reachable by mutating data, capture the state before it and note the gap in the doc review.

## Full example

```json
{
  "app": "storeseo",
  "feature": "ai-brand-visibility",
  "viewport": { "width": 1440, "height": 900 },
  "shots": [
    {
      "id": "01-navigate",
      "path": "/admin/apps/storeseo",
      "actions": [],
      "waitFor": "[data-testid='app-nav']",
      "crop": "full-admin",
      "caption": "StoreSEO in the Shopify admin sidebar"
    },
    {
      "id": "02-sov-dashboard",
      "path": "/admin/apps/storeseo/ai-insights",
      "actions": [
        { "click": "[data-testid='sov-tab']" },
        { "fill": { "selector": "[data-testid='keyword-input']", "value": "seo app" } }
      ],
      "waitFor": "[data-testid='sov-chart']",
      "waitStrategy": "networkidle+selector",
      "crop": "iframe",
      "caption": "Share of Voice dashboard"
    }
  ]
}
```

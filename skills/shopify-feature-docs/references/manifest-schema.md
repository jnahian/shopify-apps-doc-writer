# Shot Manifest Schema

The shot manifest is the contract between adaptive discovery and deterministic capture. It lives at `docs/<feature-slug>/manifest.json`, git-versioned with the doc. `scripts/capture.js` executes it; re-running it after a UI change regenerates every screenshot in the doc.

## Top-level shape

```json
{
  "app": "storeseo",
  "feature": "ai-brand-visibility",
  "viewport": { "width": 1440, "height": 900 },
  "shots": [ … ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `app` | yes | App key — must match a config file (`~/.config/shopify-feature-docs/<app>.json`) |
| `feature` | yes | Feature slug — must match the containing `docs/<slug>/` directory |
| `viewport` | no | Overrides the config viewport for this manifest (default 1440×900) |
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

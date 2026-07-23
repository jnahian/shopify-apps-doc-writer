# shopify-feature-docs

A Claude Code plugin that writes **merchant-facing feature documentation** for embedded Shopify apps — real prose plus real, reproducible screenshots captured via Playwright — and optionally publishes it to Google Docs or any connected MCP destination.

Built for [StoreSEO](https://apps.shopify.com/storeseo); multi-app capable by design.

## How it works

```
/docs-setup            one-time wizard: auth → publish target → product context
/write-docs <feature>  discover → shot manifest (gate 1) → capture → write
                       → review draft (gate 2) → publish (gate 3, optional)
/update-docs           v2 stub — manifest re-runs already cover re-capture
```

**Key principle:** discovery is interactive and adaptive (Claude browses the live feature, reads code and ClickUp); capture is deterministic (`scripts/capture.js` executes a versioned JSON **shot manifest**). The manifest is the contract between the two — re-running it after a UI change regenerates every screenshot in a doc.

**Canonical output** is always local markdown + assets, regardless of publish target:

```
docs/<feature-slug>/
├── index.md          # the doc
├── manifest.json     # shot manifest (reproducibility)
├── meta.json         # status, content/published hashes, publish record
└── screenshots/      # numbered PNGs, one per manifest shot
```

## Hard gates

| # | When | What the user approves |
|---|------|------------------------|
| 1 | Before capture | The shot manifest: shot list, pages, actions |
| 2 | Before anything leaves local | The full draft doc |
| 3 | Before external publish | Exact summary of writes to the external target |

No gate is ever auto-approved. Capture is read-only — the manifest never contains actions that mutate store data, and `capture.js` refuses destructive-looking actions.

## Install

```bash
npm install
npx playwright install chromium
./scripts/vendor-skills.sh   # pulls the five writing skills from coreyhaines31/marketingskills (MIT)
```

Then in Claude Code, run `/docs-setup`. Requires Node ≥ 20.

## Configuration

All config is **per-user and gitignored** — nothing config-related is committed to the app repo:

- `~/.config/shopify-feature-docs/<app-key>.json` — store, app handle, viewport, capture + publish settings
- `~/.config/shopify-feature-docs/<app-key>.auth.json` — Playwright storageState (your login session; never in the repo)

Team consistency comes from the plugin itself (SKILL.md conventions, doc template, viewport default), not shared config. The one team-shared artifact is `product-marketing.md` (positioning/tone foundation), which setup offers to save to the repo at `.agents/product-marketing.md`.

Multiple apps = multiple config files; commands accept `--app <key>`.

## Layout

```
.claude-plugin/plugin.json           plugin manifest
commands/                            /docs-setup · /write-docs · /update-docs (stub)
skills/shopify-feature-docs/         orchestrator SKILL.md + references/
  references/doc-template.md           canonical doc structure
  references/manifest-schema.md        shot manifest schema + selector policy
  references/publish-targets.md        local · google-docs · generic mcp
skills/vendored/                     pinned writing skills (see VERSIONS.md)
scripts/setup-auth.js                headed login → storageState + verification shot
scripts/capture.js                   manifest → numbered PNGs (exit 10 auth / 20 selector)
scripts/lib/                         config + Shopify admin helpers
```

## v2 backlog

Screenshot annotation (arrows/highlights/blur), `/update-docs` staleness detection and publish diffing, demo-data seeding, multi-locale capture, docs-site publish targets. See the spec for details.

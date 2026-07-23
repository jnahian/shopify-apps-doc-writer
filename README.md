# shopify-apps-doc-writer

A Claude Code plugin that writes **merchant-facing feature documentation** for embedded Shopify apps — real prose plus real, reproducible screenshots captured via Playwright — and optionally publishes it to Google Docs or any connected MCP destination.

Built for [StoreSEO](https://apps.shopify.com/storeseo); multi-app capable by design.

## How it works

```
/docs-setup            one-time wizard: auth → publish target → product context
/write-docs <feature>  discover → shot manifest (gate 1) → capture → write
                       → review draft (gate 2) → publish (gate 3, optional)
/update-docs           detect copy/screenshot drift → re-shoot → re-publish (gate 3)
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

There's nothing to install by hand. The five writing skills ship with the plugin (in `skills/vendored/`, MIT — see its `VERSIONS.md`), and `npm install` runs automatically on your first session — a `SessionStart` hook (`hooks/ensure-deps.js`) installs Playwright in the background when it's missing, and again after a plugin update.

Login, capture, and verification all drive your installed **Google Chrome** — there's no separate browser download (`npx playwright install`). You need Chrome installed and Node ≥ 20. Then in Claude Code, run `/docs-setup`.

Working from a clone rather than an installed plugin? Run `npm install` yourself — the auto-install hook only fires for the installed plugin. To re-pin the writing skills to a newer upstream, run `./scripts/vendor-skills.sh` (a maintenance step, not needed for normal use — and re-apply the description de-emphasis afterward, per `skills/vendored/VERSIONS.md`).

## Configuration

All config is **per-user and gitignored** — nothing config-related is committed to the app repo:

- `~/.config/shopify-apps-doc-writer/<app-key>.json` — store, app handle, viewport, capture + publish settings
- `~/.config/shopify-apps-doc-writer/<app-key>.auth.json` — Playwright storageState (your login session; never in the repo)

Team consistency comes from the plugin itself (SKILL.md conventions, doc template, viewport default), not shared config. The one team-shared artifact is each app's product-marketing context (positioning/tone foundation), which setup offers to save to the repo at `.agents/<app-key>.product-marketing.md` — keyed by app so multiple apps in one repo don't collide.

Multiple apps = multiple config files; commands accept `--app <key>`.

## Layout

```
.claude-plugin/plugin.json           plugin manifest
commands/                            /docs-setup · /write-docs · /update-docs
skills/shopify-apps-doc-writer/         orchestrator SKILL.md + references/
  references/doc-template.md           canonical doc structure
  references/manifest-schema.md        shot manifest schema + selector policy
  references/publish-targets.md        local · google-docs · generic mcp
skills/vendored/                     pinned writing skills (see VERSIONS.md)
scripts/setup-auth.js                real-Chrome CDP login → storageState + verification shot
scripts/capture.js                   manifest → numbered PNGs (exit 10 auth / 20 selector)
scripts/update-check.js              drift detector for /update-docs
scripts/lib/                         config + Shopify admin helpers
```

## v2 backlog

Screenshot annotation (arrows/highlights/blur), `/update-docs` re-publish diffing against a live external doc, demo-data seeding, multi-locale capture, docs-site publish targets. See the spec for details.

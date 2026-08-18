# shopify-apps-doc-writer

A Claude Code plugin that writes **merchant-facing feature documentation** for embedded Shopify apps — real prose plus real, reproducible screenshots captured via Playwright — and optionally publishes it to Google Docs or any connected MCP destination.

Built for [StoreSEO](https://apps.shopify.com/storeseo); multi-app capable by design.

## How it works

```
/docs-setup            one-time wizard: auth → publish target → product context
/write-docs <feature>  worktree → discover → shot manifest (gate 1) → capture
                       → write → review draft (gate 2) → publish (gate 3, optional)
/update-docs           worktree → detect copy/screenshot drift → re-shoot
                       → re-publish (gate 3)
/docs-deploy           build internal docs site → confirm → Cloudflare Pages URL
                       → optional Slack heads-up (draft-only, never auto-sent)
/docs-check            re-shoot every manifest → report which docs went stale
                       (report-only: writes nothing, needs no gates)
/docs-schedule         daily background sweep (launchd) → notice at your next session
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

`/docs-schedule` (macOS) runs that same sweep daily in the background via
launchd — no Claude session involved. It only reports: results are saved
locally and surface as a one-line notice at your next session start. Nothing
publishes and nothing posts to Slack unattended; the draft-only Slack path
still happens through `/docs-check`, with you present.

`/write-docs` and `/update-docs` open with a **preflight confirmation** that is not one of the three: before writing anything they ask for a base branch and a worktree name (default `docs/<feature-slug>`) and do all work in `.worktrees/<branch>`, so your checkout stays untouched. Decline it, or already be in a worktree, and they work in place.

`/docs-deploy` has its own confirmation gate of the same kind, separate from the three above: it publishes a *projection* of `docs/` to a Cloudflare Pages URL (viewable by anyone with the link) and never touches `meta.json` — per-doc publish records keep their existing meaning.

## Install

```bash
claude plugin marketplace add https://github.com/jnahian/shopify-apps-doc-writer
claude plugin install shopify-apps-doc-writer@shopify-apps-doc-writer
```

Or from inside Claude Code: `/plugin marketplace add jnahian/shopify-apps-doc-writer`, then `/plugin install shopify-apps-doc-writer@shopify-apps-doc-writer`.

Beyond that, there's nothing to install by hand. The five writing skills ship with the plugin (in `skills/vendored/`, MIT — see its `VERSIONS.md`), and `npm install` runs automatically on your first session — a `SessionStart` hook (`hooks/ensure-deps.js`) installs Playwright in the background when it's missing, and again after a plugin update.

Login, verification, and default capture all drive your installed **Google Chrome** — no separate browser download (`npx playwright install`) needed out of the box. You need Chrome installed and Node ≥ 20. Then in Claude Code, run `/docs-setup`.

Other capture engines (`chromium`, `firefox`, `webkit`, `msedge`) can be selected per manifest, per config, or with `--browser`. The three downloadable engines auto-install on first use; `msedge` needs a vendor install like Chrome. Firefox and WebKit do work against a live admin (the saved Chrome session carries over), but their screenshots aren't byte-stable across repeat captures the way Chrome's are — **stick with `chrome` for any doc you'll re-check with `/update-docs` or `/docs-check`**, or you'll get drift reports for a UI that never changed.

> **Upgrading from before multi-engine capture?** If `~/.config/shopify-apps-doc-writer/<app>.json` has `capture.browser: "chromium"` (the old, inert default that `/docs-setup` used to write), that value is now honored — it will trigger a one-time bundled-Chromium download and render with Chromium instead of Chrome. Delete the key to stay on Chrome.

### Updating

Claude Code refreshes the marketplace on its own, but you can pull a new release immediately:

```bash
claude plugin marketplace update shopify-apps-doc-writer
claude plugin update shopify-apps-doc-writer@shopify-apps-doc-writer
```

Updates arrive **only when `version` in `.claude-plugin/plugin.json` changes** — that string is Claude Code's update cache key, so commits pushed without a bump never reach an installed copy. See `CHANGELOG.md` for what each version contains.

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
commands/                            /docs-setup · /write-docs · /update-docs · /docs-deploy · /docs-check · /docs-schedule
skills/shopify-apps-doc-writer/         orchestrator SKILL.md + references/
  references/doc-template.md           canonical doc structure
  references/manifest-schema.md        shot manifest schema + selector policy
  references/publish-targets.md        local · google-docs · generic mcp
skills/vendored/                     pinned writing skills (see VERSIONS.md)
scripts/setup-auth.js                real-Chrome CDP login → storageState + verification shot
scripts/capture.js                   manifest → numbered PNGs (exit 10 auth / 20 selector / 30 bot challenge)
scripts/update-check.js              drift detector for /update-docs (--all: sweep for /docs-check)
scripts/sweep.js                     unattended sweep runner for /docs-schedule (launchd)
scripts/schedule-sweep.js            install/uninstall/status of the launchd job (macOS)
scripts/build-site.js                docs/ → static site for /docs-deploy (Cloudflare Pages)
scripts/lib/                         config + Shopify admin helpers
```

## v2 backlog

Screenshot annotation (arrows/highlights/blur), `/update-docs` re-publish diffing against a live external doc, demo-data seeding, multi-locale capture, docs-site publish targets. See the spec for details.

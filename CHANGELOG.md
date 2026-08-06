# Changelog

Notable changes to the `shopify-apps-doc-writer` plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org).

**Installed users only receive a change once `version` in
`.claude-plugin/plugin.json` is bumped** — Claude Code uses that string as its
update cache key, so merging to `main` alone ships nothing.

## [0.2.0] - 2026-08-06

Everything below landed on `main` from 2026-07-24 onward under an unchanged
`0.1.0`, so this release delivers it all at once.

### Added

- `/update-docs` — re-shoot a published doc, detect copy and screenshot drift,
  re-publish. Backed by `scripts/update-check.js` and `scripts/lib/staleness.js`.
- `/docs-deploy` — project `docs/` into a static site (`scripts/build-site.js`)
  and deploy it to Cloudflare Pages behind its own confirmation gate.
- `/docs-check` — pre-release staleness sweep across every doc, with a
  draft-only Slack review notification.
- Multi-engine capture: `chrome`, `msedge`, `chromium`, `firefox`, `webkit`,
  selectable per manifest, per config, or with `--browser`. The three
  downloadable engines auto-install on first use.
- Worktree preflight: `/write-docs` and `/update-docs` confirm a base branch and
  worktree name, then work in `.worktrees/<branch>` instead of your checkout.
- `driftCheck: false` per shot, to exempt volatile screenshots from drift
  reports, and `--out-dir` on `capture.js` for staging re-shoots.
- `SessionStart` hook that installs npm dependencies on first session and after
  each plugin update.

### Changed

- Capture and verification drive your installed Google Chrome
  (`channel: "chrome"`) — no browser download needed out of the box. Login
  already used real Chrome as of 0.1.0.
- Re-capture is byte-stable: shots settle until two consecutive frames match, so
  `/update-docs` and `/docs-check` stop reporting drift on an unchanged UI.
- Product-marketing context is keyed per app at
  `.agents/<app-key>.product-marketing.md`, so multiple apps in one repo don't
  collide.
- Vendoring the writing skills is a maintenance step, not part of install.

### Fixed

- A bot challenge during capture now exits `30` with its own remedy (re-run
  `--headed`) instead of exiting `20` "the UI has likely changed", which sent
  users off to rewrite a manifest that was correct. ([#3](https://github.com/jnahian/shopify-apps-doc-writer/issues/3))
- `/docs-check` contains doc-local failures per doc instead of aborting the
  whole sweep.
- `update-check.js` keeps `capture.js`'s progress output off its JSON stdout,
  and no longer leaks temp directories.

## [0.1.0] - 2026-07-23

The plugin as first built and made installable, dogfooded the same day through
two real merchant docs published to Google Docs.

### Added

- `/docs-setup` — auth, publish target, and product context, in resumable
  phases; `/write-docs` — manifest → capture → draft → publish. `/update-docs`
  shipped as a stub, implemented in 0.2.0.
- The orchestrator skill (`SKILL.md`) and its references: doc template, shot
  manifest schema with the selector policy, and publish targets — `local`,
  `google-docs`, and a generic `mcp` path.
- `scripts/capture.js` — the deterministic shot-manifest runner and the only
  screenshotter: read-only refusal of destructive action selectors, `waitFor`
  required per shot, page-or-iframe selector resolution, and exit codes `10`
  (auth expired) and `20` (selector timeout).
- `scripts/setup-auth.js` — login to the Shopify admin, save a Playwright
  `storageState`, and take a verification shot.
- `scripts/lib/config.js` — per-user, per-app config under
  `~/.config/shopify-apps-doc-writer/`, never committed; `--app <key>` for
  multiple apps.
- `scripts/lib/md2html.js` — markdown → HTML for the Google Docs publish path,
  with the ordered-list numbering trap covered by a self-check.
- `.claude-plugin/marketplace.json`, making the plugin installable rather than
  clone-only.
- `scripts/vendor-skills.sh` for re-pinning the vendored writing skills.

### Changed

- Login drives your real, already-signed-in Google Chrome over CDP instead of a
  Playwright-launched browser, so Shopify's automation detection on the login
  page doesn't block setup.
- Renamed from `shopify-feature-docs` to `shopify-apps-doc-writer` — the plugin
  name is also the skill namespace, so this changed how its skills are invoked.

### Fixed

- `findInPageOrIframe` prefers visible matches, so responsive Polaris duplicates
  (one desktop, one mobile, the hidden one often first in the DOM) no longer
  make capture poll a hidden twin until timeout.

The version string then stayed at `0.1.0` through everything listed under 0.2.0
above — so installs made at different times all report `0.1.0` while holding
different content. Updating to 0.2.0 converges them.

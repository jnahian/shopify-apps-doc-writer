# Changelog

Notable changes to the `shopify-apps-doc-writer` plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org).

**Installed users only receive a change once `version` in
`.claude-plugin/plugin.json` is bumped** — Claude Code uses that string as its
update cache key, so merging to `main` alone ships nothing.

## [0.2.0] - 2026-08-06

Everything below had already landed on `main` under an unchanged `0.1.0`, so
this release delivers it all at once.

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

- Login, verification, and default capture drive your installed Google Chrome
  (CDP for login, `channel: "chrome"` for capture) — no browser download needed
  out of the box.
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
- `findInPageOrIframe` prefers visible matches, so responsive Polaris duplicates
  no longer make capture poll a hidden twin until timeout.
- `/docs-check` contains doc-local failures per doc instead of aborting the
  whole sweep.
- `update-check.js` keeps `capture.js`'s progress output off its JSON stdout,
  and no longer leaks temp directories.

## [0.1.0]

Initial plugin: `/docs-setup`, `/write-docs`, the orchestrator skill, and the
deterministic `capture.js` manifest runner.

The version string then stayed at `0.1.0` through the work listed under 0.2.0
above — so installs made at different times all report `0.1.0` while holding
different content. Updating to 0.2.0 converges them.

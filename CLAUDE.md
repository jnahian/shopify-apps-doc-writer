# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **Claude Code plugin** (`shopify-feature-docs`), not an application. Most of its "source" is markdown that instructs Claude at runtime — `commands/*.md`, `skills/shopify-feature-docs/SKILL.md`, and its `references/`. The only executable code is two Node scripts (plus their shared lib) and a vendoring shell script. Behavior changes usually mean editing markdown, not JS.

`SPEC.md` is the design source of truth (v1 scope, non-goals, build order, v2 backlog). Check it before adding anything — several obvious-seeming features are deliberately deferred to v2 (annotation, `/update-docs` staleness detection, demo-data seeding, multi-locale).

## Commands

```bash
npm install
npx playwright install chromium
./scripts/vendor-skills.sh [sha]   # pulls 5 writing skills into skills/vendored/, rewrites VERSIONS.md

node scripts/setup-auth.js --app <key> [--store x.myshopify.com] [--handle <app-handle>]
node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--headed]
```

There is no test suite, linter, or build step. Verify script changes by running a real capture against a manifest.

`skills/vendored/` currently holds only `VERSIONS.md` — the skills are not vendored yet. SKILL.md handles this gracefully (falls back to the doc template), so don't assume those directories exist.

## Architecture

The whole design rests on one split:

- **Discovery is adaptive** — Claude browses the live admin, reads code and ClickUp, and decides what to shoot.
- **Capture is deterministic** — `scripts/capture.js` executes a JSON **shot manifest**. Nothing else takes screenshots that land in a doc.

`docs/<slug>/manifest.json` is the contract between the two, and the reproducibility guarantee: re-running it after a UI change regenerates every screenshot. Never bypass `capture.js` with ad-hoc browser screenshots.

**Three hard gates**, none skippable or auto-approvable: (1) manifest before capture, (2) draft before anything leaves local, (3) exact summary of external writes before publish. They're stated in `commands/write-docs.md`, SKILL.md, and `references/publish-targets.md` — keep those consistent.

**Output contract** — always produced regardless of publish target; publishing is a projection of it:

```
docs/<feature-slug>/{index.md, manifest.json, meta.json, screenshots/NN-*.png}
```

### Coupling to watch when editing

- **Exit codes are a documented contract.** `capture.js` exits `10` (auth expired → `/docs-setup auth`) and `20` (selector timeout → UI changed, fix manifest). SKILL.md documents both by number; `commands/docs-setup.md` references code 10 (and `setup-auth.js` also exits 10 on a failed login), so keep them in sync.
- **Read-only guarantee** is enforced twice: `DESTRUCTIVE_PATTERN` in `capture.js` refuses destructive-looking action selectors, and SKILL.md forbids Claude from ever setting `"mutation": true` to override it. Both halves must stay.
- **Selector policy** (`references/manifest-schema.md`): `data-testid` > aria-label/role > visible text. Never hashed Polaris class names. `waitFor` is required on every shot — `capture.js` validates this because Polaris skeleton loaders photobomb otherwise.
- **Frame transparency**: `findInPageOrIframe` in `scripts/lib/shopify.js` resolves every selector against the admin page *then* the app iframe, so manifest authors never specify a frame. `crop: "iframe"` uses `APP_IFRAME_SELECTOR` directly.
- **Config is per-user and never committed**: `~/.config/shopify-feature-docs/<app-key>.json` + `<app-key>.auth.json` (Playwright storageState, chmod 600). Multi-app support is the reason for `--app <key>` everywhere; `resolveAppKey` falls back to the single existing config. Team consistency comes from the plugin itself, not shared config — the one team-shared artifact is `.agents/product-marketing.md` in the target app's repo.

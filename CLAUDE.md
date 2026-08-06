# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **Claude Code plugin** (`shopify-apps-doc-writer`), not an application. Most of its "source" is markdown that instructs Claude at runtime — `commands/*.md`, `skills/shopify-apps-doc-writer/SKILL.md`, and its `references/`. The only executable code is two Node scripts (plus their shared lib) and a vendoring shell script. Behavior changes usually mean editing markdown, not JS.

`SPEC.md` is the design source of truth (v1 scope, non-goals, build order, v2 roadmap). Check it before adding anything — §13 fixes what ships next and what stays deferred (e.g. multi-locale, demo-data seeding).

## Commands

```bash
npm install                        # auto-runs on first session via hooks/ensure-deps.js
./scripts/vendor-skills.sh [sha]   # MAINTENANCE ONLY: re-pin skills/vendored/ to newer upstream.
                                   # The 5 skills are committed and ship with the plugin — this is
                                   # not an install step. The script re-applies the description
                                   # de-emphasis itself (idempotent; see vendored/VERSIONS.md).

node scripts/setup-auth.js --app <key> [--store x.myshopify.com] [--handle <app-handle>]
node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--headed]
node scripts/build-site.js --app <key> [--out <dir>]   # docs/ → static site; deployed by /docs-deploy via npx wrangler
node scripts/update-check.js --all --app <key>          # staleness sweep across all docs (/docs-check)
```

```bash
npm test                            # every *.test.js suite, via node --test
npm run typecheck                   # tsc --noEmit over the JS via JSDoc (strict checkJs)
node scripts/lib/shopify.test.js    # any suite also runs standalone
```

The suites are plain `assert` scripts (no framework — `node --test` just runs each file and reads its exit code), and the typecheck compiles nothing (the scripts stay plain JS; types live in JSDoc comments, checked by `tsconfig.json`'s `checkJs`). CI (`.github/workflows/ci.yml`) runs both on every PR and push to `main`.

**JS changes follow TDD.** For any change to `scripts/` or `hooks/`: write the failing test first — a plain `assert` script named `<module>.test.js` beside its module, which `node --test` auto-discovers — watch it fail, then implement. `npm test` and `npm run typecheck` must both pass before commit. Markdown changes have no runner and are exempt; verify capture-affecting ones by running a real capture against a manifest.

`skills/vendored/` holds the five writing skills, pinned in its `VERSIONS.md`; they shipped with the plugin since 0.2.0. They are deliberately **not** registered skills — one directory too deep for plugin skill discovery — so they can never auto-trigger; the orchestrator reads each `SKILL.md` directly by `<plugin-root>`-qualified path. SKILL.md still degrades gracefully (doc-template fallback) if one is missing from a broken install.

## Architecture

The whole design rests on one split:

- **Discovery is adaptive** — Claude browses the live admin, reads code and ClickUp, and decides what to shoot.
- **Capture is deterministic** — `scripts/capture.js` executes a JSON **shot manifest**. Nothing else takes screenshots that land in a doc.

`docs/<slug>/manifest.json` is the contract between the two, and the reproducibility guarantee: re-running it after a UI change regenerates every screenshot. Never bypass `capture.js` with ad-hoc browser screenshots.

**Three hard gates**, none skippable or auto-approvable: (1) manifest before capture, (2) draft before anything leaves local, (3) exact summary of external writes before publish. They're stated in `commands/write-docs.md`, SKILL.md, and `references/publish-targets.md` — keep those consistent. `/write-docs` and `/update-docs` also open with a **preflight worktree confirmation** (base branch + worktree name → `.worktrees/<branch>`), stated in SKILL.md §0.2 and echoed in both command files — separate from the three gates, and skippable, unlike them. Consequence: cwd is the docs repo, not the plugin root, so every command invokes its script as `<plugin-root>/scripts/…`. `capture.js`, `update-check.js`, and `build-site.js` all resolve manifests and `outputDir` against cwd; the cheat-sheet above assumes the dogfood case where the two directories coincide.

`/docs-deploy` has its own confirmation gate, modeled on gate 3 but separate from these three: it publishes a *projection* of `docs/` to a Cloudflare Pages URL and never touches `meta.json`.

**Output contract** — always produced regardless of publish target; publishing is a projection of it:

```
docs/<feature-slug>/{index.md, manifest.json, meta.json, screenshots/NN-*.png}
```

### Coupling to watch when editing

- **Exit codes are a documented contract.** `capture.js` exits `10` (auth expired → `/docs-setup auth`), `20` (selector timeout → UI changed, fix manifest) and `30` (bot challenge → re-run `--headed`; the manifest is fine). SKILL.md documents all three by number; `commands/docs-setup.md` references code 10 (and `setup-auth.js` also exits 10 on a failed login), so keep them in sync. Code 30 exists because every selector times out on an interstitial too, and reporting that as 20 sends the user to rewrite a correct manifest — `detectBotChallenge` in `lib/shopify.js` splits the two, classified once in `capture.js`'s `SELECTOR_TIMEOUT` handler so it covers every throw site (action resolve, waitFor, iframe crop, annotation resolve/off-viewport).
- **Releases require a version bump.** Claude Code resolves this plugin's version from `version` in `.claude-plugin/plugin.json` and uses it as the update cache key, so merging to `main` ships *nothing* to installed users until that string changes. Any user-visible change (commands, skills, scripts, hooks) means bumping `.claude-plugin/plugin.json` **and** `package.json` to the same semver, plus a `CHANGELOG.md` entry. Deliberately not duplicated into `marketplace.json` — `plugin.json` wins the resolution order, and a second copy is a second thing to forget. Tags/releases are documentation, not a channel: users track `main`'s tip.
- **Read-only guarantee** is enforced twice: `DESTRUCTIVE_PATTERN` in `capture.js` refuses destructive-looking action selectors, and SKILL.md forbids Claude from ever setting `"mutation": true` to override it. Both halves must stay.
- **Selector policy** (`references/manifest-schema.md`): `data-testid` > aria-label/role > visible text. Never hashed Polaris class names. `waitFor` is required on every shot — `capture.js` validates this because Polaris skeleton loaders photobomb otherwise.
- **Frame transparency**: `findInPageOrIframe` in `scripts/lib/shopify.js` resolves every selector against the admin page *then* the app iframe, so manifest authors never specify a frame. `crop: "iframe"` uses `APP_IFRAME_SELECTOR` directly.
- **Config is per-user and never committed**: `~/.config/shopify-apps-doc-writer/<app-key>.json` + `<app-key>.auth.json` (Playwright storageState, chmod 600). Multi-app support is the reason for `--app <key>` everywhere; `resolveAppKey` falls back to the single existing config. Team consistency comes from the plugin itself, not shared config — the one team-shared artifact is each app's `.agents/<app-key>.product-marketing.md` in the target app's repo (keyed per app so multiple apps don't collide).

# shopify-apps-doc-writer — Plugin Specification

A Claude Code plugin that writes merchant-facing feature documentation for embedded Shopify apps, capturing real screenshots via Playwright and publishing to a user-configured destination (local markdown, Google Docs, or any connected MCP).

**Status:** v1 spec — agreed in brainstorm 2026-07-23
**Primary app:** StoreSEO (multi-app capable by design)

---

## 1. Goals & Non-Goals

### Goals (v1)
- One-command workflow (`/write-docs <feature>`) that produces a complete feature doc: prose + real, consistent screenshots.
- Deterministic, reproducible screenshot capture via a **shot manifest** — re-running a manifest after a UI change regenerates every screenshot in a doc.
- Canonical output is **always local markdown + assets**. Publishing is an optional projection of it.
- Publish target is pluggable: local-only, Google Docs (hardcoded known-good path), or any connected MCP (generic adaptive path).
- Hard confirmation gates before capture and before any external publish (same philosophy as the `app-release` skill).
- Per-user config; team conventions live in the plugin itself (SKILL.md), not in shared config.

### Non-Goals (v1)
- Screenshot annotation (arrows, highlight boxes, blur/redaction) → **v2**.
- `/update-docs` staleness detection and re-publish diffing → **v2** (command stubbed).
- Automated publishing without human confirmation → never.
- Managing/seeding dev store demo data → manual checklist item only.

---

## 2. Architecture Overview

```
 /docs-setup                      /write-docs <feature>
      │                                 │
      ▼                                 ▼
 ┌──────────────┐   config    ┌──────────────────────┐
 │ Setup wizard │────────────▶│ Orchestrator SKILL.md │
 │ 3 phases     │             └──────────┬───────────┘
 └──────────────┘                        │
                        ┌────────────────┼─────────────────────┐
                        ▼                ▼                     ▼
                 1. DISCOVER       2. CAPTURE            3. WRITE
                 (interactive      (scripts/capture.js   (vendored skills:
                  browsing, code/   executes shot         copywriting,
                  ClickUp reading)  manifest,             copy-editing,
                        │           deterministic)        ai-seo)
                        ▼                │                     │
                 shot manifest ──gate #1─┘                     ▼
                 (user approves)                    docs/<slug>/index.md
                                                          │
                                                    gate #2 (review draft)
                                                          │
                                                          ▼
                                                   4. PUBLISH (optional)
                                                   local | google-docs | mcp
                                                          │
                                                    gate #3 (confirm push)
```

**Key principle:** discovery is interactive/adaptive (Claude browses, reads code, reads ClickUp); capture is deterministic (versioned script executes a JSON manifest). The manifest is the contract between the two.

---

## 3. Directory Structure

```
shopify-apps-doc-writer/
├── .claude-plugin/
│   └── plugin.json                  # name, version, description, author
├── commands/
│   ├── docs-setup.md                # setup wizard (3 phases, resumable)
│   ├── write-docs.md                # main workflow entry point
│   └── update-docs.md               # v2 stub — prints "coming soon" + pointer to manifest re-run
├── skills/
│   ├── shopify-apps-doc-writer/
│   │   ├── SKILL.md                 # orchestrator (see §7)
│   │   └── references/
│   │       ├── doc-template.md      # canonical feature-doc structure
│   │       ├── manifest-schema.md   # shot manifest JSON schema + examples
│   │       └── publish-targets.md   # per-target publish instructions
│   └── vendored/
│       ├── VERSIONS.md              # upstream repo URL + pinned commit hash + date
│       ├── product-marketing/
│       ├── copywriting/
│       ├── copy-editing/
│       ├── ai-seo/
│       └── content-strategy/
└── scripts/
    ├── setup-auth.js                # real-Chrome CDP login → storageState + verification shot
    ├── capture.js                   # executes a shot manifest → numbered PNGs
    └── lib/
        ├── config.js                # load/validate per-user config, resolve app key
        └── shopify.js               # admin URL builders, iframe helpers, wait strategies
```

### Vendored skills

Vendor from `coreyhaines31/marketingskills` (MIT). Record in `VERSIONS.md`:

```md
# Vendored from coreyhaines31/marketingskills
- Upstream: https://github.com/coreyhaines31/marketingskills
- Commit: <hash>
- Date: <date>
- Skills: product-marketing, copywriting, copy-editing, ai-seo, content-strategy
- Local modifications: (list any, ideally none)
```

Do **not** vendor the full 47-skill set — pollutes triggering. The orchestrator invokes vendored skills explicitly; their descriptions should be de-emphasized so they don't fire on unrelated tasks.

---

## 4. Configuration

### Location & scoping
- **All config is per-user and gitignored.** Nothing config-related is committed to the app repo.
- Path: `~/.config/shopify-apps-doc-writer/<app-key>.json` (e.g. `storeseo.json`).
- Auth state: `~/.config/shopify-apps-doc-writer/<app-key>.auth.json` (Playwright storageState). Never in repo, never in output dirs.
- Team consistency comes from the plugin (SKILL.md conventions, doc template, viewport default), not from shared config.
- **Exception:** the product-marketing context is team-shared truth, keyed per app. Setup asks: "save to repo (`.agents/<app-key>.product-marketing.md`) or keep personal (`~/.config/.../<app-key>.product-marketing.md`)?" Default: repo.

### Schema

```jsonc
{
  "appKey": "storeseo",
  "store": "storeseo-dev.myshopify.com",
  "appHandle": "storeseo",
  "storageState": "~/.config/shopify-apps-doc-writer/storeseo.auth.json",
  "viewport": { "width": 1440, "height": 900 },
  "locale": "en",
  "capture": {
    "mode": "full-admin",              // "full-admin" | "iframe" (per-shot override in manifest)
    "outputDir": "docs",              // relative to repo root
    "browser": "chromium",
    "headless": true
  },
  "publish": {
    "target": "google-docs",          // "local" | "google-docs" | "mcp"
    "mcp": { "hint": "notion" },      // only when target=mcp
    "parentFolderId": "…",            // target-specific location (Drive folder, Notion parent page, …)
    "supportsImages": true            // recorded during setup capability probe
  }
}
```

Multiple apps = multiple config files keyed by `appKey`. Commands accept `--app <key>`; default to the single config if only one exists, otherwise prompt.

---

## 5. `/docs-setup` — Setup Wizard

Phased and resumable. `/docs-setup` runs all phases; `/docs-setup auth|publish|context` runs one phase. Each phase writes config incrementally so partial setup is never lost.

### Phase 1 — Capture (auth)
1. Ask: dev store URL, app handle. Confirm viewport default 1440×900 (don't ask open-ended).
2. Run `scripts/setup-auth.js`:
   - Spawn **real Google Chrome** with `--remote-debugging-port` and a dedicated profile dir, then attach over CDP. Playwright-*launched* browsers (bundled Chromium and `channel:'chrome'` alike) are rejected by Shopify's login page — it silently no-ops the submit.
   - User logs into Shopify admin manually (handles 2FA/captcha — the script never touches credentials).
   - Persist storageState to the per-user auth path.
3. **Verification shot:** immediately navigate to `/admin/apps/<handle>` headless with the saved state, screenshot, show the user. Catches wrong store / app not installed / session issues at setup time.
4. On any later capture failure due to expired session, `capture.js` exits with a distinct error code; the skill instructs the user to run `/docs-setup auth` again. Graceful re-auth is a day-one requirement (storageState longevity on dev stores is unvalidated).

### Phase 2 — Publish target discovery
1. Enumerate connected MCP tools. Filter to plausible document destinations (Google Docs/Drive, Notion, Confluence, ClickUp Docs, etc.).
2. Present the filtered list: *"I found these possible destinations: … Pick one, or stay local-only."* User confirms — never auto-select.
3. Lightweight capability probe on the chosen target: can it create a document? Can it accept images? Record `supportsImages` in config.
4. Ask for the destination location (folder ID / parent page) where applicable.
5. If nothing relevant is connected → default `target: local`, tell the user they can rerun `/docs-setup publish` after connecting something.

### Phase 3 — Product context
1. Offer to generate `product-marketing.md` (foundation doc that all vendored skills read first).
2. Claude drafts it from: app landing page, Shopify App Store listing, plus a short interview. User reviews before save.
3. Ask: save to repo (shared, default) or personal config dir.
4. Skippable — the orchestrator warns (but proceeds) if it's missing at `/write-docs` time.

---

## 6. Shot Manifest

The contract between discovery and capture. Lives at `docs/<feature-slug>/manifest.json`, git-versioned with the doc.

### Schema

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

### Rules
- **IDs are ordered and zero-padded** (`01-`, `02-`…) → filenames `screenshots/01-navigate.png`.
- **Selector policy (enforced by SKILL.md):** prefer `data-testid` > aria-label / role > visible text. **Never** hashed Polaris class names — they change every release and silently break re-capture. Missing `data-testid` coverage in the app is a finding to report, not a reason to use fragile selectors.
- `crop`: `"full-admin"` (context/navigation shots — shows merchants where the feature lives) or `"iframe"` (feature detail — crops to the app iframe bounding box).
- `waitFor` is required per shot. Polaris skeleton loaders will photobomb otherwise. Default strategy: network idle **and** selector visible.
- Supported actions (v1): `click`, `fill`, `select`, `hover`, `press`, `waitMs` (last resort, discouraged).
- Manifest is executed only after **gate #1** (user approves the shot list).

---

## 7. Orchestrator SKILL.md — Required Content

Frontmatter description must be "pushy" for reliable triggering, e.g.:

> *Write merchant-facing feature documentation for a Shopify app with real screenshots. Use whenever the user wants to document a feature, write a help article, user guide, how-to, or knowledge-base entry for the app, update feature docs after a release, or mentions `/write-docs` — even if they don't say "documentation" explicitly.*

Body must cover:

1. **Preflight:** load config (fail with pointer to `/docs-setup` if missing); read `product-marketing.md` if present; ask which audience (merchant / internal) and doc type (new / rewrite) if ambiguous.
2. **Discovery phase:** gather feature understanding from (in preference order) the feature's ClickUp task/spec, the relevant code/PR, and interactive browsing of the live feature (Playwright MCP / claude-in-chrome). Derive the step-by-step flow from what was actually observed, not assumptions.
3. **Manifest authoring:** produce the shot manifest per §6; present it for approval — **gate #1**. Show shot count, pages touched, and any destructive-looking actions (there should be none; read-only navigation only — never actions that mutate store data).
4. **Capture:** run `scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>`. On auth-expiry exit code, direct user to `/docs-setup auth`. Show the captured screenshots inline for a quick visual sanity check.
5. **Writing:** follow `references/doc-template.md`; invoke vendored skills explicitly — `content-strategy` for structure decisions, `copywriting` for draft, `copy-editing` for polish pass, `ai-seo` for LLM-citability (headings as questions, self-contained sections, schema-friendly structure). Embed screenshots by relative path with captions.
6. **Draft review — gate #2:** present `index.md`; iterate until approved. Nothing leaves the repo before this.
7. **Publish (optional):** per `references/publish-targets.md` (see §9). **Gate #3** before any external write: show exactly what will be created/uploaded ("1 Google Doc + 8 images to folder X"), require explicit yes.
8. **Wrap-up:** write/refresh `meta.json`; summarize outputs and paths.

Also encode: tone rules (merchant-friendly, no internal jargon, "you/your store"), screenshot conventions (consistent viewport, no personal data visible), and the selector policy from §6.

Target: SKILL.md body < 500 lines; push detail into `references/`.

### Doc template (`references/doc-template.md`)

```md
# <Feature Name>
> One-sentence value statement (what merchant outcome this enables).
## Overview            — what it is, who it's for, plan availability
## Prerequisites       — plan, setup steps, permissions (omit if none)
## How to <primary task>
   Step-by-step; one screenshot per meaningful UI state; numbered steps
   reference numbered screenshots.
## <Secondary tasks>   — repeat pattern as needed
## FAQ                 — 3–6 real questions, answers self-contained (ai-seo)
## Troubleshooting     — symptom → cause → fix (omit if none known)
```

---

## 8. Output Contract

Every `/write-docs` run produces (canonical, regardless of publish target):

```
docs/<feature-slug>/
├── index.md            # the doc — screenshots referenced by relative path
├── manifest.json       # shot manifest (reproducibility)
├── meta.json           # see below
└── screenshots/
    ├── 01-navigate.png
    └── 02-sov-dashboard.png
```

### meta.json

```json
{
  "title": "AI Brand Visibility",
  "slug": "ai-brand-visibility",
  "app": "storeseo",
  "audience": "merchant",
  "status": "draft",
  "createdAt": "2026-07-23T…",
  "contentHash": "sha256 of index.md",
  "publish": {
    "target": "google-docs",
    "url": "https://docs.google.com/…",
    "publishedAt": "…",
    "publishedHash": "sha256 at publish time"
  }
}
```

`contentHash` vs `publishedHash` is the hook for v2 `/update-docs` staleness detection ("copy changed since last publish — re-push?").

---

## 9. Publish Targets (`references/publish-targets.md`)

### `local`
Done at gate #2. Print the path. No gate #3 needed.

### `google-docs` (hardcoded known-good path)
1. Upload screenshots to Drive (configured parent folder or a per-doc subfolder).
2. Create the Doc; convert markdown structure (headings, lists, bold) via the Docs API; insert images inline (`insertInlineImage` referencing the uploaded Drive files) at their markdown positions.
3. Write resulting URL into `meta.json`.

### `mcp` (generic adaptive path)
1. Inspect connected MCP tools; match against `publish.mcp.hint`; if ambiguous or missing, ask the user which connector to use.
2. Determine the create-document / create-page call from the tool schemas.
3. **Image fallback rule:** if the target cannot ingest images (per setup probe or runtime failure), publish text with placeholder markers — `[Screenshot: 02-sov-dashboard — see docs/<slug>/screenshots/]` — and tell the user where the PNGs live. Degraded, never broken.
4. Write resulting URL/ID into `meta.json`.

All external targets: gate #3 (explicit confirmation with a precise summary of what will be written where) is mandatory and non-skippable.

---

## 10. Scripts

### `scripts/setup-auth.js`
- Args: `--app <key>` (or interactive).
- Spawn real Chrome (CDP port 9333, dedicated profile dir) at `https://<store>/admin` and attach with `connectOverCDP`; reuse an already-listening browser if one is there; wait for the user to complete login (poll every page for an authenticated-admin selector); export storageState from `contexts()[0]` to the per-user path; quit the Chrome we spawned; run the verification shot; print result path.

### `scripts/capture.js`
- Args: `--manifest <path> --app <key> [--only <shot-id>] [--headed]`.
- Load config + storageState → launch browser at configured viewport → execute shots sequentially.
- Per shot: navigate → run actions → apply wait strategy → screenshot (full page viewport for `full-admin`; iframe element bounding box for `iframe`) → save `screenshots/<id>.png`.
- Exit codes: `0` success · `10` auth expired (skill maps this to "run `/docs-setup auth`") · `20` selector timeout (report which shot/selector — likely UI changed, manifest needs updating) · `1` other.
- `--only` enables re-capturing a single stale shot without a full run.
- Read-only guarantee: script refuses manifests containing actions against elements matching submit/destructive patterns unless a `"mutation": true` flag is set on the shot — and the SKILL.md forbids Claude from setting that flag in v1.

### Dependencies
- `playwright` (chromium). Postinstall or first-run check: `npx playwright install chromium` with a friendly prompt.
- Node ≥ 20. No other runtime deps beyond dev-standard.

---

## 11. Gates Summary (hard requirements)

| # | When | What the user approves |
|---|------|------------------------|
| 1 | Before capture | The shot manifest: shot list, pages, actions |
| 2 | Before anything leaves local | The full draft doc |
| 3 | Before external publish | Exact summary of writes to the external target |

No gate may be auto-approved. Publishing never happens in the same breath as drafting.

---

## 12. Build Order (walking skeleton first)

1. **Validate the risky unknowns:** storageState longevity on the dev store; iframe screenshot fidelity. → `setup-auth.js` + a 2-shot hand-written manifest + `capture.js` happy path.
2. First end-to-end run on a **small feature** (⌘K command palette — small surface, easy to verify) before AI Insights.
3. Orchestrator SKILL.md + doc template + `/write-docs` command.
4. `/docs-setup` full wizard (phases 2–3 can lag phase 1).
5. Vendor skills + VERSIONS.md; wire into writing phase.
6. Publish: local → google-docs → generic mcp, in that order.
7. Description-triggering pass (skill-creator's optimizer) once stable.

## 13. v2 Backlog

- Annotation pipeline: highlight rects/arrows drawn from manifest coords (sharp/canvas post-process); blur/redaction boxes.
- `/update-docs`: contentHash-vs-publishedHash staleness detection; `capture.js --only` driven re-shoots; publish diffing.
- Demo-data seeding script for the dev store.
- Multi-locale capture (config `locale` array → per-locale screenshot sets).
- BetterDocs / docs-site MCP as a first-class publish target.

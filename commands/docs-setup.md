---
description: Set up shopify-feature-docs — auth, publish target, and product context (resumable, phased)
argument-hint: "[auth|publish|context] [--app <key>]"
---

Run the shopify-feature-docs setup wizard. Argument given: **$ARGUMENTS**

- No phase argument → run all three phases in order.
- `auth`, `publish`, or `context` → run only that phase.
- Each phase writes config incrementally as soon as it completes, so partial setup is never lost. If config already exists for a phase, show current values and ask whether to keep or redo them.

Config lives at `~/.config/shopify-feature-docs/<app-key>.json` (per-user, never committed to the repo). Auth state lives at `~/.config/shopify-feature-docs/<app-key>.auth.json`. Multiple apps = multiple config files; `--app <key>` selects one, and with no flag: use the single existing config if there is exactly one, otherwise ask.

## Phase 1 — Capture (auth)

1. Ask the user for, in one round of questions:
   - Dev store URL (e.g. `storeseo-dev.myshopify.com`)
   - App handle (the slug in `/admin/apps/<handle>`)
   - App key (short id for config, e.g. `storeseo` — suggest one derived from the handle)
   - Viewport: confirm the default **1440×900** (yes/no, don't ask open-ended).
2. Write the config skeleton (store, appHandle, appKey, viewport, locale `en`, capture defaults: mode `full-admin`, outputDir `docs`, browser `chromium`, headless `true`).
3. Run `node scripts/setup-auth.js --app <key>` from the plugin root. This launches a **headed** browser; tell the user to log into the Shopify admin in that window (2FA/captcha are handled by them — the script never sees credentials). The script waits for login, saves Playwright storageState to the per-user auth path, then takes a headless **verification screenshot** of `/admin/apps/<handle>` with the saved session.
4. Show the verification screenshot to the user and ask them to confirm it shows their app inside the admin. This catches wrong store / app not installed / broken session at setup time, not mid-capture.
5. If the script exits with code 10 or the verification shot shows a login page, the session didn't stick — rerun the script.

Note for later: whenever `scripts/capture.js` exits with code **10** (auth expired), the fix is rerunning this phase: `/docs-setup auth`.

## Phase 2 — Publish target discovery

1. Enumerate the MCP tools connected in this session. Filter to plausible **document destinations** (Google Docs/Drive, Notion, Confluence, ClickUp Docs, and the like). Ignore everything else.
2. Present the filtered list: "I found these possible destinations: … Pick one, or stay local-only." **Never auto-select** — the user chooses.
3. If they choose Google Docs/Drive → set `publish.target: "google-docs"`. If they choose another connector → set `publish.target: "mcp"` and record `publish.mcp.hint` (e.g. `"notion"`). If they choose local-only or nothing relevant is connected → set `publish.target: "local"` and tell them they can rerun `/docs-setup publish` after connecting a destination.
4. For external targets, run a **lightweight capability probe** using the tool schemas (do not create anything yet): can it create a document? Can it accept/embed images? Record `publish.supportsImages` accordingly. If image support can't be determined from schemas, record `false` and note that runtime fallback (placeholder markers) will apply.
5. Ask where docs should go — Drive folder ID, Notion parent page, space key, etc. — and record it as `publish.parentFolderId`.

## Phase 3 — Product context

1. Offer to generate `product-marketing.md` — the foundation doc that the writing skills read before drafting anything (positioning, audience, tone, key terms).
2. If accepted, draft it from: the app's landing page, its Shopify App Store listing, and a short interview with the user (target customer, top 3 value props, words/claims to avoid). Show the draft; iterate until they approve.
3. Ask where to save it:
   - **Repo** (`.agents/product-marketing.md`) — shared team truth. **Default.**
   - Personal (`~/.config/shopify-feature-docs/<app-key>.product-marketing.md`) — if they'd rather not commit it.
4. This phase is skippable. If skipped, `/write-docs` will warn that product context is missing but proceed anyway.

## Wrap-up

Summarize what's configured: app key, store, auth state path + verified-at, publish target (+ image support), product context location. List any phase still pending and the command to run it.

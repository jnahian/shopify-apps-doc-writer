---
description: Write a merchant-facing feature doc with real screenshots for a Shopify app
argument-hint: <feature> [--app <key>]
---

Invoke the `shopify-apps-doc-writer` skill and follow it end to end for the feature the user named: **$ARGUMENTS**

Rules of engagement (the skill has the full detail — these are the non-negotiables):

1. **Preflight first.** Load per-user config from `~/.config/shopify-apps-doc-writer/`. If no config exists, stop and point the user to `/docs-setup`. If `--app <key>` was passed, use that config; if exactly one config exists, use it; otherwise ask which app.
2. **Three hard gates, none skippable, none auto-approvable:**
   - Gate 1: user approves the shot manifest before any capture runs.
   - Gate 2: user approves the full draft doc before anything leaves the local repo.
   - Gate 3: user approves an exact summary of external writes before any publish.
3. **Capture is deterministic.** All screenshots come from `scripts/capture.js` executing the approved manifest — never from ad-hoc browsing.
4. **Read-only.** The manifest must never contain actions that mutate store data.
5. Canonical output is always `docs/<feature-slug>/` (index.md, manifest.json, meta.json, screenshots/). Publishing is an optional projection of it.

If the user gave no feature name, ask which feature to document before doing anything else.

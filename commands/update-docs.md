---
description: Refresh an existing feature doc after a UI or copy change (v2 — coming soon)
argument-hint: <feature-slug>
---

Tell the user, briefly and without doing anything else:

`/update-docs` is planned for v2. It will compare `contentHash` vs `publishedHash` in `docs/<slug>/meta.json` to detect staleness, re-shoot only changed screenshots, and diff before re-publishing.

Until then, the manual path already works:

- **Re-capture screenshots after a UI change:** `node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>` re-runs the whole manifest deterministically; add `--only <shot-id>` to re-shoot a single stale screenshot.
- **Update copy:** edit `docs/<slug>/index.md`, then run `/write-docs` and say it's a rewrite of the existing doc if you want help with the prose.
- **Re-publish:** ask to publish the doc again; the normal gate-3 confirmation applies.

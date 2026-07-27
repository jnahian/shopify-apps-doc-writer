---
description: Pre-release staleness sweep — re-shoot every doc's manifest and report which docs drifted
argument-hint: "[--app <key>]"
---

Check every doc under `docs/` for staleness. This command is **report-only**:
it fixes nothing, writes nothing, and therefore needs no confirmation gates.

## 1. Run the sweep

```bash
node scripts/update-check.js --all --app <key>
```

Parse the JSON on stdout: `{ docs, skipped, checked, anyDrift }`.

- Exit `10`: auth expired — run `/docs-setup auth`, then re-run.
- Exit `1`: show the error verbatim and stop.

## 2. Present the results

One line per entry in `docs`:

- `error: "selector-timeout"` → **selector broken** — the UI changed
  structurally; drift could not be measured for this doc.
- `error: "capture-failed"` → **capture crashed** for this doc (not auth, not
  a selector) — show it and suggest re-running that doc's capture alone to see
  the real error: `node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>`.
- else if `copy.changed` is true or `screenshots.changedCount > 0` → **stale**;
  say exactly what: "copy changed", "N of M shots changed" (list the changed
  `shots[].file` names), and append "(draft)" when `published` is false.
- else → **up to date**.

Also report:

- `skipped` dirs with their reasons (not valid doc dirs — missing or
  malformed manifest/meta/index.md);
- any `shots[].skipped: true` as "re-shot but deliberately not compared
  (`driftCheck: false` — volatile content)". Never imply those were verified.

## 3. Route the fixes (do not perform them)

- Stale **published** doc → tell the user to run `/update-docs <slug>`
  (gated screenshot promotion + re-publish).
- Stale **draft** (`published: false`) → refresh the local screenshots:
  `node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>`
  — no publish involved, so no gate.
- `selector-timeout` → the manifest needs updating and re-approval via
  `/write-docs`.

## Notes

- All captures go through `capture.js` (read-only guarantee). The sweep
  deletes its own temp dirs; there is nothing to clean up.
- A future release workflow (`app-release`) can run `/docs-check` as its
  first step — this command is deliberately self-contained.

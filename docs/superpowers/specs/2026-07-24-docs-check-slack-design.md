# `/docs-check` Staleness Sweep + Slack Review Notification — Design

**Status:** approved (2026-07-24)
**Subsystem:** workflow glue — pre-release drift sweep + reviewer notification
**Depends on:** `scripts/update-check.js` + `scripts/lib/staleness.js` (staleness spec, 2026-07-24), `/docs-deploy` (docs-site spec, 2026-07-24), Slack MCP (draft mechanism)

## Goal

Two small pieces of workflow glue:

1. **`/docs-check`** — a one-command pre-release sweep: re-shoot every doc's
   manifest, report which docs went stale, and route the user to the right
   fix. Designed so a future `app-release` skill can call it as one line.
2. **Slack review notification** — after a successful `/docs-deploy`, offer to
   notify reviewers in Slack with the site URL. Delivered as a Slack **draft**
   the user sends themselves — never auto-sent.

## Decisions (from brainstorm)

- **`app-release` does not exist yet.** The sweep is standalone; nothing here
  assumes or references an app-release implementation. Integration later is
  "call `/docs-check` first".
- **Scan-all lives in `update-check.js` as `--all`** (approach A), reusing the
  existing per-doc drift machinery — not a command-layer loop (which would
  inherit the unpublished-doc short-circuit and force Claude to hand-aggregate
  N reports), and not a separate script (duplication).
- **Drafts are swept too.** This un-defers part of the staleness spec's
  "no scan-all mode": a pre-release check cares that the UI moved under a
  draft's screenshots even if the doc was never published.
- **Report-only.** `/docs-check` changes nothing (no promotion, no publish),
  so it needs no confirmation gates. Fixes route through existing gated
  commands.
- **Slack folds into `/docs-deploy`** — no separate notify command. "Never
  auto-send" is enforced structurally by Slack's draft mechanism, not by a
  promise.

## Design

### 1. `update-check.js --all`

New invocation (existing single-doc form unchanged):

```bash
node scripts/update-check.js --all --app <key>
```

- Resolves the docs root from config (`capture.outputDir`); `--manifest` and
  `--all` are mutually exclusive (error if both or neither given).
- Iterates every `docs/*/` subdir that has **both** `manifest.json` and
  `meta.json`; dirs missing either are reported as skipped, never a crash.
- Per doc, reuses the existing drift logic (`run()` internals) with one
  behavioral extension, applied only in `--all` mode:
  - **Screenshot drift** is checked for every doc — including never-published
    ones — by re-shooting into a temp dir (still via `capture.js`, the only
    screenshotter) and comparing against `docs/<slug>/screenshots/`.
  - **Copy drift** applies only where `meta.publish.publishedHash` exists;
    otherwise `copy: null`.
  - The single-doc code path keeps today's semantics exactly (unpublished →
    `published: false`, no capture): `/update-docs` is still about refreshing
    *published* docs.
- **Temp dirs are deleted immediately** after each doc's comparison. The sweep
  is report-only; nothing is promoted, so nothing needs to survive the run.
- **Error containment:** a selector timeout while re-shooting one doc is
  recorded as that doc's `error` (`"selector-timeout"`) and the sweep
  continues with the next doc. Auth expiry aborts the entire run with exit
  `10` — every subsequent doc would fail identically.
- Output contract (same style as today — human report to stderr, JSON to
  stdout):

```jsonc
{
  "docs": [
    {
      "slug": "ai-brand-visibility",
      "published": true,
      "copy": { "changed": false },          // null when never published
      "screenshots": { "changedCount": 2, "skippedCount": 0, "total": 8, "shots": [ /* per-shot, as today */ ] },
      "error": null                           // or "selector-timeout"
    }
  ],
  "skipped": [ { "dir": "not-a-doc", "reason": "no manifest.json" } ],
  "checked": 3,
  "anyDrift": true
}
```

- Exit codes: `0` sweep completed (drift or not, including per-doc selector
  errors); `10` auth expired; `1` other fatal errors. Exit `20` is not used in
  `--all` mode — selector failures are per-doc data, not a run failure.

### 2. `commands/docs-check.md` (new)

Instructs Claude to:

1. Run the sweep; parse the stdout JSON.
2. Present a per-doc summary table: up-to-date · stale (N of M shots, copy
   changed?) · selector-broken · plus skipped dirs and `driftCheck: false`
   shots (reported as "re-shot but deliberately not compared", as
   `/update-docs` does).
3. Route each finding — this command fixes nothing itself:
   - stale **published** doc → run `/update-docs <slug>` (gated re-publish);
   - stale **draft** → refresh local screenshots via
     `node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>`
     (no publish involved);
   - `selector-timeout` → the UI changed structurally; the manifest needs
     updating and re-approval via `/write-docs`;
   - auth exit `10` → `/docs-setup auth`, then re-run.
4. No confirmation gates: the command performs no writes beyond `capture.js`'s
   read-only-guaranteed browsing.

### 3. Slack notification in `/docs-deploy`

Amends `commands/docs-deploy.md` (created by the docs-site plan) with a final
optional step after a successful deploy:

1. Offer once: "Notify reviewers in Slack?" Declining skips silently.
2. Channel comes from per-user config `deploy.slackChannel`. If unset, ask the
   user for the channel, then save it into
   `~/.config/shopify-apps-doc-writer/<app-key>.json` for next time (config
   stays per-user and uncommitted, per SPEC §4).
3. Compose a short message: site URL, doc count, and which docs are drafts /
   newly deployed. Show it to the user.
4. Deliver via the Slack MCP **draft** tool (`slack_send_message_draft`): the
   message lands in the user's Slack drafts for that channel, and they send it
   themselves. The direct-send Slack tool is never used by this flow.
5. If no Slack MCP is connected, say so and print the message for manual
   copy-paste — degraded, never broken (same philosophy as publish-targets'
   image fallback).

### 4. Components (units of change)

- `scripts/update-check.js` — `--all` mode: docs-root iteration, per-doc
  drift with the drafts-included extension, aggregation, temp-dir cleanup,
  error containment. Single-doc path untouched.
- `commands/docs-check.md` — new command (report + routing).
- `commands/docs-deploy.md` — append the Slack step.
- README / CLAUDE.md — command lists gain `/docs-check`; `update-check.js`
  usage line gains `--all`.

### 5. Error handling

- Sweep: per-doc failures degrade to per-doc `error` entries; only auth
  expiry (10) and truly fatal errors (1) abort. Malformed doc dirs are
  skipped with reasons.
- Slack: missing MCP → print-for-copy-paste fallback; user declines → no-op.
- Nothing in either flow mutates `docs/*/` or external systems.

### 6. Testing

- `scripts/update-check.test.js` — new scan-all cases via the existing
  injected `capture` / `tmpFactory` seams. Fixture: four dirs — stale
  published doc, clean published doc, never-published draft with screenshot
  drift, dir missing `manifest.json`. Assert: aggregate counts, draft's
  screenshot drift detected with `copy: null`, skip entry, temp dirs removed,
  selector-timeout in one doc doesn't abort the others.
- Slack step and `/docs-check` presentation are prose commands — verified by
  one real run each.

## Non-goals

- No auto-fixing: `/docs-check` never promotes screenshots, edits manifests,
  or publishes.
- No `app-release` skill here — this only makes the future one-line
  integration possible.
- No Slack channel-per-doc or mention routing; one team channel per app.
- No scheduled/CI execution of the sweep (needs interactive auth and a local
  Chrome; revisit if that constraint ever changes).

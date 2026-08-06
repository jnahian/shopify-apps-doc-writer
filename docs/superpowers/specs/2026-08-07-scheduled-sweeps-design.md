# Scheduled Staleness Sweeps (0.6.0) — Design

**Date:** 2026-08-07
**Status:** agreed in brainstorm
**Roadmap:** SPEC.md §13, item 0.6. Designed while 0.4 (annotation pipeline)
is unstarted and 0.5 (re-publish diffing) is spec'd but unbuilt; ships as
0.6.0 to keep the roadmap numbering. Own branch, independent of both.

## Problem

`/docs-check` only runs when someone remembers to run it. Docs drift silently
between releases — from our own UI changes and from Shopify/Polaris changes we
don't control — and the first person to notice is a merchant reading a stale
screenshot. §13 committed to scheduled sweeps with two constraints fixed up
front: sweeps only **report** (the no-unconfirmed-publishing rule stands), and
auth state is per-user and never shared, so nothing cloud-hosted can run one.

## Decision summary

A plain OS scheduler runs the existing deterministic sweep locally, with no
Claude session at all; the result lands in a file, and the plugin's
SessionStart hook surfaces it the next time the user opens a session. Claude —
and the existing draft-only Slack path — enter only when the user is present.

Trigger is a **fixed schedule** (daily), not release-triggered: it needs no
coupling to any release process and also catches drift from Shopify-side UI
changes, which release hooks would miss.

Rejected alternatives: a scheduled headless `claude -p "/docs-check"` (burns
tokens per run even when nothing drifted; interactively-authenticated MCP
servers — including Slack — are generally absent headless, so the committed
reporting path would silently fail; and unattended bot challenges have no
remedy, since exit 30's fix is `--headed`); auto-sending Slack from the script
via webhook (abandons draft-only, adds per-user webhook config — possible
later add-on, not the design).

### 1. New script: `scripts/schedule-sweep.js`

Installs, removes, and reports the schedule. macOS-only in 0.6.0 (clear error
elsewhere; Linux cron deferred until someone needs it).

- `--install --app <key> [--at HH:MM]` (default `03:00`) writes:
  - a launchd plist at
    `~/Library/LaunchAgents/com.shopify-apps-doc-writer.sweep.<app-key>.plist`
    using `StartCalendarInterval` — launchd runs a missed interval on wake, so
    a laptop asleep overnight still sweeps in the morning; runs missed while
    powered off are skipped (the next day covers it);
  - a wrapper shim (below) that the plist executes;
  then loads the job via `launchctl`. Re-installing for the same app replaces
  both — one schedule per app key.
- `--uninstall --app <key>` unloads the job and deletes plist + shim.
- `--status --app <key>` reports whether the job is loaded, the schedule, and
  the last sweep result from `sweep.json`.

### 2. The wrapper shim (why the plist doesn't call the plugin directly)

Installed plugins live under a version-numbered cache path, so any absolute
path into the plugin breaks on every plugin update. The plist therefore runs
`~/.config/shopify-apps-doc-writer/<app-key>.sweep-runner.sh`, which resolves
the *current* plugin root at run time:

- `hooks/ensure-deps.js` (already a SessionStart hook) additionally writes
  `CLAUDE_PLUGIN_ROOT` to the one-line pointer file
  `~/.config/shopify-apps-doc-writer/plugin-root` every session.
- The shim reads the pointer, `cd`s to the docs repo, and execs
  `node <plugin-root>/scripts/sweep.js --app <key>`.
- Baked into the shim at install time: the docs-repo path (the cwd where
  `/docs-schedule` was run), the app key, and the absolute node path
  (`process.execPath`) — launchd's PATH is nearly empty.

Consequence: a sweep scheduled before a plugin update keeps working after it,
as soon as one session has run the hook. If no session ever ran since the
update, the pointer is stale and the sweep fails visibly into its log and
`sweep.json` — surfaced by the notice, not silent.

### 3. New script: `scripts/sweep.js` (what the shim runs)

Wraps the existing sweep, adds classification and persistence — no new
capture logic:

- Spawns `update-check.js --all --app <key>` (same contract `/docs-check`
  uses) and classifies the outcome from exit code + JSON:
  `ok` | `drift` | `auth-expired` (10) | `bot-challenge` (30) | `error`.
- Writes `~/.config/shopify-apps-doc-writer/<app-key>.sweep.json`:
  `{ at, status, summary }` where `summary` carries what the notice needs —
  stale slugs with copy/shot counts, skipped dirs, per-doc errors — plus the
  raw `update-check` JSON for `/docs-check` to reuse. Overwritten each run:
  latest state is the only state, so a clean sweep clears a previous drifty
  one and there is no acknowledgment bookkeeping.
- Always writes `sweep.json`, even on crash (top-level catch → `status:
  "error"` with the message), so a broken sweep is visible rather than absent.
- Stdout/stderr go to `<app-key>.sweep.log` beside it (plist
  `StandardOutPath`/`StandardErrorPath`) for debugging.
- Report-only by construction: `update-check.js` re-shoots to temp, compares,
  deletes temp; `sweep.js` adds no write paths beyond `sweep.json` + log.

### 4. SessionStart notice (in `hooks/ensure-deps.js`)

The hook's second job: read every `*.sweep.json` and inject at most a line or
two of session context when the latest result warrants it —

- `drift` → "Scheduled sweep (Aug 12, 03:00) found 2 stale docs: ai-seo,
  image-optimizer — run `/update-docs <slug>`, or `/docs-check` for the full
  report + Slack draft."
- `auth-expired` → "Scheduled sweeps are blocked — run `/docs-setup auth`."
- `bot-challenge` → "Last scheduled sweep was bot-challenged; run
  `/docs-check` yourself (headed capture) to get a real result." No manifest
  blame, per the exit-30 contract.
- `error` → one line with the log-file path.
- **Stuck schedule:** if `sweep.json` exists but `at` is older than ~2 days
  (2× the daily interval), say the schedule looks stuck and point at
  `--status`.
- `ok` and fresh → silence. No file → silence (sweeps never scheduled).

The notice repeats each session until a sweep comes back clean — which
happens naturally once the docs are fixed. Deliberate, acceptable nagging for
a report-only signal.

### 5. New command: `/docs-schedule`

Markdown orchestration only: confirm cwd is the docs repo, resolve the app
key, confirm the time, then run `schedule-sweep.js`. Writing a LaunchAgent is
a machine-config change, so the command confirms before installing — a plain
confirmation, not a fourth hard gate (it's local and reversible, unlike
publishing). Subcommands `off` and `status` map to `--uninstall`/`--status`.

### 6. Slack stays human-gated

The scheduled run never touches Slack. The roadmap's "report through the
existing draft-only Slack path" is reached by the user running `/docs-check`
after seeing a notice — the draft is composed with the user present, exactly
as today. This is a deliberate reading of §13: a draft nobody is around to
review is not a report, and Slack MCP is not reliably reachable from launchd
anyway.

### 7. Release

- Version bump to **0.6.0** in `.claude-plugin/plugin.json` and
  `package.json`, CHANGELOG entry.
- SPEC.md §13: mark 0.6 shipped; note 0.4 and 0.5 remain queued.

## Out of scope

- Release-triggered sweeps (a future `app-release` workflow can still call
  `/docs-check` directly, per that command's notes).
- Any auto-send Slack path or webhook config.
- Linux/Windows scheduling.
- Auto-repairing a stale plugin-root pointer from the sweep itself (the
  SessionStart hook is the repair; failure is visible).
- Multi-machine coordination — the schedule belongs to whichever machine ran
  `/docs-schedule`.

## Testing

TDD per CLAUDE.md; the `launchctl`/filesystem boundary stays thin and the
logic pure:

- `schedule-sweep.test.js`: plist and shim generation as string-returning
  functions — correct label, calendar interval from `--at`, node path, docs
  repo, log paths; `--at` validation; non-macOS refusal.
- `sweep.test.js`: outcome classification from exit code + JSON fixtures
  (ok/drift/10/30/crash); `sweep.json` shape; crash still writes the file.
- Hook notice formatting from `sweep.json` fixtures (drift lists slugs,
  stuck-schedule detection, silence on fresh-ok and on no file).
- `launchctl bootstrap/bootout` calls themselves are not unit-tested —
  verified by hand at build time: install, force a run, observe `sweep.json`,
  uninstall.

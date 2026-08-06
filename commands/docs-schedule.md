---
description: Schedule a daily background staleness sweep (macOS) — results surface as a notice at your next session
argument-hint: "[off|status] [--app <key>] [--at HH:MM]"
---

Manage the scheduled staleness sweep. The sweep is the same deterministic
check `/docs-check` runs (`update-check.js --all`), executed daily by launchd
with no Claude session; it only **reports** — results land in
`~/.config/shopify-apps-doc-writer/<app-key>.sweep.json` and show up as a
one-line notice when you next start a session. Nothing is ever published or
sent to Slack unattended; you act on a notice by running `/update-docs
<slug>` or `/docs-check` yourself.

Argument given: **$ARGUMENTS** — empty means install (or replace); `off` means uninstall; `status` means inspect the schedule. `--app` and `--at` pass through to the script.

macOS only (launchd). On other platforms the script refuses with a clear
message — tell the user Linux cron support is deferred.

`<plugin-root>` below is the directory holding `.claude-plugin/`.

## No argument → install (or replace)

1. **Confirm the docs repo.** The schedule bakes in the *current directory*
   as the docs repo. Verify cwd contains the app's docs (the `docs/` dir, or
   whatever `capture.outputDir` is configured as). If it doesn't look like
   the docs repo, stop and ask the user to `cd` there and re-run.
2. **Resolve the app key** (`--app`, or the single existing config — same
   rule as every other command).
3. **Confirm before writing.** This writes a LaunchAgent plist and a runner
   shim on the user's machine — a plain confirmation, not one of the three
   hard gates (it is local and reversible). Show exactly:
   - schedule: daily at `<HH:MM>` (default `03:00`; `--at` overrides — ask
     if the user wants a different time)
   - docs repo: `<cwd>`
   - files: `~/Library/LaunchAgents/com.shopify-apps-doc-writer.sweep.<key>.plist`
     and `~/.config/shopify-apps-doc-writer/<key>.sweep-runner.sh`
4. On yes:

   ```bash
   node <plugin-root>/scripts/schedule-sweep.js --install --app <key> --at <HH:MM>
   ```

   If the script exits nonzero (invalid `--at` format, unsafe app key, or `launchctl bootstrap` failure): show its stderr verbatim and stop — do not retry or edit files by hand.

   On success: run `--status` and show the user the output. Mention that
   re-running `/docs-schedule` any time replaces the schedule (one per app),
   and `/docs-schedule off` removes it.

## `off` → uninstall

```bash
node <plugin-root>/scripts/schedule-sweep.js --uninstall --app <key>
```

Removes the launchd job, plist, shim, the sweep record, and its log —
session notices stop immediately.

## `status`

```bash
node <plugin-root>/scripts/schedule-sweep.js --status --app <key>
```

Show the output as-is: whether the job is installed and loaded, the last
sweep result, and the log path. Route based on the last sweep status:
- `auth-expired` → tell the user to run `/docs-setup auth` and re-enable the sweep
- `drift` → route to `/update-docs <slug>` / `/docs-check` (for the full report + Slack draft)
- `bot-challenge` → tell the user to run `/docs-check` themselves (headed capture); do not suggest touching the manifest
- `error` → show the log path from the status output
- `ok` or `never ran` → nothing to do

## Notes

- The sweep runs `capture.js` under the hood — the read-only guarantee and
  the exit-code contract (10 auth / 30 bot challenge) apply unchanged. Both
  outcomes surface in the next-session notice with their usual remedies.
- The shim resolves the plugin's current install path from
  `~/.config/shopify-apps-doc-writer/plugin-root`, refreshed every session —
  a plugin update doesn't break the schedule as long as a session has run
  since. A schedule whose record goes stale (>2 days) is reported as stuck
  by the session notice.

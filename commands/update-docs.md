---
description: Refresh an existing published feature doc — detect copy/screenshot drift, re-shoot, and re-publish
argument-hint: <feature-slug>
---

Refresh the published doc at `docs/$1/`. Follow these steps exactly; the gates are non-skippable.

## 0. Isolate the work

This command overwrites screenshots and rewrites `meta.json`, so do it in a git worktree — same preflight confirmation as `/shopify-apps-doc-writer:write-docs` (see §0.2 of the `shopify-apps-doc-writer` skill): ask once for the base branch (default the repo's default branch, local not `origin/…`) and the branch/worktree name (default `docs/$1-update`), then `git worktree add .worktrees/<branch> -b <branch> <base>` and run everything below from there. Already in a worktree, not a git repo, or the user declines → work in place and say so.

**Only if `docs/$1/` is tracked** (`git ls-files --error-unmatch docs/$1` succeeds). A worktree contains tracked content only — if this doc isn't committed, a fresh worktree wouldn't have the manifest, screenshots, or `meta.json` to compare against. In that case say so and work in place.

## 1. Detect drift

Run from the docs repo (`update-check.js` resolves paths against the current directory), with `<plugin-root>` the directory holding `.claude-plugin/`:

```bash
node <plugin-root>/scripts/update-check.js --manifest docs/$1/manifest.json --app <key>
```

Parse the JSON printed on stdout.

- If `published` is `false`: tell the user this doc has never been published, so there is nothing to compare against — they should publish it first via `/shopify-apps-doc-writer:write-docs`. Stop.
- If `anyDrift` is `false`: tell the user the doc is up to date since its last publish — nothing to do. Delete `tmpDir` (`rm -rf <tmpDir>`). Stop.

## 2. Report the drift

Show the user, from the JSON:
- whether `copy.changed` is true ("the doc's text changed since publish"), and
- `screenshots.changedCount` of `screenshots.total`, listing each `screenshots.shots[].file` where `changed` is true.
- any shots with `skipped` true — these carry `driftCheck: false` in the manifest and were re-shot but deliberately not compared (volatile content such as third-party widgets). Say so plainly rather than implying they were verified.

## 3. Promote fresh screenshots (local — confirm first)

Skip this step if `screenshots.changedCount` is `0` (copy-only drift — there is nothing to promote); just `rm -rf <tmpDir>` and continue to step 4.

Otherwise, ask the user to confirm overwriting the committed screenshots with the freshly captured ones.

- If they decline: `rm -rf <tmpDir>` and stop. Nothing changed.
- If they approve: for each changed shot, copy `<tmpDir>/<file>` over `docs/$1/screenshots/<file>`, then `rm -rf <tmpDir>`.

## 4. Check the live doc for manual edits (clobber check)

Skip if the doc's config `publish.target` is `local`.

- If `docs/$1/.published-snapshot.md` does not exist (last published before 0.5.0): tell the user the clobber check is unavailable this time — this re-publish writes the snapshot, so it works from the next one. Continue to gate 3 with that caveat.
- Otherwise fetch the live doc's text with the connector's read tool — `google-docs`: Drive `read_file_content` on the file behind `meta.publish.url`; generic `mcp`: whatever read operation the connector's schema offers. If the fetch fails or the connector has no read tool, carry "could not check for manual edits: <reason>" into the gate 3 summary — never drop the check silently.
- Save the fetched text to a scratch file and run:

  ```bash
  node <plugin-root>/scripts/lib/republish-diff.js docs/$1/.published-snapshot.md <scratch-file>
  ```

  JSON on stdout: `{ identical, hunks }`. It exits `0` whether or not hunks exist — hunks are data, not an error (a human `-`/`+` rendering goes to stderr).
- `identical: true` → note at gate 3 that the live doc is untouched since last publish.
- Hunks → these are manual edits a re-push reverts. Show them verbatim (the stderr rendering, or render `hunks` yourself: `- ` lines are what the live doc loses, `+ ` lines are what someone added). The user may proceed (clobber) or abort here and port the edits into `index.md` first, then re-run. Report-only — never block, never auto-approve.

## 5. Re-publish (Gate 3 — external write)

Only if the doc's config `publish.target` is not `local`. Before any external write, show the **exact** summary of what will change, e.g.:

> Update existing Google Doc <url>: replace 2 images, body unchanged.
> ⚠ 2 manual edits found in the live doc — shown above; publishing reverts them.

The summary must always state the step 4 result: manual edits found (shown verbatim), none found, or the check was unavailable and why.

Require an explicit yes. This gate is never auto-approved.

On yes, follow `references/publish-targets.md` for the target, reusing the recorded `url`:
- Update the doc **in place** where the target supports it (Google Docs does — replace body and/or the changed images).
- If the target cannot update in place, create a new doc, rewrite `meta.publish.url` to the new link, and tell the user the link changed.

## 6. Record the new publish state

Update `docs/$1/meta.json`:
- `publish.publishedHash` = `shasum -a 256 docs/$1/index.md` (the hex digest only),
- `publish.publishedAt` = now (ISO 8601),
- `publish.url` if it changed.

`status` stays `published`.

Also rewrite `docs/$1/.published-snapshot.md` with the text read back during publish verification (per `references/publish-targets.md`) — it is the baseline step 4 diffs against on the next run.

## Notes

- If `update-check.js` exits `10`, auth expired — run `/shopify-apps-doc-writer:docs-setup auth` and retry.
- If it exits `20`, a selector no longer resolves: the UI changed structurally and the **manifest** needs updating (re-approve it via `/shopify-apps-doc-writer:write-docs`) before `/shopify-apps-doc-writer:update-docs` can work.
- If it exits `30`, the browser hit a bot challenge instead of the admin. Nothing is wrong with the manifest — re-run the capture with `--headed`.
- This command never mutates the admin: all captures go through `capture.js`, which enforces the read-only guarantee.
- A doc published before `publishedHash` was recorded (or recorded with a different hash method) will report copy drift on its first run even if the text never changed. That's expected — re-publishing records the pinned hash and the false positive disappears.

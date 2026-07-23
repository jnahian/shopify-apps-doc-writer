---
description: Refresh an existing published feature doc — detect copy/screenshot drift, re-shoot, and re-publish
argument-hint: <feature-slug>
---

Refresh the published doc at `docs/$1/`. Follow these steps exactly; the gates are non-skippable.

## 1. Detect drift

Run:

```bash
node scripts/update-check.js --manifest docs/$1/manifest.json --app <key>
```

Parse the JSON printed on stdout.

- If `published` is `false`: tell the user this doc has never been published, so there is nothing to compare against — they should publish it first via `/write-docs`. Stop.
- If `anyDrift` is `false`: tell the user the doc is up to date since its last publish — nothing to do. Delete `tmpDir` (`rm -rf <tmpDir>`). Stop.

## 2. Report the drift

Show the user, from the JSON:
- whether `copy.changed` is true ("the doc's text changed since publish"), and
- `screenshots.changedCount` of `screenshots.total`, listing each `screenshots.shots[].file` where `changed` is true.

## 3. Promote fresh screenshots (local — confirm first)

Ask the user to confirm overwriting the committed screenshots with the freshly captured ones.

- If they decline: `rm -rf <tmpDir>` and stop. Nothing changed.
- If they approve: for each changed shot, copy `<tmpDir>/<file>` over `docs/$1/screenshots/<file>`, then `rm -rf <tmpDir>`.

## 4. Re-publish (Gate 3 — external write)

Only if the doc's config `publish.target` is not `local`. Before any external write, show the **exact** summary of what will change, e.g.:

> Update existing Google Doc <url>: replace 2 images, body unchanged.

Require an explicit yes. This gate is never auto-approved.

On yes, follow `references/publish-targets.md` for the target, reusing the recorded `url`:
- Update the doc **in place** where the target supports it (Google Docs does — replace body and/or the changed images).
- If the target cannot update in place, create a new doc, rewrite `meta.publish.url` to the new link, and tell the user the link changed.

## 5. Record the new publish state

Update `docs/$1/meta.json`:
- `publish.publishedHash` = `shasum -a 256 docs/$1/index.md` (the hex digest only),
- `publish.publishedAt` = now (ISO 8601),
- `publish.url` if it changed.

`status` stays `published`.

## Notes

- If `update-check.js` exits `10`, auth expired — run `/docs-setup auth` and retry.
- If it exits `20`, a selector no longer resolves: the UI changed structurally and the **manifest** needs updating (re-approve it via `/write-docs`) before `/update-docs` can work.
- This command never mutates the admin: all captures go through `capture.js`, which enforces the read-only guarantee.

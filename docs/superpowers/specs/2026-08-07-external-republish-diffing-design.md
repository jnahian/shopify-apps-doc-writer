# External Re-publish Diffing (0.5.0) — Design

**Date:** 2026-08-07
**Status:** agreed in brainstorm
**Roadmap:** SPEC.md §13, item 0.5. Built ahead of 0.4 (annotation pipeline),
which stays queued; the release ships as 0.5.0 to keep the roadmap numbering.

## Problem

On a re-publish, gate 3 summarizes what *we* will write but is blind to the
live doc. If someone hand-edited the external doc (Google Doc, etc.) since the
last publish, a re-push silently clobbers their edits. The user confirming
gate 3 can't be said to have given informed consent to that.

## Decision summary

Before gate 3 on a re-publish, fetch the live external doc and show any manual
edits the re-push would revert. Detection is exact, not heuristic, via a
publish-time snapshot; the result is report-only — gate 3 mechanics are
unchanged, the user decides.

### 1. Snapshot at publish

After every successful external publish (first publish via `/write-docs` or
re-publish via `/update-docs`), the already-mandated read-back verification
step additionally saves the fetched text to
`docs/<slug>/.published-snapshot.md`, committed alongside the doc.

- The snapshot is the **round-tripped fetch** — the live doc's text as read
  back through the same MCP tool that will be used at diff time. Later diffs
  compare same-format against same-format, so md→Doc conversion noise
  (flattened inline code, screenshot placeholder markers, heading restyling)
  cancels out by construction.
- No `meta.json` change: the file's presence is the signal, and
  `publish.publishedAt` already records when.
- Instructions live in `references/publish-targets.md` (the shared publish
  path), so both commands inherit the behavior.
- `build-site.js` reads only `index.md` per doc dir, so the snapshot never
  leaks into the deployed site.

### 2. Diff decomposition (refinement of the roadmap wording)

§13 says "diff both directions." A literal live-vs-local diff crosses formats
(Doc-export text vs markdown) and would drown edits in conversion noise. The
two directions decompose cleanly instead:

- **Manual edits (the new value):** diff snapshot ↔ live fetch. Same format;
  any hunk is a human edit the re-push would revert.
- **What we're pushing:** already covered — `update-check.js` reports
  copy/screenshot drift in `/update-docs` step 2, and local `index.md`
  changes are visible in the worktree's git diff. No new cross-format diff.

Rejected alternatives: snapshotting our pushed markdown (needs a normalizer
that simulates Google's md→Doc→text round trip and breaks when their export
shifts); deriving the baseline from git history via `publishedHash` (fails on
rebases/squashes/uncommitted publishes); Claude diffing in-context
(non-deterministic exactly where a miss hurts most).

### 3. New module: `scripts/lib/republish-diff.js`

Pure function `(snapshotText, liveText) → { identical, hunks }`:

- Normalizes only trivial noise — line endings, trailing whitespace — then a
  line-based diff. No fuzzy matching.
- No fetching, no MCP: Claude fetches the live doc via the connector's read
  tool, writes both texts to scratchpad files, and runs a tiny CLI entry
  (`node republish-diff.js <snapshotFile> <liveFile>`, JSON on stdout).
- `republish-diff.test.js` beside it, written first (TDD per CLAUDE.md);
  `npm test` auto-discovers it.

### 4. Flow change in `/update-docs`

New step between screenshot promotion (step 3) and gate 3 (step 4): fetch the
live doc using `meta.publish.url`, run the diff, and fold the result into the
gate 3 summary, e.g.:

> Update existing Google Doc <url>: replace 2 images, body unchanged.
> ⚠ 2 manual edits found in the live doc (shown below) — publishing reverts
> them.

The manual-edit hunks are shown verbatim. The user decides: proceed (clobber),
or abort and port the edits into `index.md` first, then re-run. Report-only —
no auto-merge, no hard block.

### 5. Degraded modes — all warn-and-continue

The check informs gate 3; it never silently disappears and never hard-blocks:

- **No snapshot** (doc last published before 0.5): state that clobber
  detection is unavailable this time; this publish writes the snapshot, so it
  works from the next re-publish on.
- **Live fetch fails**: state "could not check for manual edits" at gate 3
  with the error; the user still gates.
- **Targets:** `google-docs` is the committed path (Drive
  `read_file_content`). `mcp` is best-effort — works iff the connector
  exposes a read tool; otherwise same warning as a failed fetch. `local` has
  no external doc and is untouched.

### 6. Consistency and release

- Gate-3 wording is stated in three places — `commands/update-docs.md`,
  `SKILL.md`, `references/publish-targets.md` — all three updated together.
- Version bump to **0.5.0** in `.claude-plugin/plugin.json` and
  `package.json`, CHANGELOG entry.
- SPEC.md §13: mark 0.5 shipped; note 0.4 remains queued.

## Out of scope

- Auto-merging live edits back into `index.md` (reverse-converting Doc text
  into markdown structure is guesswork, and it adds a write path into the
  source of truth).
- Any cross-format normalizer simulating the md→Doc round trip.
- Hard-blocking re-publish while manual edits exist.
- Backfilling snapshots for already-published docs (self-heals on first
  re-publish).

## Testing

- `republish-diff.test.js`: identical texts → `identical: true`; line-ending
  and trailing-whitespace-only differences → identical; real edits → correct
  hunks; CLI entry emits valid JSON and a nonzero-vs-zero exit distinction is
  **not** used (diff presence is data, not an error).
- Markdown changes (commands, SKILL.md, publish-targets) have no runner, per
  CLAUDE.md; verified by a real `/update-docs` run against a published doc
  with a deliberate manual edit in the live Google Doc.

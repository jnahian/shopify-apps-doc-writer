# External Re-publish Diffing (0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before gate 3 on a re-publish, fetch the live external doc and show any manual edits the re-push would revert, detected exactly via a publish-time snapshot.

**Architecture:** Every external publish saves the read-back text to `docs/<slug>/.published-snapshot.md`. On re-publish, Claude fetches the live doc via the connector's read tool and a new pure lib module (`scripts/lib/republish-diff.js`) diffs snapshot vs live — same format on both sides, so md→Doc conversion noise cancels out. The result is folded into the gate 3 summary; report-only, the user decides. Spec: `docs/superpowers/specs/2026-08-07-external-republish-diffing-design.md`.

**Tech Stack:** Node ≥ 20, CommonJS, plain `assert` self-check tests run by `node --test`, JSDoc types checked by `tsc` (strict `checkJs`). No new dependencies.

## Global Constraints

- No new npm dependencies — runtime deps stay `playwright` only; the diff is hand-rolled (docs are small, O(n·m) LCS is fine).
- Every JS file: `'use strict'`, CommonJS (`require`/`module.exports`), JSDoc types. `npm run typecheck` and `npm test` must pass before every commit.
- TDD for JS (repo CLAUDE.md): failing test first, watch it fail, then implement. Markdown files have no runner — exempt.
- Snapshot filename is exactly `.published-snapshot.md`, in `docs/<slug>/`, committed. (`build-site.js` reads only `index.md` per doc dir, so it never leaks into the deployed site.)
- The CLI exits `0` whether or not hunks exist — diff presence is data, not an error. (Exit codes 10/20/30 are a documented contract for *capture*; this tool takes no part in it.)
- The clobber check is report-only: it never blocks a publish and never auto-approves gate 3. It also never disappears silently — every degraded mode states itself at gate 3.
- Gate 3 wording lives in three places that must stay consistent: `commands/update-docs.md`, `skills/shopify-apps-doc-writer/SKILL.md`, `skills/shopify-apps-doc-writer/references/publish-targets.md`.
- All work on branch `feat/republish-diffing` (already created; holds the spec commit).

---

### Task 1: `scripts/lib/republish-diff.js` — the diff module + CLI

**Files:**
- Create: `scripts/lib/republish-diff.test.js`
- Create: `scripts/lib/republish-diff.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `compare(snapshotText: string, liveText: string) → {identical: boolean, hunks: Hunk[]}` where `Hunk = {snapshotLine: number, liveLine: number, removed: string[], added: string[]}` (1-based line numbers of the hunk start after normalization); `formatHunks(hunks: Hunk[]) → string` (human `-`/`+` rendering); CLI `node scripts/lib/republish-diff.js <snapshotFile> <liveFile>` → JSON `{identical, hunks}` on stdout, `formatHunks` rendering on stderr, exit 0 either way, exit 2 on usage error. Task 3's command markdown invokes the CLI by this exact path and shape.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/republish-diff.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for republish-diff. Run: node scripts/lib/republish-diff.test.js */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compare, formatHunks } = require('./republish-diff');

// Identical texts → identical, no hunks.
assert.deepStrictEqual(compare('a\nb\n', 'a\nb\n'), { identical: true, hunks: [] });

// Trivial noise is not an edit: CRLF line endings, trailing whitespace on a
// line, trailing blank lines at EOF. These vary between MCP read-backs of an
// unchanged doc; treating them as edits would cry wolf at every gate 3.
assert.strictEqual(
  compare('a\nb', 'a\r\nb  \n\n').identical, true,
  'line endings + trailing whitespace are not edits'
);

// A real edit → one hunk carrying the changed lines and where they are.
const edited = compare('Step 1\nStep 2\nStep 3', 'Step 1\nStep 2 — but different\nStep 3');
assert.strictEqual(edited.identical, false, 'a changed line is an edit');
assert.deepStrictEqual(edited.hunks, [
  { snapshotLine: 2, liveLine: 2, removed: ['Step 2'], added: ['Step 2 — but different'] },
]);

// Pure insertion and pure deletion.
assert.deepStrictEqual(
  compare('a\nc', 'a\nb\nc').hunks,
  [{ snapshotLine: 2, liveLine: 2, removed: [], added: ['b'] }],
  'insertion → added-only hunk'
);
assert.deepStrictEqual(
  compare('a\nb\nc', 'a\nc').hunks,
  [{ snapshotLine: 2, liveLine: 2, removed: ['b'], added: [] }],
  'deletion → removed-only hunk'
);

// Two non-adjacent edits stay two hunks.
const two = compare('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE');
assert.strictEqual(two.hunks.length, 2, 'non-adjacent edits stay separate hunks');

// formatHunks renders -/+ lines for verbatim display at gate 3.
const text = formatHunks(edited.hunks);
assert.ok(text.includes('- Step 2'), 'shows removed line');
assert.ok(text.includes('+ Step 2 — but different'), 'shows added line');

// CLI: JSON on stdout, exit 0 whether or not hunks exist — diff presence is
// data, not an error.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'republish-diff-test-'));
const snap = path.join(tmp, 'snap.md'); fs.writeFileSync(snap, 'a\nb\n');
const live = path.join(tmp, 'live.md'); fs.writeFileSync(live, 'a\nB\n');
const out = execFileSync(
  process.execPath, [path.join(__dirname, 'republish-diff.js'), snap, live],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);
const parsed = JSON.parse(out);
assert.strictEqual(parsed.identical, false, 'CLI reports the edit');
assert.strictEqual(parsed.hunks.length, 1, 'CLI carries the hunks');

console.log('ok — republish-diff normalization, hunk detection, formatting, and CLI');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/lib/republish-diff.test.js`
Expected: FAIL — `Cannot find module './republish-diff'`

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/republish-diff.js`:

```js
'use strict';

/**
 * republish-diff.js — exact comparison of the publish-time snapshot of an
 * external doc against its live text, for the /update-docs clobber check.
 *
 * Both inputs are read-backs through the same MCP tool (the snapshot was
 * saved at publish time from the same fetch path), so md→Doc conversion
 * noise cancels out by construction — any hunk is a human edit. Only
 * trivial transport noise is normalized away: CRLF, trailing whitespace
 * per line, trailing blank lines at EOF. No fuzzy matching.
 *
 * CLI: node republish-diff.js <snapshotFile> <liveFile>
 * JSON {identical, hunks} on stdout, human rendering on stderr. Exit 0
 * whether or not hunks exist — diff presence is data, not an error.
 */

/** @typedef {{snapshotLine: number, liveLine: number, removed: string[], added: string[]}} Hunk */

/** @param {string} text */
function normalize(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line-based LCS diff, grouped into hunks of contiguous change.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Hunk[]}
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  /** @type {number[][]} */
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk|null} */
  let open = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (open === null) {
      open = { snapshotLine: i + 1, liveLine: j + 1, removed: [], added: [] };
      hunks.push(open);
    }
    if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
      open.removed.push(a[i]);
      i++;
    } else {
      open.added.push(b[j]);
      j++;
    }
  }
  return hunks;
}

/**
 * @param {string} snapshotText
 * @param {string} liveText
 */
function compare(snapshotText, liveText) {
  const hunks = diffLines(normalize(snapshotText), normalize(liveText));
  return { identical: hunks.length === 0, hunks };
}

/** @param {Hunk[]} hunks */
function formatHunks(hunks) {
  /** @type {string[]} */
  const lines = [];
  for (const hunk of hunks) {
    lines.push(`@ snapshot line ${hunk.snapshotLine} / live line ${hunk.liveLine}`);
    for (const line of hunk.removed) lines.push(`- ${line}`);
    for (const line of hunk.added) lines.push(`+ ${line}`);
  }
  return lines.join('\n');
}

module.exports = { compare, formatHunks };

if (require.main === module) {
  const fs = require('fs');
  const [snapshotFile, liveFile] = process.argv.slice(2);
  if (!snapshotFile || !liveFile) {
    console.error('usage: node republish-diff.js <snapshotFile> <liveFile>');
    process.exit(2);
  }
  const result = compare(
    fs.readFileSync(snapshotFile, 'utf8'),
    fs.readFileSync(liveFile, 'utf8')
  );
  if (!result.identical) console.error(formatHunks(result.hunks));
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/lib/republish-diff.test.js`
Expected: `ok — republish-diff normalization, hunk detection, formatting, and CLI`

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass (`node --test` auto-discovers the new file); `tsc` emits no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/republish-diff.js scripts/lib/republish-diff.test.js
git commit -m "feat(lib): republish-diff — exact snapshot-vs-live doc diff"
```

---

### Task 2: Snapshot-at-publish in `publish-targets.md`

**Files:**
- Modify: `skills/shopify-apps-doc-writer/references/publish-targets.md`

**Interfaces:**
- Consumes: nothing from other tasks (the snapshot is written by hand-following this reference at publish time; no code involved).
- Produces: the committed snapshot file `docs/<slug>/.published-snapshot.md` that Task 3's clobber check reads. Both `/write-docs` and `/update-docs` publish by following this reference, so one edit covers first publish and re-publish.

- [ ] **Step 1: Add the shared snapshot rule after the meta.json block**

In `skills/shopify-apps-doc-writer/references/publish-targets.md`, find:

```markdown
and set `status: "published"`. The `contentHash` / `publishedHash` pair is the v2 staleness hook.
```

Replace with:

```markdown
and set `status: "published"`. The `contentHash` / `publishedHash` pair is the v2 staleness hook.

**Also save the publish-time snapshot.** Write the text you read back during publish verification to `docs/<slug>/.published-snapshot.md`, committed with the doc. It is the exact baseline `/update-docs` diffs the live doc against before re-publishing, to detect manual edits a re-push would revert (the clobber check) — same fetch path on both sides, so conversion noise cancels out. Every successful external publish (first or re-) rewrites it. If nothing can be read back (an `mcp` connector with no read tool), skip it and tell the user the next re-publish will not be able to detect manual edits. `build-site.js` ignores the file — it reads only `index.md`.
```

- [ ] **Step 2: Point the Drive-only read-back step at the snapshot**

Find (in the `google-docs` Drive-only path):

```markdown
3. **Verify by reading the Doc back** (`read_file_content`) before reporting success. The create response reports `fileSize: 1` for Google-native docs regardless of content, so it proves nothing.
```

Replace with:

```markdown
3. **Verify by reading the Doc back** (`read_file_content`) before reporting success. The create response reports `fileSize: 1` for Google-native docs regardless of content, so it proves nothing. Save this read-back text as the snapshot (see above).
```

- [ ] **Step 3: Same pointer in the generic `mcp` path**

Find (step 4 of the `mcp` section):

```markdown
4. Write the resulting URL/ID into `meta.json` as above.
```

Replace with:

```markdown
4. Write the resulting URL/ID into `meta.json` as above. If the connector has a read tool, read the published doc back and save the text as the snapshot (see above); if it has none, say so — the clobber check will be unavailable on re-publish.
```

- [ ] **Step 4: Commit**

```bash
git add skills/shopify-apps-doc-writer/references/publish-targets.md
git commit -m "docs(publish): save a read-back snapshot on every external publish"
```

(No test runner for markdown — verified end-to-end in Task 5.)

---

### Task 3: Clobber check in `/update-docs` + gate 3 wording in SKILL.md

**Files:**
- Modify: `commands/update-docs.md`
- Modify: `skills/shopify-apps-doc-writer/SKILL.md`

**Interfaces:**
- Consumes: Task 1's CLI (`node <plugin-root>/scripts/lib/republish-diff.js <snapshotFile> <liveFile>` → JSON `{identical, hunks}`, exit 0 either way) and Task 2's snapshot file `docs/<slug>/.published-snapshot.md`.
- Produces: the user-facing flow. Existing steps 4 and 5 of `update-docs.md` renumber to 5 and 6; the existing "continue to step 4" reference in step 3 now correctly points at the new check.

- [ ] **Step 1: Insert the new step 4 into `commands/update-docs.md`**

Find:

```markdown
## 4. Re-publish (Gate 3 — external write)
```

Replace with:

````markdown
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
````

- [ ] **Step 2: Fold the check result into the gate 3 example and renumber the tail**

In the same file, find:

```markdown
> Update existing Google Doc <url>: replace 2 images, body unchanged.

Require an explicit yes. This gate is never auto-approved.
```

Replace with:

```markdown
> Update existing Google Doc <url>: replace 2 images, body unchanged.
> ⚠ 2 manual edits found in the live doc — shown above; publishing reverts them.

The summary must always state the step 4 result: manual edits found (shown verbatim), none found, or the check was unavailable and why.

Require an explicit yes. This gate is never auto-approved.
```

Then find:

```markdown
## 5. Record the new publish state
```

Replace with:

```markdown
## 6. Record the new publish state
```

And in that section, find:

```markdown
- `publish.url` if it changed.
```

Replace with:

```markdown
- `publish.url` if it changed,
- `docs/$1/.published-snapshot.md` = the text read back during publish verification (per `references/publish-targets.md`).
```

- [ ] **Step 3: Extend gate 3 in SKILL.md §6**

In `skills/shopify-apps-doc-writer/SKILL.md`, find:

```markdown
**Gate 3:** before any external write, show exactly what will be created where — e.g. "1 Google Doc + 8 images into Drive folder X" — and require an explicit yes. Non-skippable. If the target can't ingest images, say so at the gate: text will publish with `[Screenshot: …]` placeholder markers (degraded, never broken).
```

Replace with:

```markdown
**Gate 3:** before any external write, show exactly what will be created where — e.g. "1 Google Doc + 8 images into Drive folder X" — and require an explicit yes. Non-skippable. If the target can't ingest images, say so at the gate: text will publish with `[Screenshot: …]` placeholder markers (degraded, never broken). On a **re-publish**, the summary must also state the clobber-check result — manual edits found in the live doc (shown verbatim; publishing reverts them), none found, or the check was unavailable and why (`/update-docs` step 4; snapshot per `references/publish-targets.md`).
```

- [ ] **Step 4: Consistency read-through**

Re-read all three gate-3 statements (`commands/update-docs.md`, `SKILL.md` §6, `publish-targets.md`) end to end. They must agree on: the snapshot filename, "report-only, never blocks, never auto-approves", and every degraded mode being stated at the gate. Fix any drift now.

- [ ] **Step 5: Commit**

```bash
git add commands/update-docs.md skills/shopify-apps-doc-writer/SKILL.md
git commit -m "feat(update-docs): clobber check — show live manual edits before gate 3"
```

---

### Task 4: SPEC.md, CHANGELOG, version bump to 0.5.0

**Files:**
- Modify: `SPEC.md`
- Modify: `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–3 (described, not imported).
- Produces: the release metadata. `version` in `.claude-plugin/plugin.json` is the update cache key — without this bump, installed users receive nothing.

- [ ] **Step 1: Update the SPEC.md non-goal line**

Find:

```markdown
- `/update-docs` re-publish *diffing* against a live external doc → **0.5 on the v2 roadmap (§13)**. (Staleness detection + re-shoot + in-place re-publish shipped.)
```

Replace with:

```markdown
- `/update-docs` re-publish *diffing* against a live external doc → **shipped in 0.5.0 (§13)**.
```

- [ ] **Step 2: Mark §13's 0.5 item shipped**

Find:

```markdown
### 0.5 — External re-publish diffing
Before gate 3 on a re-publish, fetch the live external doc and diff both
directions: what the re-push changes, and any manual edits made directly in
the external doc that a re-push would clobber. Google Docs is the committed
target; generic MCP targets best-effort.
```

Replace with:

```markdown
### 0.5 — External re-publish diffing
Before gate 3 on a re-publish, fetch the live external doc and diff both
directions: what the re-push changes, and any manual edits made directly in
the external doc that a re-push would clobber. Google Docs is the committed
target; generic MCP targets best-effort.

Shipped in 0.5.0 (2026-08-07, ahead of 0.4 — see
`docs/superpowers/specs/2026-08-07-external-republish-diffing-design.md`):
snapshot-at-publish (`docs/<slug>/.published-snapshot.md`, the round-tripped
read-back), exact snapshot-vs-live diff via `scripts/lib/republish-diff.js`,
report-only at gate 3. "Diff both directions" resolved into two same-format
diffs: manual-edit detection is the new piece; our-side changes were already
reported by `update-check.js` and the worktree's git diff.
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, insert directly above `## [0.3.0] - 2026-08-06`:

```markdown
## [0.5.0] - 2026-08-07

Ships the roadmap's 0.5 item ahead of 0.4 (annotation pipeline), which
remains queued.

### Added

- Re-publish clobber check: `/update-docs` now fetches the live external doc
  before gate 3 and shows any manual edits a re-push would revert — verbatim,
  report-only; the user still gates. Backed by a publish-time snapshot
  (`docs/<slug>/.published-snapshot.md`, the text read back during publish
  verification — same fetch path both times, so conversion noise cancels out)
  and `scripts/lib/republish-diff.js`, an exact line diff.
- Degraded modes warn at gate 3, never silently skip: docs published before
  0.5.0 have no snapshot (this publish writes one, so the check works from
  the next re-publish); a failed fetch or an `mcp` connector without a read
  tool says "could not check for manual edits". Google Docs is the committed
  path.

```

- [ ] **Step 4: Bump the version**

In `.claude-plugin/plugin.json` and `package.json`, change `"version": "0.3.0"` to `"version": "0.5.0"` (same string in both — the plugin resolves from `plugin.json`; `marketplace.json` deliberately carries no copy). Then sync the lockfile:

Run: `npm install --package-lock-only`
Expected: `package-lock.json` now reads `"version": "0.5.0"` in its top-level and root-package entries; no dependency changes.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: all pass (guards against a stray edit).

```bash
git add SPEC.md CHANGELOG.md .claude-plugin/plugin.json package.json package-lock.json
git commit -m "chore(release): 0.5.0 — external re-publish diffing"
```

---

### Task 5: End-to-end verification against a live Google Doc

**Files:** none created or modified — this validates the markdown flow, which has no test runner (repo CLAUDE.md: verify by running for real).

**Interfaces:**
- Consumes: everything from Tasks 1–4, exercised through the real `/update-docs` flow.
- Produces: a pass/fail report to the user. **Requires the user's machine state:** valid Shopify auth, a doc already published to Google Docs, and the Drive MCP connected. If any is missing, report which and hand these steps to the user instead of skipping silently.

- [ ] **Step 1: Pick a published doc and seed the snapshot**

Find a doc with `meta.json` → `publish.target: "google-docs"` and a `publish.url`. If it has no `.published-snapshot.md` yet (all pre-0.5 docs), run `/update-docs <slug>` once and confirm: step 4 reports the check unavailable (pre-0.5 doc), and after re-publish the snapshot file exists and is committed-ready in the worktree.

- [ ] **Step 2: Make a deliberate manual edit in the live Doc**

In the browser, edit one line of the published Google Doc (e.g. append " — EDITED BY HAND" to a step).

- [ ] **Step 3: Run `/update-docs <slug>` and observe gate 3**

Expected: step 4 fetches the live doc, `republish-diff` reports one hunk, and the gate 3 summary shows the edited line verbatim with the "publishing reverts them" warning. Decline the publish at the gate.

- [ ] **Step 4: Confirm the identical path**

Undo the manual edit in the Doc (or proceed with a real publish once), then run `/update-docs <slug>` again with no manual edits present. Expected: step 4 reports the live doc untouched since last publish; no phantom hunks — if noise appears here, the normalization in `republish-diff.js` is missing a transport artifact; capture the two texts and add the case to `republish-diff.test.js` before widening `normalize()`.

- [ ] **Step 5: Report**

Summarize the four outcomes (unavailable-then-created, edit detected, gate wording, identical clean) to the user with the doc slug used.

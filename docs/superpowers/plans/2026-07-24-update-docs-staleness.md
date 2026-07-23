# /update-docs Staleness Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the stubbed `/update-docs <feature-slug>` command into a working command that detects copy and screenshot drift in an already-published doc, then re-shoots and re-publishes through the existing gate.

**Architecture:** A new pure-logic lib (`scripts/lib/staleness.js`) does hashing, screenshot classification, and report building. A thin CLI (`scripts/update-check.js`) shells out to `capture.js` (kept as the only screenshotter) to re-shoot into a temp dir, then calls the lib and emits a human report plus machine-readable JSON. `commands/update-docs.md` orchestrates: report → confirm promotion → gate-3 re-publish.

**Tech Stack:** Node.js (CommonJS, `'use strict'`), stdlib `crypto`/`child_process`/`fs` only, Playwright via the existing `capture.js`. No new dependencies. Tests are plain `assert` scripts run with `node`.

## Global Constraints

- **No new npm dependencies** — stdlib `crypto`, `child_process`, `fs`, `os`, `path` only.
- **`capture.js` stays the ONLY thing that produces screenshots** — `update-check.js` re-shoots by shelling out to it, never by driving a browser itself.
- **Read-only guarantee intact** — never set `"mutation": true`; the `DESTRUCTIVE_PATTERN` refusal in `capture.js` is unchanged.
- **Exit-code contract** — `10` = auth expired (→ `/docs-setup auth`), `20` = selector timeout (UI changed → fix manifest). `update-check.js` propagates both from `capture.js`.
- **Hash definition** — `contentHash`/`publishedHash` are the **sha256 hex digest of the raw `index.md` bytes** (identical to `shasum -a 256 index.md`). Both the write/publish path and `update-check.js` must use exactly this.
- **Style** — CommonJS, `'use strict';`, match existing `scripts/` files. Tests live next to code, are plain `assert`-based, end with a `console.log('ok — …')`, and take no framework.
- **Gates** — Gate 3 (exact summary before any external write) is reused verbatim and is never auto-approved. Screenshot promotion (local overwrite) gets its own confirmation.

---

### Task 1: `capture.js` — `--out-dir` flag

Let `capture.js` write screenshots to an arbitrary directory so `update-check.js` can re-shoot into a temp dir without clobbering committed screenshots. Extract the output-dir resolution into a pure, exported, testable function and guard the entry point so the module can be required in tests without running `main()`.

**Files:**
- Modify: `scripts/capture.js` (usage string line ~173; `outDir` line 206; entry point lines 279-282)
- Test: `scripts/capture.test.js` (create)

**Interfaces:**
- Produces: `resolveOutDir(args, manifestPath) -> string` — absolute path of `args['out-dir']` when set, else `<dirname(manifestPath)>/screenshots`. Exported from `scripts/capture.js`.
- Consumes: `parseArgs` already turns `--out-dir <dir>` into `args['out-dir']`.

- [ ] **Step 1: Write the failing test**

Create `scripts/capture.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for resolveOutDir. Run: node scripts/capture.test.js */

const assert = require('assert');
const path = require('path');
const { resolveOutDir } = require('./capture');

// Default: screenshots dir adjacent to the manifest.
assert.strictEqual(
  resolveOutDir({}, '/x/docs/feature/manifest.json'),
  path.join('/x/docs/feature', 'screenshots'),
  'no flag → manifest-adjacent screenshots dir'
);

// Override: --out-dir wins, resolved to absolute.
assert.strictEqual(
  resolveOutDir({ 'out-dir': '/tmp/shots' }, '/x/docs/feature/manifest.json'),
  path.resolve('/tmp/shots'),
  '--out-dir overrides and is absolutised'
);

console.log('ok — resolveOutDir honors --out-dir');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/capture.test.js`
Expected: FAIL — `TypeError: resolveOutDir is not a function` (capture.js does not export it yet).

- [ ] **Step 3: Add `resolveOutDir` and use it**

In `scripts/capture.js`, add this function just above `async function main() {` (before line 169):

```js
function resolveOutDir(args, manifestPath) {
  if (args['out-dir']) return path.resolve(args['out-dir']);
  return path.join(path.dirname(manifestPath), 'screenshots');
}
```

Replace line 206:

```js
  const outDir = path.join(path.dirname(manifestPath), 'screenshots');
```

with:

```js
  const outDir = resolveOutDir(args, manifestPath);
```

Update the usage string (line ~173) to advertise the flag:

```js
    'Usage: node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--out-dir <dir>] [--headed]'
```

- [ ] **Step 4: Guard the entry point and export**

Replace the trailing invocation (lines 279-282):

```js
main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
```

with:

```js
if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

module.exports = { resolveOutDir };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/capture.test.js`
Expected: PASS — `ok — resolveOutDir honors --out-dir`

- [ ] **Step 6: Commit**

```bash
git add scripts/capture.js scripts/capture.test.js
git commit -m "feat(capture): add --out-dir flag for staging re-shoots"
```

---

### Task 2: `scripts/lib/staleness.js` — pure drift-detection logic

All deterministic logic lives here: file hashing, copy-drift detection, per-screenshot classification, report aggregation, and human formatting. Pure and I/O-light (reads files, computes hashes) so it is fully unit-testable with temp fixtures.

**Files:**
- Create: `scripts/lib/staleness.js`
- Test: `scripts/lib/staleness.test.js`

**Interfaces:**
- Produces:
  - `sha256File(filePath) -> string` — sha256 hex of the raw file bytes.
  - `detectCopyDrift(indexPath, publishedHash) -> { changed: boolean, currentHash: string, publishedHash: string }`
  - `classifyScreenshots(committedDir, freshDir, shotIds) -> Array<{ file: string, changed: boolean }>` — `file` is `<id>.png`; `changed` is true when either side is missing or the bytes differ.
  - `buildReport({ slug, url, published, tmpDir, copy, shots }) -> report` where report is `{ slug, published, url, tmpDir, copy, screenshots: { changedCount, total, shots }, anyDrift }`.
  - `formatReport(report) -> string` — human-readable summary.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/staleness.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for staleness logic. Run: node scripts/lib/staleness.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sha256File,
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
} = require('./staleness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-test-'));

// sha256File: stable on identical bytes, differs on different bytes.
const a = path.join(tmp, 'a.txt'); fs.writeFileSync(a, 'hello');
const b = path.join(tmp, 'b.txt'); fs.writeFileSync(b, 'hello');
const c = path.join(tmp, 'c.txt'); fs.writeFileSync(c, 'world');
assert.strictEqual(sha256File(a), sha256File(b), 'same bytes → same hash');
assert.notStrictEqual(sha256File(a), sha256File(c), 'diff bytes → diff hash');

// detectCopyDrift: unchanged when hash matches publishedHash, changed otherwise.
assert.strictEqual(detectCopyDrift(a, sha256File(a)).changed, false, 'matching hash → no copy drift');
assert.strictEqual(detectCopyDrift(c, sha256File(a)).changed, true, 'differing hash → copy drift');

// classifyScreenshots: unchanged / changed / missing-side.
const cd = path.join(tmp, 'committed'); fs.mkdirSync(cd);
const fd = path.join(tmp, 'fresh'); fs.mkdirSync(fd);
fs.writeFileSync(path.join(cd, '01.png'), 'img1'); fs.writeFileSync(path.join(fd, '01.png'), 'img1'); // unchanged
fs.writeFileSync(path.join(cd, '02.png'), 'imgA'); fs.writeFileSync(path.join(fd, '02.png'), 'imgB'); // changed
fs.writeFileSync(path.join(cd, '03.png'), 'only-committed'); // fresh missing → changed
assert.deepStrictEqual(
  classifyScreenshots(cd, fd, ['01', '02', '03']),
  [
    { file: '01.png', changed: false },
    { file: '02.png', changed: true },
    { file: '03.png', changed: true },
  ],
  'classify: unchanged, byte-diff, and missing-side all handled'
);

// buildReport: aggregates changedCount and anyDrift across both axes.
const shots = classifyScreenshots(cd, fd, ['01', '02', '03']);
const r = buildReport({ slug: 'x', url: 'u', published: true, tmpDir: fd, copy: { changed: false }, shots });
assert.strictEqual(r.screenshots.changedCount, 2, 'two shots changed');
assert.strictEqual(r.screenshots.total, 3, 'three shots total');
assert.strictEqual(r.anyDrift, true, 'screenshot drift → anyDrift');

const clean = buildReport({ slug: 'x', url: 'u', published: true, tmpDir: fd, copy: { changed: false }, shots: [{ file: '01.png', changed: false }] });
assert.strictEqual(clean.anyDrift, false, 'no copy drift + no shot drift → anyDrift false');

const copyOnly = buildReport({ slug: 'x', url: 'u', published: true, tmpDir: fd, copy: { changed: true }, shots: [{ file: '01.png', changed: false }] });
assert.strictEqual(copyOnly.anyDrift, true, 'copy drift alone → anyDrift');

console.log('ok — staleness hashing, classification, and report aggregation');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/staleness.test.js`
Expected: FAIL — `Cannot find module './staleness'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/staleness.js`:

```js
'use strict';

/**
 * staleness.js — pure drift-detection logic for /update-docs.
 *
 * Compares the current local doc state against the state recorded at last
 * publish. Byte-level sensitivity: a screenshot that differs by one byte
 * counts as changed (no perceptual scoring). Hashes are sha256 hex of raw
 * file bytes, matching `shasum -a 256`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function detectCopyDrift(indexPath, publishedHash) {
  const currentHash = sha256File(indexPath);
  return { changed: currentHash !== publishedHash, currentHash, publishedHash };
}

/** shotIds come from the manifest; each maps to `<id>.png` in both dirs. */
function classifyScreenshots(committedDir, freshDir, shotIds) {
  return shotIds.map((id) => {
    const file = `${id}.png`;
    const committed = path.join(committedDir, file);
    const fresh = path.join(freshDir, file);
    const hasCommitted = fs.existsSync(committed);
    const hasFresh = fs.existsSync(fresh);
    let changed;
    if (!hasCommitted || !hasFresh) {
      changed = true; // added or removed
    } else {
      changed = sha256File(committed) !== sha256File(fresh);
    }
    return { file, changed };
  });
}

function buildReport({ slug, url, published, tmpDir, copy, shots }) {
  const changedCount = shots.filter((s) => s.changed).length;
  const anyDrift = Boolean((copy && copy.changed) || changedCount > 0);
  return {
    slug,
    published,
    url,
    tmpDir,
    copy,
    screenshots: { changedCount, total: shots.length, shots },
    anyDrift,
  };
}

function formatReport(report) {
  if (!report.published) {
    return `"${report.slug}" has not been published yet — nothing to compare against.`;
  }
  const lines = [`Doc: ${report.slug}  (published → ${report.url})`];
  lines.push(`Copy:        ${report.copy.changed ? 'CHANGED since publish' : 'unchanged'}`);
  lines.push(`Screenshots: ${report.screenshots.changedCount} of ${report.screenshots.total} changed`);
  for (const shot of report.screenshots.shots) {
    if (shot.changed) lines.push(`  ${shot.file}   CHANGED`);
  }
  if (!report.anyDrift) lines.push('Up to date — nothing to do.');
  return lines.join('\n');
}

module.exports = {
  sha256File,
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
  formatReport,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/staleness.test.js`
Expected: PASS — `ok — staleness hashing, classification, and report aggregation`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/staleness.js scripts/lib/staleness.test.js
git commit -m "feat(staleness): add pure drift-detection logic"
```

---

### Task 3: `scripts/update-check.js` — CLI drift detector

Thin CLI over Task 2's lib. Reads `meta.json`, guards the not-published case, re-shoots into a temp dir by shelling out to `capture.js`, then builds and emits the report (human to stderr, JSON to stdout). The re-shoot is an injectable function so the command is unit-testable without a browser.

**Files:**
- Create: `scripts/update-check.js`
- Test: `scripts/update-check.test.js`

**Interfaces:**
- Consumes: `parseArgs`, `resolveAppKey` from `./lib/config`; `detectCopyDrift`, `classifyScreenshots`, `buildReport`, `formatReport` from `./lib/staleness`; `scripts/capture.js` via `child_process` with `--out-dir`.
- Produces:
  - `run({ manifestPath, appKey, capture, tmpFactory }) -> report` (report shape from Task 2's `buildReport`). `capture` defaults to `realCapture`; `tmpFactory` defaults to an `os.tmpdir()` mkdtemp. When `meta.publish.url` is absent, returns an unpublished report (`published: false`, `anyDrift: false`) without re-shooting.
  - `realCapture({ manifestPath, appKey, outDir })` — shells out to `capture.js`; throws an `Error` with `.exitCode` of `10`/`20`/`1` on failure.
- Contract: `capture(...)` runs BEFORE any drift computation, so a capture failure (auth/selector) propagates before hashing.

- [ ] **Step 1: Write the failing test**

Create `scripts/update-check.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for update-check run(). Run: node scripts/update-check.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./update-check');
const { sha256File } = require('./lib/staleness');

// Build a fake published doc on disk.
const doc = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
fs.mkdirSync(path.join(doc, 'screenshots'));
fs.writeFileSync(path.join(doc, 'index.md'), '# Hello\n');
const publishedHash = sha256File(path.join(doc, 'index.md'));
fs.writeFileSync(
  path.join(doc, 'manifest.json'),
  JSON.stringify({ app: 'x', feature: 'f', shots: [{ id: '01' }, { id: '02' }] })
);
fs.writeFileSync(
  path.join(doc, 'meta.json'),
  JSON.stringify({ slug: 'demo', publish: { url: 'https://doc', publishedHash } })
);
fs.writeFileSync(path.join(doc, 'screenshots', '01.png'), 'A');
fs.writeFileSync(path.join(doc, 'screenshots', '02.png'), 'B');
const manifestPath = path.join(doc, 'manifest.json');

// Fake captures write "fresh" shots into outDir.
const captureNoDrift = ({ outDir }) => {
  fs.writeFileSync(path.join(outDir, '01.png'), 'A');
  fs.writeFileSync(path.join(outDir, '02.png'), 'B');
};
const captureShotDrift = ({ outDir }) => {
  fs.writeFileSync(path.join(outDir, '01.png'), 'A');
  fs.writeFileSync(path.join(outDir, '02.png'), 'B-CHANGED');
};

// No drift: identical shots + unedited copy.
let r = run({ manifestPath, appKey: 'x', capture: captureNoDrift });
assert.strictEqual(r.published, true, 'doc is published');
assert.strictEqual(r.anyDrift, false, 'identical shots + copy → no drift');

// Screenshot drift.
r = run({ manifestPath, appKey: 'x', capture: captureShotDrift });
assert.strictEqual(r.anyDrift, true, 'byte-diff shot → drift');
assert.strictEqual(r.screenshots.changedCount, 1, 'one shot changed');
assert.strictEqual(r.screenshots.shots.find((s) => s.file === '02.png').changed, true, '02 flagged');

// Copy drift: edit index.md after publishedHash was captured.
fs.writeFileSync(path.join(doc, 'index.md'), '# Hello edited\n');
r = run({ manifestPath, appKey: 'x', capture: captureNoDrift });
assert.strictEqual(r.copy.changed, true, 'edited copy → copy drift');
assert.strictEqual(r.anyDrift, true, 'copy edit alone → drift');
fs.writeFileSync(path.join(doc, 'index.md'), '# Hello\n'); // restore

// Not published: no publish.url → unpublished report, no re-shoot.
fs.writeFileSync(path.join(doc, 'meta.json'), JSON.stringify({ slug: 'demo', publish: {} }));
r = run({ manifestPath, appKey: 'x', capture: captureNoDrift });
assert.strictEqual(r.published, false, 'no url → not published');
assert.strictEqual(r.anyDrift, false, 'unpublished → no drift');

// Exit-code propagation: a capture that throws .exitCode surfaces it.
fs.writeFileSync(
  path.join(doc, 'meta.json'),
  JSON.stringify({ slug: 'demo', publish: { url: 'u', publishedHash } })
);
const captureAuth = () => {
  const e = new Error('auth expired');
  e.exitCode = 10;
  throw e;
};
assert.throws(
  () => run({ manifestPath, appKey: 'x', capture: captureAuth }),
  (e) => e.exitCode === 10,
  'capture auth failure propagates exitCode 10'
);

console.log('ok — update-check detects copy/screenshot drift, handles unpublished, propagates exit codes');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/update-check.test.js`
Expected: FAIL — `Cannot find module './update-check'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/update-check.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * update-check.js — deterministic drift detector for /update-docs.
 *
 * Re-shoots the manifest into a temp dir (by shelling out to capture.js, which
 * stays the only screenshotter), then compares fresh vs committed screenshots
 * and index.md vs the recorded publishedHash. Emits a human report to stderr
 * and a machine-readable JSON report to stdout.
 *
 * Exit codes: 0 success (drift or not); 10 auth expired; 20 selector timeout
 * (UI changed — fix manifest); 1 other errors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, resolveAppKey } = require('./lib/config');
const {
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
  formatReport,
} = require('./lib/staleness');

const EXIT_AUTH = 10;
const EXIT_SELECTOR = 20;

/** Re-shoot by invoking capture.js so it remains the only screenshotter. */
function realCapture({ manifestPath, appKey, outDir }) {
  const res = spawnSync(
    'node',
    [path.join(__dirname, 'capture.js'), '--manifest', manifestPath, '--app', appKey, '--out-dir', outDir],
    { stdio: 'inherit' }
  );
  if (res.status === EXIT_AUTH) {
    const e = new Error('Session expired — run /docs-setup auth, then re-run.');
    e.exitCode = EXIT_AUTH;
    throw e;
  }
  if (res.status === EXIT_SELECTOR) {
    const e = new Error('Selector timeout — the UI has likely changed; update the manifest.');
    e.exitCode = EXIT_SELECTOR;
    throw e;
  }
  if (res.status !== 0) {
    const e = new Error(`capture.js failed (exit ${res.status}).`);
    e.exitCode = 1;
    throw e;
  }
}

function run({ manifestPath, appKey, capture = realCapture, tmpFactory }) {
  const docDir = path.dirname(manifestPath);
  const meta = JSON.parse(fs.readFileSync(path.join(docDir, 'meta.json'), 'utf8'));
  const publish = meta.publish || {};

  if (!publish.url) {
    return {
      slug: meta.slug,
      published: false,
      url: null,
      tmpDir: null,
      copy: null,
      screenshots: { changedCount: 0, total: 0, shots: [] },
      anyDrift: false,
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const shotIds = manifest.shots.map((s) => s.id);
  const makeTmp = tmpFactory || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'update-')));
  const tmpDir = makeTmp();

  capture({ manifestPath, appKey, outDir: tmpDir }); // before drift computation

  const copy = detectCopyDrift(path.join(docDir, 'index.md'), publish.publishedHash);
  const shots = classifyScreenshots(path.join(docDir, 'screenshots'), tmpDir, shotIds);
  return buildReport({ slug: meta.slug, url: publish.url, published: true, tmpDir, copy, shots });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error('Usage: node scripts/update-check.js --manifest docs/<slug>/manifest.json --app <key>');
    process.exit(1);
  }
  const manifestPath = path.resolve(args.manifest);
  const appKey = resolveAppKey(args.app);

  let report;
  try {
    report = run({ manifestPath, appKey });
  } catch (err) {
    if (err.exitCode) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err.stack || String(err));
    process.exit(1);
  }

  console.error(formatReport(report)); // human summary
  console.log(JSON.stringify(report)); // machine-readable for the command layer
  process.exit(0);
}

if (require.main === module) main();

module.exports = { run, realCapture };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/update-check.test.js`
Expected: PASS — `ok — update-check detects copy/screenshot drift, handles unpublished, propagates exit codes`

- [ ] **Step 5: Run all self-checks together**

Run: `node scripts/lib/shopify.test.js && node scripts/lib/md2html.test.js && node scripts/lib/staleness.test.js && node scripts/capture.test.js && node scripts/update-check.test.js`
Expected: five `ok — …` lines, no assertion errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/update-check.js scripts/update-check.test.js
git commit -m "feat(update-check): add CLI drift detector over capture.js"
```

---

### Task 4: `commands/update-docs.md` rewrite + docs consistency + e2e

Replace the "coming soon" stub with real orchestration prose, pin the hash method in the write/publish docs so `publishedHash` matches `update-check.js`, flip the SPEC/skill references from "v2 stub" to shipped, and verify end to end against a real published doc.

**Files:**
- Rewrite: `commands/update-docs.md`
- Modify: `skills/shopify-apps-doc-writer/SKILL.md` (line ~88 hash wording; §6/§7 mention of `/update-docs`)
- Modify: `skills/shopify-apps-doc-writer/references/publish-targets.md` (line ~14 `publishedHash` wording)
- Modify: `SPEC.md` (§1 Non-Goals, §13 v2 Backlog)

**Interfaces:**
- Consumes: `node scripts/update-check.js --manifest <path> --app <key>` → JSON report on stdout with `{ published, anyDrift, url, tmpDir, copy: { changed }, screenshots: { changedCount, total, shots: [{ file, changed }] } }`.

- [ ] **Step 1: Rewrite the command**

Overwrite `commands/update-docs.md` with:

````markdown
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
- `screenshots.changedCount` of `screenshots.total`, listing each `shots[].file` where `changed` is true.

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
````

- [ ] **Step 2: Pin the hash method so `publishedHash` matches**

In `skills/shopify-apps-doc-writer/SKILL.md`, find the line describing `contentHash` (around line 88, `contentHash (sha256 of index.md)`) and change that parenthetical to:

```
`contentHash` (sha256 hex of the raw index.md bytes — `shasum -a 256 index.md`)
```

In `skills/shopify-apps-doc-writer/references/publish-targets.md`, change the `publishedHash` comment (around line 14) from `<sha256 of index.md at publish time>` to:

```
"publishedHash": "<shasum -a 256 index.md at publish time — hex digest only>"
```

- [ ] **Step 3: Flip SPEC from v2-stub to shipped**

In `SPEC.md` §1 Non-Goals (v1), the `/update-docs` line reads:

```
- `/update-docs` staleness detection and re-publish diffing → **v2** (command stubbed).
```

Change it to:

```
- `/update-docs` re-publish *diffing* against a live external doc → **v2**. (Staleness detection + re-shoot + in-place re-publish shipped.)
```

In `SPEC.md` §13 v2 Backlog, remove the `/update-docs` bullet (it is now shipped):

```
- `/update-docs`: contentHash-vs-publishedHash staleness detection; `capture.js --only` driven re-shoots; publish diffing.
```

- [ ] **Step 4: Verify the docs still self-check**

Run: `node scripts/lib/md2html.test.js && node scripts/lib/staleness.test.js && node scripts/update-check.test.js`
Expected: three `ok — …` lines (no code changed here, but confirms nothing regressed).

- [ ] **Step 5: Commit the command + docs**

```bash
git add commands/update-docs.md skills/shopify-apps-doc-writer/SKILL.md skills/shopify-apps-doc-writer/references/publish-targets.md SPEC.md
git commit -m "feat(update-docs): ship /update-docs command and reconcile docs"
```

- [ ] **Step 6: Real end-to-end verification (manual — needs auth + browser)**

Against an existing published doc (`docs/<slug>/` with `meta.json.publish.url` set):

1. No-drift path:
   Run: `node scripts/update-check.js --manifest docs/<slug>/manifest.json --app <key>`
   Expected: human summary ends with `Up to date — nothing to do.` and the JSON has `"anyDrift":false`.

2. Copy-drift path:
   Edit `docs/<slug>/index.md` (add a sentence), then re-run the same command.
   Expected: human summary shows `Copy:        CHANGED since publish` and JSON `"copy":{"changed":true,...}`, `"anyDrift":true`. Revert the edit afterward.

3. Confirm the gate wording:
   Run `/update-docs <slug>` in Claude and confirm it prints an exact gate-3 summary before any external write and stops for explicit approval.

- [ ] **Step 7: Commit any manifest/doc fixes surfaced by e2e** (only if step 6 required changes)

```bash
git add -A
git commit -m "fix(update-docs): address findings from end-to-end verification"
```

---

## Self-Review

**1. Spec coverage:**
- §1 Scope & trigger → Task 3 `run()` not-published guard; Task 4 command steps 1–2. ✓
- §2 Two drift axes → Task 2 `detectCopyDrift` + `classifyScreenshots`; byte-level via `sha256File`. ✓
- §3a `capture.js --out-dir` → Task 1. ✓
- §3b `update-check.js` (shell out, JSON report, exit codes) → Task 3. ✓ (pure logic split into `lib/staleness.js`, Task 2 — a pattern-consistency refinement, still covers the spec's responsibilities.)
- §3c command rewrite → Task 4 step 1. ✓
- §4 Data flow → realised across Tasks 2–4. ✓
- §5 Gates & invariants → Task 4 command (gate 3, promotion confirm); read-only inherited via capture.js (Global Constraints). ✓
- §6 Testing → `staleness.test.js`, `update-check.test.js`, `capture.test.js`, plus manual e2e (Task 4 step 6). ✓
- §7 Out of scope → nothing in the plan implements deferred items. ✓
- **Added beyond spec:** hash-method pinning (Task 4 step 2). Justified — the spec assumed a `publishedHash` exists but the repo computes it by prose; without pinning, copy-drift would false-flag. Flagged in Global Constraints.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". `<key>`/`<slug>`/`<tmpDir>`/`<url>`/`<file>` are runtime values the operator/command substitutes, not plan placeholders. All code steps show complete code.

**3. Type consistency:** `run()` returns `buildReport(...)`'s shape; the report fields (`published`, `anyDrift`, `copy.changed`, `screenshots.changedCount`/`total`/`shots[].file`/`changed`, `tmpDir`, `url`) are identical in Task 2 (definition), Task 3 (test asserts + command consumption), and Task 4 (command prose). `resolveOutDir(args, manifestPath)`, `sha256File`, `detectCopyDrift`, `classifyScreenshots`, `buildReport`, `formatReport`, `run`, `realCapture` names match across definition, export, and call sites. `capture` injection signature `{ manifestPath, appKey, outDir }` is consistent between `realCapture`, `run`, and the test fakes.

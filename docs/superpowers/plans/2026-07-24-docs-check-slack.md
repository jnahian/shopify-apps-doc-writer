# `/docs-check` Staleness Sweep + Slack Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scan-all staleness sweep (`update-check.js --all` + `/docs-check` command) and an optional draft-only Slack notification step to `/docs-deploy`.

**Architecture:** `--all` mode reuses the existing per-doc drift machinery in `scripts/update-check.js` (`run()`), extended with a `sweep` option so never-published drafts get screenshot-drift checks too; a new `runAll()` iterates `docs/*/`, aggregates one JSON report, contains per-doc selector failures, and deletes temp dirs (report-only). Two prose commands do the rest. Spec: `docs/superpowers/specs/2026-07-24-docs-check-slack-design.md`.

**Tech Stack:** Node ≥ 20 (CommonJS, `'use strict'`), plain-`assert` self-check tests, Slack MCP draft tool.

## Global Constraints

- **Prerequisite:** the docs-site plan (`docs/superpowers/plans/2026-07-24-docs-deploy.md`) must be executed first — Task 4 here amends `commands/docs-deploy.md`, which that plan's Task 3 creates.
- **Single-doc path byte-for-byte unchanged:** `run({manifestPath, appKey, capture, tmpFactory})` without the new `sweep` option must behave exactly as today (unpublished → early return, no capture; copy drift always computed for published docs). All existing tests must keep passing unmodified.
- **`capture.js` stays the only screenshotter** — sweep re-shoots by the same `realCapture` spawn path as today.
- **Report-only:** the sweep and `/docs-check` never write to `docs/*/`, never promote screenshots, never publish. No confirmation gates needed.
- **Exit codes (`--all` mode):** `0` sweep completed (drift or not, including per-doc selector errors); `10` auth expired (aborts run); `1` other fatal. Exit `20` is never emitted in `--all` mode — selector timeouts are per-doc data. Single-doc mode keeps `0/10/20/1` as today.
- **Slack is draft-only:** deliver via `slack_send_message_draft`; the direct-send tool is never used in this flow. Never auto-send.
- **No new npm dependencies.** Config stays per-user and uncommitted (`deploy.slackChannel`).
- Scripts emit human report to **stderr**, machine JSON to **stdout**.
- Match existing style: `'use strict'`, `const` fns, comments only for non-obvious constraints.

---

### Task 1: `run()` sweep option + `runAll()` aggregation

**Files:**
- Modify: `scripts/update-check.js`
- Test: `scripts/update-check.test.js` (append cases)

**Interfaces:**
- Consumes: existing `run()`, `realCapture`, and `detectCopyDrift`/`classifyScreenshots`/`buildReport` from `scripts/lib/staleness.js` (unchanged).
- Produces:
  - `run(opts)` gains `sweep: boolean` (default `false`). With `sweep: true`, unpublished docs are captured and compared too; `copy` is `null` when `meta.publish.publishedHash` is absent; `published` is `Boolean(publish.url)`.
  - `runAll({ docsDir, appKey, capture?, tmpFactory? })` → `{ docs: [{slug, published, copy, screenshots, error, anyDrift}], skipped: [{dir, reason}], checked: number, anyDrift: boolean }`. Exported via `module.exports = { run, runAll, realCapture }`. Task 2's CLI and Task 3's command consume this shape.

- [ ] **Step 1: Write the failing tests**

Append to the end of `scripts/update-check.test.js` (replace the final `console.log` line with this block, which ends in an updated `console.log`):

```js
// --- Sweep mode (--all): runAll over a docs root ---------------------------

const { runAll } = require('./update-check');

const docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));

function makeDoc(slug, publish, committedShotBytes) {
  const d = path.join(docsRoot, slug);
  fs.mkdirSync(path.join(d, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.md'), `# ${slug}\n`);
  if (publish && publish.publishedHash === 'CURRENT') {
    publish.publishedHash = sha256File(path.join(d, 'index.md'));
  }
  fs.writeFileSync(
    path.join(d, 'manifest.json'),
    JSON.stringify({ app: 'x', feature: slug, shots: [{ id: '01' }] })
  );
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ slug, publish: publish || {} }));
  fs.writeFileSync(path.join(d, 'screenshots', '01.png'), committedShotBytes);
}

makeDoc('clean-pub', { url: 'u', publishedHash: 'CURRENT' }, 'SAME');
makeDoc('stale-pub', { url: 'u', publishedHash: 'CURRENT' }, 'OLD');
makeDoc('stale-draft', null, 'OLD'); // never published — must still get screenshot drift
makeDoc('broken-ui', null, 'X');
fs.mkdirSync(path.join(docsRoot, 'not-a-doc')); // no manifest.json → skipped, not a crash

// Fake capture keyed by doc: clean-pub re-shoots identical bytes, broken-ui
// hits a selector timeout, everything else re-shoots changed bytes.
const sweepCapture = ({ manifestPath, outDir }) => {
  const slug = path.basename(path.dirname(manifestPath));
  if (slug === 'broken-ui') {
    const e = new Error('selector timeout');
    e.exitCode = 20;
    throw e;
  }
  fs.writeFileSync(path.join(outDir, '01.png'), slug === 'clean-pub' ? 'SAME' : 'NEW');
};

const madeTmp = [];
const trackedTmp = () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  madeTmp.push(t);
  return t;
};

const sweep = runAll({ docsDir: docsRoot, appKey: 'x', capture: sweepCapture, tmpFactory: trackedTmp });

assert.strictEqual(sweep.checked, 4, 'four doc dirs checked');
assert.deepStrictEqual(
  sweep.skipped,
  [{ dir: 'not-a-doc', reason: 'no manifest.json' }],
  'dir without manifest skipped with reason'
);

const bySlug = Object.fromEntries(sweep.docs.map((d) => [d.slug, d]));

assert.strictEqual(bySlug['clean-pub'].anyDrift, false, 'clean published doc → no drift');
assert.strictEqual(bySlug['clean-pub'].error, null, 'clean doc has no error');

assert.strictEqual(bySlug['stale-pub'].anyDrift, true, 'stale published doc → drift');
assert.strictEqual(bySlug['stale-pub'].screenshots.changedCount, 1, 'its shot changed');
assert.strictEqual(bySlug['stale-pub'].copy.changed, false, 'its copy did not change');

assert.strictEqual(bySlug['stale-draft'].published, false, 'draft reported unpublished');
assert.strictEqual(bySlug['stale-draft'].copy, null, 'no publishedHash → copy not compared');
assert.strictEqual(bySlug['stale-draft'].screenshots.changedCount, 1, 'draft screenshot drift IS detected');
assert.strictEqual(bySlug['stale-draft'].anyDrift, true, 'draft drift counts');

assert.strictEqual(bySlug['broken-ui'].error, 'selector-timeout', 'selector timeout contained per-doc');
assert.strictEqual(bySlug['broken-ui'].screenshots, null, 'no comparison data for the broken doc');

assert.strictEqual(sweep.anyDrift, true, 'aggregate drift flag set');

assert.ok(madeTmp.length >= 3, 'sweep actually captured');
assert.ok(madeTmp.every((t) => !fs.existsSync(t)), 'sweep deletes every temp dir (report-only)');

// Auth expiry aborts the whole sweep — every doc would fail identically.
assert.throws(
  () => runAll({ docsDir: docsRoot, appKey: 'x', capture: captureAuth }),
  (e) => e.exitCode === 10,
  'auth expiry aborts the sweep'
);

// Single-doc semantics untouched: unpublished doc without sweep → no capture.
fs.writeFileSync(path.join(doc, 'meta.json'), JSON.stringify({ slug: 'demo', publish: {} }));
r = run({ manifestPath, appKey: 'x', capture: () => assert.fail('must not capture') });
assert.strictEqual(r.published, false, 'single-doc unpublished still short-circuits');

console.log(
  'ok — update-check detects copy/screenshot drift, honors driftCheck, handles unpublished, propagates exit codes, and sweeps all docs in --all mode'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/update-check.test.js`
Expected: FAIL — `runAll` is undefined (`runAll is not a function`).

- [ ] **Step 3: Implement `sweep` option and `runAll`**

In `scripts/update-check.js`:

3a. Change `run`'s signature line and the unpublished short-circuit condition (currently `if (!publish.url) {`):

```js
function run({ manifestPath, appKey, capture = realCapture, tmpFactory, sweep = false }) {
  const docDir = path.dirname(manifestPath);
  const meta = JSON.parse(fs.readFileSync(path.join(docDir, 'meta.json'), 'utf8'));
  const publish = meta.publish || {};

  // Single-doc mode is about refreshing *published* docs; the sweep checks
  // screenshot drift on drafts too, so it skips this short-circuit.
  if (!publish.url && !sweep) {
```

3b. Replace the two lines computing `copy` and the `buildReport` call at the end of `run` with:

```js
  const copy =
    !sweep || publish.publishedHash
      ? detectCopyDrift(path.join(docDir, 'index.md'), publish.publishedHash)
      : null;
  const shots = classifyScreenshots(path.join(docDir, 'screenshots'), tmpDir, manifest.shots);
  return buildReport({
    slug: meta.slug,
    url: publish.url || null,
    published: Boolean(publish.url),
    tmpDir,
    copy,
    shots,
  });
```

3c. Add `runAll` after `run`:

```js
/**
 * Sweep every doc dir under docsDir. Report-only: temp capture dirs are
 * deleted immediately after each comparison. A selector timeout in one doc
 * becomes that doc's `error` and the sweep continues; auth expiry (10)
 * aborts — every subsequent doc would fail identically.
 */
function runAll({ docsDir, appKey, capture = realCapture, tmpFactory }) {
  const docs = [];
  const skipped = [];
  const entries = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];

  for (const e of entries) {
    const dir = path.join(docsDir, e.name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      skipped.push({ dir: e.name, reason: 'no manifest.json' });
      continue;
    }
    if (!fs.existsSync(path.join(dir, 'meta.json'))) {
      skipped.push({ dir: e.name, reason: 'no meta.json' });
      continue;
    }

    let report;
    try {
      report = run({ manifestPath: path.join(dir, 'manifest.json'), appKey, capture, tmpFactory, sweep: true });
    } catch (err) {
      if (err.exitCode === 20) {
        docs.push({ slug: e.name, published: null, copy: null, screenshots: null, error: 'selector-timeout', anyDrift: false });
        continue;
      }
      throw err;
    }

    if (report.tmpDir) fs.rmSync(report.tmpDir, { recursive: true, force: true });
    docs.push({
      slug: report.slug || e.name,
      published: report.published,
      copy: report.copy,
      screenshots: report.screenshots,
      error: null,
      anyDrift: report.anyDrift,
    });
  }

  return {
    docs,
    skipped,
    checked: docs.length,
    anyDrift: docs.some((d) => d.anyDrift),
  };
}
```

3d. Update the exports line:

```js
module.exports = { run, runAll, realCapture };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/update-check.test.js`
Expected: PASS — prints the updated `ok — …` line. Also run `node scripts/lib/md2html.test.js && node scripts/lib/shopify.test.js` to confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-check.js scripts/update-check.test.js
git commit -m "feat(update-check): runAll sweep — drafts included, per-doc error containment"
```

---

### Task 2: `--all` CLI mode

**Files:**
- Modify: `scripts/update-check.js` (file header comment + `main()`)

**Interfaces:**
- Consumes: `runAll()` from Task 1.
- Produces: `node scripts/update-check.js --all --app <key>` → stdout JSON `{ docs, skipped, checked, anyDrift }` (the `runAll` return value verbatim), human summary on stderr. `--all` and `--manifest` are mutually exclusive. Task 3's command parses this stdout JSON.

- [ ] **Step 1: Update the file header comment**

Replace the exit-codes line in the top comment block of `scripts/update-check.js`:

```js
 * Exit codes: 0 success (drift or not); 10 auth expired; 20 selector timeout
 * (UI changed — fix manifest); 1 other errors. In --all sweep mode, selector
 * timeouts are per-doc report entries, not exit 20.
```

- [ ] **Step 2: Add a sweep formatter and rewrite `main()`**

Add above `main()`:

```js
function formatSweep(report) {
  const lines = [`Checked ${report.checked} doc(s)`];
  for (const d of report.docs) {
    if (d.error) {
      lines.push(`  ${d.slug}   ERROR: ${d.error} — manifest needs updating (/write-docs)`);
      continue;
    }
    const parts = [];
    if (d.copy && d.copy.changed) parts.push('copy changed');
    if (d.screenshots.changedCount) parts.push(`${d.screenshots.changedCount}/${d.screenshots.total} shots changed`);
    if (d.screenshots.skippedCount) parts.push(`${d.screenshots.skippedCount} not compared`);
    lines.push(`  ${d.slug}${d.published ? '' : ' (draft)'}   ${parts.length ? parts.join(', ') : 'up to date'}`);
  }
  for (const s of report.skipped) lines.push(`  skipped ${s.dir}: ${s.reason}`);
  return lines.join('\n');
}
```

Replace `main()` with (the single-doc branch is today's body unchanged; `loadConfig` joins the existing `require('./lib/config')` destructure):

```js
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Boolean(args.all) === Boolean(args.manifest)) {
    console.error(
      'Usage: node scripts/update-check.js --manifest docs/<slug>/manifest.json --app <key>\n' +
        '   or: node scripts/update-check.js --all --app <key>'
    );
    process.exit(1);
  }
  const appKey = resolveAppKey(args.app);

  let report;
  try {
    if (args.all) {
      const config = loadConfig(appKey);
      report = runAll({ docsDir: path.resolve(config.capture.outputDir), appKey });
    } else {
      report = run({ manifestPath: path.resolve(args.manifest), appKey });
    }
  } catch (err) {
    if (err.exitCode) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err.stack || String(err));
    process.exit(1);
  }

  console.error(args.all ? formatSweep(report) : formatReport(report)); // human summary
  console.log(JSON.stringify(report)); // machine-readable for the command layer
  process.exit(0);
}
```

Update the config require at the top of the file to include `loadConfig`:

```js
const { parseArgs, resolveAppKey, loadConfig } = require('./lib/config');
```

- [ ] **Step 3: Verify the CLI arg contract (no config needed)**

Run: `node scripts/update-check.js --all --manifest x`
Expected: usage message on stderr, exit 1 (`echo $?` → `1`).

Run: `node scripts/update-check.js`
Expected: same usage message, exit 1.

Run: `node scripts/update-check.test.js`
Expected: PASS (CLI changes don't touch `run`/`runAll`).

- [ ] **Step 4: Commit**

```bash
git add scripts/update-check.js
git commit -m "feat(update-check): --all CLI mode with aggregate sweep report"
```

---

### Task 3: `/docs-check` command

**Files:**
- Create: `commands/docs-check.md`

**Interfaces:**
- Consumes: `node scripts/update-check.js --all --app <key>` stdout JSON from Task 2: `{ docs: [{slug, published, copy, screenshots, error, anyDrift}], skipped, checked, anyDrift }`.
- Produces: the user-facing `/docs-check` command.

- [ ] **Step 1: Write `commands/docs-check.md`**

````md
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
- else if `copy.changed` is true or `screenshots.changedCount > 0` → **stale**;
  say exactly what: "copy changed", "N of M shots changed" (list the changed
  `shots[].file` names), and append "(draft)" when `published` is false.
- else → **up to date**.

Also report:

- `skipped` dirs with their reasons (not doc dirs — missing manifest/meta);
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
````

- [ ] **Step 2: Verify end-to-end if a real config exists**

If a per-user config and real docs exist (dogfooding setup):

```bash
node scripts/update-check.js --all --app storeseo
```

Expected: stderr sweep summary (`Checked N doc(s)` + per-doc lines), stdout JSON. If no config/docs exist in this environment, skip — Task 1's tests cover the sweep.

- [ ] **Step 3: Commit**

```bash
git add commands/docs-check.md
git commit -m "feat(docs-check): /docs-check pre-release staleness sweep command"
```

---

### Task 4: Slack step in `/docs-deploy` + documentation

**Files:**
- Modify: `commands/docs-deploy.md` (created by the docs-site plan — see Global Constraints)
- Modify: `README.md` (How-it-works block ~line 10, Layout block ~line 66)
- Modify: `CLAUDE.md` (Commands section)

**Interfaces:**
- Consumes: `/docs-deploy`'s deploy result (URL, built doc list) from its earlier steps; Slack MCP tool `slack_send_message_draft`.

- [ ] **Step 1: Append the Slack step to `commands/docs-deploy.md`**

Insert after the `## 4. Wrap up` section, before `## Notes`:

````md
## 5. Offer a Slack heads-up (optional, draft-only)

After a successful deploy, offer once: "Post a review heads-up to Slack?"
If declined, skip silently.

1. Channel comes from per-user config `deploy.slackChannel`. If unset, ask
   which channel to use, then save it under `deploy.slackChannel` in
   `~/.config/shopify-apps-doc-writer/<app-key>.json` for next time (config
   stays per-user and uncommitted).
2. Compose and show the message before doing anything with it:

   > Docs site updated: https://<pagesProject>.pages.dev — N docs
   > (M drafts: <draft slugs>). Review when you get a chance.

3. Deliver with the Slack MCP **draft** tool (`slack_send_message_draft`):
   the message lands in the user's Slack drafts for that channel and they
   send it themselves. Never use the direct-send Slack tool in this flow —
   "never auto-send" is structural, not a promise.
4. If no Slack MCP is connected, say so and print the message for manual
   copy-paste — degraded, never broken.
````

- [ ] **Step 2: Update `README.md`**

In the "How it works" fenced block, after the `/docs-deploy` line (added by the docs-site plan), add:

```
/docs-check            re-shoot every manifest → report which docs went stale
```

In the "Layout" fenced block, extend the `commands/` line to include `/docs-check`:

```
commands/                            /docs-setup · /write-docs · /update-docs · /docs-deploy · /docs-check
```

and change the `scripts/update-check.js` line to:

```
scripts/update-check.js              drift detector for /update-docs (--all: sweep for /docs-check)
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the first commands fenced block, after the `capture.js` line, add:

```bash
node scripts/update-check.js --all --app <key>          # staleness sweep across all docs (/docs-check)
```

- [ ] **Step 4: Run all self-checks**

Run: `node scripts/update-check.test.js && node scripts/lib/md2html.test.js && node scripts/lib/shopify.test.js && node scripts/build-site.test.js`
Expected: four `ok — …` lines (build-site test exists once the docs-site plan has run; if it hasn't yet, that command fails on the missing file — see Global Constraints prerequisite).

- [ ] **Step 5: Commit**

```bash
git add commands/docs-deploy.md README.md CLAUDE.md
git commit -m "feat(docs-deploy): draft-only Slack review notification; document /docs-check"
```

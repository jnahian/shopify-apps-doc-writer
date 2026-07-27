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

// driftCheck:false — a volatile shot whose bytes changed must not report drift.
fs.writeFileSync(
  path.join(doc, 'manifest.json'),
  JSON.stringify({ app: 'x', feature: 'f', shots: [{ id: '01' }, { id: '02', driftCheck: false }] })
);
r = run({ manifestPath, appKey: 'x', capture: captureShotDrift });
assert.strictEqual(r.screenshots.skippedCount, 1, 'volatile shot skipped');
assert.strictEqual(r.screenshots.changedCount, 0, 'changed bytes on a skipped shot are not drift');
assert.strictEqual(r.anyDrift, false, 'volatile shot alone does not trigger drift');

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

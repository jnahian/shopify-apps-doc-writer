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

console.log('ok — update-check detects copy/screenshot drift, honors driftCheck, handles unpublished, propagates exit codes');

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

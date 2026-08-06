#!/usr/bin/env node
'use strict';

/** Self-check for the unattended sweep runner. Run: node scripts/sweep.test.js */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox HOME before requiring anything that derives CONFIG_DIR from it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const assert = require('assert');
const { spawnSync } = require('child_process');
const { saveConfig, sweepPath } = require('./lib/config');
const { classifyOutcome } = require('./sweep');

// --- classifyOutcome: environment-level exits map to their own statuses ---
assert.deepStrictEqual(classifyOutcome({ exitCode: 10, stdout: '' }), { status: 'auth-expired' });
assert.deepStrictEqual(classifyOutcome({ exitCode: 30, stdout: '' }), { status: 'bot-challenge' });

// Other nonzero exits → error, carrying whatever text we have.
assert.deepStrictEqual(
  classifyOutcome({ exitCode: 1, stdout: '', errorText: 'boom' }),
  { status: 'error', message: 'boom' }
);
assert.deepStrictEqual(
  classifyOutcome({ exitCode: 7, stdout: '' }),
  { status: 'error', message: 'update-check exited 7' }
);

// Exit 0 but stdout is not JSON → error, not a crash.
assert.strictEqual(classifyOutcome({ exitCode: 0, stdout: 'garbage' }).status, 'error');

// Clean report → ok, with an empty-but-present summary.
const clean = {
  docs: [
    { slug: 'a', published: true, copy: { changed: false }, screenshots: { changedCount: 0, skippedCount: 0, total: 3, shots: [] }, error: null, anyDrift: false },
  ],
  skipped: [],
  checked: 1,
  anyDrift: false,
};
const okOut = classifyOutcome({ exitCode: 0, stdout: JSON.stringify(clean) });
assert.strictEqual(okOut.status, 'ok');
assert.deepStrictEqual(okOut.summary, { checked: 1, stale: [], errors: [], skipped: [] });
assert.deepStrictEqual(okOut.raw, clean, 'raw report kept for /docs-check reuse');

// Drift and per-doc errors → drift, with the notice-ready summary.
const drifty = {
  docs: [
    { slug: 'ai-seo', published: true, copy: { changed: true }, screenshots: { changedCount: 2, skippedCount: 0, total: 5, shots: [] }, error: null, anyDrift: true },
    { slug: 'img-opt', published: false, copy: null, screenshots: { changedCount: 1, skippedCount: 1, total: 4, shots: [] }, error: null, anyDrift: true },
    { slug: 'broken', published: null, copy: null, screenshots: null, error: 'selector-timeout', anyDrift: false },
    { slug: 'fine', published: true, copy: { changed: false }, screenshots: { changedCount: 0, skippedCount: 0, total: 2, shots: [] }, error: null, anyDrift: false },
  ],
  skipped: [{ dir: 'not-a-doc', reason: 'no manifest.json' }],
  checked: 4,
  anyDrift: true,
};
const driftOut = classifyOutcome({ exitCode: 0, stdout: JSON.stringify(drifty) });
assert.strictEqual(driftOut.status, 'drift');
assert.ok(driftOut.summary);
assert.deepStrictEqual(driftOut.summary.stale, [
  { slug: 'ai-seo', copyChanged: true, shotsChanged: 2, total: 5, published: true },
  { slug: 'img-opt', copyChanged: false, shotsChanged: 1, total: 4, published: false },
]);
assert.deepStrictEqual(driftOut.summary.errors, [{ slug: 'broken', error: 'selector-timeout' }]);
assert.deepStrictEqual(driftOut.summary.skipped, [{ dir: 'not-a-doc', reason: 'no manifest.json' }]);

// Per-doc errors alone (no stale docs) are still noteworthy → drift.
const errOnly = { docs: [{ slug: 'broken', published: null, copy: null, screenshots: null, error: 'capture-failed', anyDrift: false }], skipped: [], checked: 1, anyDrift: false };
assert.strictEqual(classifyOutcome({ exitCode: 0, stdout: JSON.stringify(errOnly) }).status, 'drift');

// --- CLI integration: no docs dir → checked 0 → ok record written to sweep.json ---
// update-check's runAll returns {docs: [], checked: 0} for a missing docs dir,
// so this exercises the full spawn → classify → persist path with no browser.
saveConfig('teststore', { store: 't.myshopify.com', appHandle: 'teststore' });
const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-repo-'));
const res = spawnSync(process.execPath, [path.join(__dirname, 'sweep.js'), '--app', 'teststore'], {
  cwd: emptyRepo,
  env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
  encoding: 'utf8',
});
assert.strictEqual(res.status, 0, `sweep.js exits 0 (stderr: ${res.stderr})`);
const record = JSON.parse(fs.readFileSync(sweepPath('teststore'), 'utf8'));
assert.strictEqual(record.status, 'ok');
assert.strictEqual(record.summary.checked, 0);
assert.ok(!Number.isNaN(Date.parse(record.at)), 'at is a parsable timestamp');

console.log('sweep.test.js OK');

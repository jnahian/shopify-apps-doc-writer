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

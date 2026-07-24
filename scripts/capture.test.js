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

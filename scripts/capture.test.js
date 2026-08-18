#!/usr/bin/env node
'use strict';

/** Self-check for resolveOutDir. Run: node scripts/capture.test.js */

const assert = require('assert');
const path = require('path');
const { resolveOutDir, resolveBrowser, checkReadOnly, validateManifest } = require('./capture');

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

// resolveBrowser: precedence CLI > manifest > config > default 'chrome'.
assert.deepStrictEqual(
  resolveBrowser({}, {}, {}),
  { name: 'chrome', engine: 'chromium', channel: 'chrome' },
  'default is chrome'
);
assert.deepStrictEqual(
  resolveBrowser({}, {}, { capture: { browser: 'webkit' } }),
  { name: 'webkit', engine: 'webkit' },
  'config beats default'
);
assert.deepStrictEqual(
  resolveBrowser({}, { browser: 'firefox' }, { capture: { browser: 'webkit' } }),
  { name: 'firefox', engine: 'firefox' },
  'manifest beats config'
);
assert.deepStrictEqual(
  resolveBrowser({ browser: 'msedge' }, { browser: 'firefox' }, { capture: { browser: 'webkit' } }),
  { name: 'msedge', engine: 'chromium', channel: 'msedge' },
  'CLI beats manifest'
);
assert.deepStrictEqual(
  resolveBrowser({ browser: 'chromium' }, {}, {}),
  { name: 'chromium', engine: 'chromium' },
  'bare chromium has no channel'
);
assert.throws(
  () => resolveBrowser({ browser: 'safari' }, {}, {}),
  /Unknown browser "safari".*chrome, msedge, chromium, firefox, webkit/s,
  'unknown name throws listing valid names'
);

console.log('ok — resolveBrowser precedence and validation');

// A manifest with valid annotations passes validation (returns; any failure
// would process.exit(1) and fail this suite).
validateManifest(
  {
    app: 'x',
    feature: 'f',
    shots: [
      {
        id: '01-a',
        path: '/admin/apps/x',
        waitFor: '#ready',
        annotate: [
          { type: 'highlight', target: "[data-testid='sov-score']" },
          { type: 'arrow', target: "[data-testid='add-keyword']", side: 'bottom' },
          { type: 'blur', target: "[data-testid='store-email']", fill: '#1a1a1a' },
        ],
      },
    ],
  },
  'test-manifest.json'
);

console.log('ok — validateManifest accepts a valid annotate array');

// Annotate targets are measured, never clicked — a destructive-looking
// selector in an annotation must not trip the read-only guarantee.
checkReadOnly({
  app: 'x',
  feature: 'f',
  shots: [
    {
      id: '01-a',
      path: '/admin/apps/x',
      waitFor: '#ready',
      annotate: [{ type: 'highlight', target: "[data-testid='save-button']" }],
    },
  ],
});

console.log('ok — checkReadOnly ignores annotate targets');

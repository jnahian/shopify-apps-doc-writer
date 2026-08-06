#!/usr/bin/env node
'use strict';

/** Self-check for config loading/resolution. Run: node scripts/lib/config.test.js */

const fs = require('fs');
const os = require('os');
const path = require('path');

// CONFIG_DIR is derived from os.homedir() at require time — point HOME at a
// sandbox before requiring so no test touches the real ~/.config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const assert = require('assert');
const {
  CONFIG_DIR,
  expandHome,
  authPath,
  listAppKeys,
  resolveAppKey,
  loadConfig,
  saveConfig,
  parseArgs,
} = require('./config');

assert.ok(CONFIG_DIR.startsWith(tmp), 'CONFIG_DIR is sandboxed under the temp HOME');

// expandHome: ~ resolves against homedir, everything else passes through.
assert.strictEqual(expandHome('~/x/y'), path.join(tmp, 'x/y'), '~ expands to homedir');
assert.strictEqual(expandHome('/abs/p'), '/abs/p', 'absolute path unchanged');
assert.strictEqual(expandHome(''), '', 'empty string passes through');

// parseArgs: --flag value pairs, bare boolean flags, non-flag tokens ignored.
assert.deepStrictEqual(
  parseArgs(['--app', 'storeseo', '--headed', '--only', 'shot-01']),
  { app: 'storeseo', headed: true, only: 'shot-01' },
  'value flags and a boolean flag between them'
);
assert.deepStrictEqual(parseArgs(['stray', '--all']), { all: true }, 'trailing boolean; non-flag token ignored');
assert.deepStrictEqual(parseArgs([]), {}, 'empty argv');

// resolveAppKey: explicit wins even with no configs on disk.
assert.strictEqual(resolveAppKey('given'), 'given', 'explicit key wins');

// Zero configs → guidance to run /docs-setup.
assert.throws(() => resolveAppKey(), /No config found .*docs-setup/, 'no configs → setup guidance');

// One config → it is the default. *.auth.json must not count as a config.
saveConfig('storeseo', { store: 's.myshopify.com', appHandle: 'storeseo' });
fs.writeFileSync(authPath('storeseo'), '{}');
assert.deepStrictEqual(listAppKeys(), ['storeseo'], 'auth.json excluded from app keys');
assert.strictEqual(resolveAppKey(), 'storeseo', 'single config resolves without --app');

// Two configs → must be explicit.
saveConfig('other', { store: 'o.myshopify.com', appHandle: 'other' });
assert.throws(() => resolveAppKey(), /Multiple app configs .*--app/, 'ambiguous → asks for --app');

// loadConfig: defaults deep-merged under user values; appKey stamped.
const cfg = loadConfig('storeseo');
assert.strictEqual(cfg.appKey, 'storeseo', 'appKey stamped from filename key');
assert.deepStrictEqual(cfg.viewport, { width: 1440, height: 900 }, 'viewport default applied');
assert.strictEqual(cfg.capture.browser, 'chrome', 'capture defaults applied');
assert.strictEqual(cfg.storageState, authPath('storeseo'), 'storageState defaults to the auth path');

// Partial nested override keeps sibling defaults.
saveConfig('storeseo', { capture: { headless: false } });
const over = loadConfig('storeseo');
assert.strictEqual(over.capture.headless, false, 'nested override applied');
assert.strictEqual(over.capture.outputDir, 'docs', 'sibling default survives nested override');

// storageState with ~ is expanded.
saveConfig('storeseo', { storageState: '~/custom.auth.json' });
assert.strictEqual(loadConfig('storeseo').storageState, path.join(tmp, 'custom.auth.json'), '~ in storageState expanded');

// Failure modes: missing file, invalid JSON, missing required fields.
assert.throws(() => loadConfig('nope'), /Config not found/, 'missing config file');
fs.writeFileSync(path.join(CONFIG_DIR, 'broken.json'), '{not json');
assert.throws(() => loadConfig('broken'), /not valid JSON/, 'invalid JSON reported as such');
saveConfig('bare', { store: 'b.myshopify.com' });
assert.throws(() => loadConfig('bare'), /missing required field "appHandle"/, 'missing appHandle rejected');

// saveConfig merges patches instead of clobbering.
const merged = saveConfig('other', { publish: { target: 'google-docs' } });
assert.strictEqual(merged.store, 'o.myshopify.com', 'existing fields survive a patch');
assert.strictEqual(loadConfig('other').publish.target, 'google-docs', 'patch persisted');

// sweepPath: sibling of configPath/authPath, one record per app.
const { sweepPath } = require('./config');
assert.strictEqual(
  sweepPath('storeseo'),
  path.join(CONFIG_DIR, 'storeseo.sweep.json'),
  'sweepPath lives in CONFIG_DIR'
);

console.log('ok — config defaults merge, app-key resolution, arg parsing, and failure guidance');

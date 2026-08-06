#!/usr/bin/env node
'use strict';

/** Self-check for launchd plist/shim generation. Run: node scripts/schedule-sweep.test.js */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox HOME before requiring — CONFIG_DIR and plistPath derive from it.
// Use a tmpdir with a literal & to test XML escaping.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched&test-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const assert = require('assert');
const { CONFIG_DIR } = require('./lib/config');
const { parseAt, plistContent, shimContent, label, plistPath, shimPath, logPath, shq, xmlEscape, assertSafeAppKey } = require('./schedule-sweep');

// parseAt: 24h HH:MM, strict.
assert.deepStrictEqual(parseAt('03:00'), { hour: 3, minute: 0 });
assert.deepStrictEqual(parseAt('23:59'), { hour: 23, minute: 59 });
assert.deepStrictEqual(parseAt('9:30'), { hour: 9, minute: 30 }, 'single-digit hour allowed');
for (const bad of ['24:00', '12:60', '12', 'noon', '12:5', '']) {
  assert.throws(() => parseAt(bad), /HH:MM/, `rejects "${bad}"`);
}

// Helper functions: shq and xmlEscape are real.
assert.strictEqual(shq("it's"), "'it'\"'\"'s'", 'shq escapes embedded quotes');
assert.strictEqual(xmlEscape('a&b<c>d'), 'a&amp;b&lt;c&gt;d', 'xmlEscape handles &, <, >');
assert.strictEqual(xmlEscape('&lt;'), '&amp;lt;', 'xmlEscape does not double-escape');

// assertSafeAppKey validates the regex.
assertSafeAppKey('storeseo'); // doesn't throw
assertSafeAppKey('app.key_v1');
assert.throws(() => assertSafeAppKey('bad key!'), /unsafe/, 'rejects spaces');
assert.throws(() => assertSafeAppKey('x"; rm -rf ~ #'), /unsafe/, 'rejects injection attempt');
assert.throws(() => assertSafeAppKey('-badstart'), /unsafe/, 'rejects leading dash');

// Paths: per-app, stable, derived from the app key.
assert.strictEqual(label('storeseo'), 'com.shopify-apps-doc-writer.sweep.storeseo');
assert.strictEqual(plistPath('storeseo'), path.join(tmp, 'Library', 'LaunchAgents', 'com.shopify-apps-doc-writer.sweep.storeseo.plist'));
assert.strictEqual(shimPath('storeseo'), path.join(CONFIG_DIR, 'storeseo.sweep-runner.sh'));
assert.strictEqual(logPath('storeseo'), path.join(CONFIG_DIR, 'storeseo.sweep.log'));

// CONFIG_DIR contains & (from the tmpdir), so shimPath and logPath contain &.
// plist must escape them.
const plist = plistContent({ appKey: 'storeseo', hour: 3, minute: 0 });
assert.ok(plist.includes('<string>com.shopify-apps-doc-writer.sweep.storeseo</string>'), 'label present');
assert.ok(plist.includes('<string>/bin/sh</string>'), 'runs via /bin/sh');
// shimPath and logPath now contain & from CONFIG_DIR, so we expect xmlEscape'd versions.
const escapedShimPath = xmlEscape(shimPath('storeseo'));
const escapedLogPath = xmlEscape(logPath('storeseo'));
assert.ok(plist.includes(`<string>${escapedShimPath}</string>`), 'points at the shim with escaped &');
assert.ok(plist.includes('<key>Hour</key><integer>3</integer>'), 'hour as integer');
assert.ok(plist.includes('<key>Minute</key><integer>0</integer>'), 'minute as integer');
assert.strictEqual(plist.split(`<string>${escapedLogPath}</string>`).length, 3, 'stdout+stderr both routed to the log with escaped &');
// Verify no bare & in XML string values.
assert.ok(!plist.match(/<string>[^<]*&(?!(?:amp|lt|gt);)[^<]*<\/string>/), 'no bare & in XML string values');

// shim: resolves the pointer, fails loudly when stale, cds to the docs repo,
// execs sweep.js with the baked node path and app key.
const shim = shimContent({ appKey: 'storeseo', docsRepo: '/repos/app', nodePath: '/usr/local/bin/node' });
assert.ok(shim.startsWith('#!/bin/sh'), 'sh shebang');
assert.ok(shim.includes(path.join(CONFIG_DIR, 'plugin-root')), 'reads the pointer file');
assert.ok(/open a Claude Code session/.test(shim), 'stale pointer → actionable message');
assert.ok(shim.includes("cd '/repos/app'"), 'runs from the docs repo with single-quoted docsRepo');
assert.ok(shim.includes('exec \'/usr/local/bin/node\' "$ROOT/scripts/sweep.js" --app "storeseo"'), 'execs sweep.js with single-quoted nodePath');

// shim: paths with special chars are properly shell-escaped.
const shimSpecial = shimContent({ appKey: 'storeseo', docsRepo: "/repos/my app's \"dir\"", nodePath: '/usr/bin/node\'s' });
assert.ok(shimSpecial.includes("cd '/repos/my app'\"'\"'s \"dir\"'"), 'single-quotes-escaped docsRepo');
assert.ok(shimSpecial.includes("exec '/usr/bin/node'\"'\"'s' \"$ROOT/scripts/sweep.js\" --app \"storeseo\""), 'single-quotes-escaped nodePath');

console.log('schedule-sweep.test.js OK');

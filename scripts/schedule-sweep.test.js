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
const { spawnSync } = require('child_process');
const { CONFIG_DIR, sweepPath, saveConfig } = require('./lib/config');
const { parseAt, plistContent, shimContent, label, plistPath, shimPath, logPath, shq, xmlEscape, assertSafeAppKey, assertDocsRepo } = require('./schedule-sweep');

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

// shim: a stale pointer must leave a *record*, not only a log line. Without
// one, sweep.json keeps its last-successful timestamp and the user hears
// nothing for two days, then hears only the generic "looks stuck" notice —
// never the sentence that says how to fix it.
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-run-'));
const shimFile = path.join(shimDir, 'runner.sh');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.rmSync(path.join(CONFIG_DIR, 'plugin-root'), { force: true });
fs.rmSync(sweepPath('storeseo'), { force: true });
fs.writeFileSync(shimFile, shimContent({ appKey: 'storeseo', docsRepo: shimDir, nodePath: process.execPath }));
const stale = spawnSync('/bin/sh', [shimFile], { encoding: 'utf8' });
assert.strictEqual(stale.status, 1, `shim exits 1 on a stale pointer (stderr: ${stale.stderr})`);
assert.match(stale.stderr, /open a Claude Code session/, 'still says how to fix it');
const staleRecord = JSON.parse(fs.readFileSync(sweepPath('storeseo'), 'utf8'));
assert.strictEqual(staleRecord.status, 'error');
assert.match(staleRecord.message, /plugin-root pointer/, 'the record carries the reason');
assert.ok(!Number.isNaN(Date.parse(staleRecord.at)), 'record timestamp is parsable');
fs.rmSync(sweepPath('storeseo'), { force: true });

// assertDocsRepo: installing from the wrong directory is the failure this
// feature cannot survive — a sweep that checks nothing reports clean forever.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-repo-'));
assert.throws(() => assertDocsRepo(repo, 'docs'), /No docs found/, 'empty dir rejected');
fs.mkdirSync(path.join(repo, 'docs', 'not-a-doc'), { recursive: true });
assert.throws(() => assertDocsRepo(repo, 'docs'), /No docs found/, 'docs/ without a manifest rejected');
fs.mkdirSync(path.join(repo, 'docs', 'a-feature'), { recursive: true });
fs.writeFileSync(path.join(repo, 'docs', 'a-feature', 'manifest.json'), '{}');
assertDocsRepo(repo, 'docs'); // doesn't throw

// A missing config must reach the user as its one-line message, not a stack
// trace — commands/docs-schedule.md shows this stderr verbatim.
if (process.platform === 'darwin') {
  const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'no-config-'));
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'schedule-sweep.js'), '--status'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: noConfig, USERPROFILE: noConfig },
  });
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /Run \/shopify-apps-doc-writer:docs-setup first/);
  assert.ok(!/\n\s+at /.test(cli.stderr), `no stack trace: ${cli.stderr}`);
}

// --status must show *why* a sweep failed; commands/docs-schedule.md routes
// the user off that reason, and it is the only place the shim's stale-pointer
// explanation is visible outside the log.
if (process.platform === 'darwin') {
  saveConfig('statustest', { store: 't.myshopify.com', appHandle: 'statustest' });
  fs.writeFileSync(
    sweepPath('statustest'),
    JSON.stringify({ at: '2026-08-13T03:00:00Z', status: 'error', message: 'plugin-root pointer missing or stale' })
  );
  const st = spawnSync(process.execPath, [path.join(__dirname, 'schedule-sweep.js'), '--status', '--app', 'statustest'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
  });
  assert.strictEqual(st.status, 0, `status exits 0 (stderr: ${st.stderr})`);
  assert.match(st.stdout, /plugin-root pointer missing or stale/, 'the reason is in the status output');
}

console.log('schedule-sweep.test.js OK');

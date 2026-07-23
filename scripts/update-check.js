#!/usr/bin/env node
'use strict';

/**
 * update-check.js — deterministic drift detector for /update-docs.
 *
 * Re-shoots the manifest into a temp dir (by shelling out to capture.js, which
 * stays the only screenshotter), then compares fresh vs committed screenshots
 * and index.md vs the recorded publishedHash. Emits a human report to stderr
 * and a machine-readable JSON report to stdout.
 *
 * Exit codes: 0 success (drift or not); 10 auth expired; 20 selector timeout
 * (UI changed — fix manifest); 1 other errors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, resolveAppKey } = require('./lib/config');
const {
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
  formatReport,
} = require('./lib/staleness');

const EXIT_AUTH = 10;
const EXIT_SELECTOR = 20;

/** Re-shoot by invoking capture.js so it remains the only screenshotter. */
function realCapture({ manifestPath, appKey, outDir }) {
  const res = spawnSync(
    'node',
    [path.join(__dirname, 'capture.js'), '--manifest', manifestPath, '--app', appKey, '--out-dir', outDir],
    { stdio: 'inherit' }
  );
  if (res.status === EXIT_AUTH) {
    const e = new Error('Session expired — run /docs-setup auth, then re-run.');
    e.exitCode = EXIT_AUTH;
    throw e;
  }
  if (res.status === EXIT_SELECTOR) {
    const e = new Error('Selector timeout — the UI has likely changed; update the manifest.');
    e.exitCode = EXIT_SELECTOR;
    throw e;
  }
  if (res.status !== 0) {
    const e = new Error(`capture.js failed (exit ${res.status}).`);
    e.exitCode = 1;
    throw e;
  }
}

function run({ manifestPath, appKey, capture = realCapture, tmpFactory }) {
  const docDir = path.dirname(manifestPath);
  const meta = JSON.parse(fs.readFileSync(path.join(docDir, 'meta.json'), 'utf8'));
  const publish = meta.publish || {};

  if (!publish.url) {
    return {
      slug: meta.slug,
      published: false,
      url: null,
      tmpDir: null,
      copy: null,
      screenshots: { changedCount: 0, total: 0, shots: [] },
      anyDrift: false,
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const shotIds = manifest.shots.map((s) => s.id);
  const makeTmp = tmpFactory || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'update-')));
  const tmpDir = makeTmp();

  capture({ manifestPath, appKey, outDir: tmpDir }); // before drift computation

  const copy = detectCopyDrift(path.join(docDir, 'index.md'), publish.publishedHash);
  const shots = classifyScreenshots(path.join(docDir, 'screenshots'), tmpDir, shotIds);
  return buildReport({ slug: meta.slug, url: publish.url, published: true, tmpDir, copy, shots });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error('Usage: node scripts/update-check.js --manifest docs/<slug>/manifest.json --app <key>');
    process.exit(1);
  }
  const manifestPath = path.resolve(args.manifest);
  const appKey = resolveAppKey(args.app);

  let report;
  try {
    report = run({ manifestPath, appKey });
  } catch (err) {
    if (err.exitCode) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err.stack || String(err));
    process.exit(1);
  }

  console.error(formatReport(report)); // human summary
  console.log(JSON.stringify(report)); // machine-readable for the command layer
  process.exit(0);
}

if (require.main === module) main();

module.exports = { run, realCapture };

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
  // capture.js prints progress to stdout via console.log; we need clean JSON on our stdout,
  // so route its stdout+stderr to our stderr (fd 2), keeping the contract intact.
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'capture.js'), '--manifest', manifestPath, '--app', appKey, '--out-dir', outDir],
    { stdio: ['ignore', 2, 2] }
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
    const cause = res.error ? ` — ${res.error.message}` : '';
    const e = new Error(`capture.js failed (exit ${res.status})${cause}.`);
    e.exitCode = 1;
    throw e;
  }
}

function run({ manifestPath, appKey, capture = realCapture, tmpFactory, sweep = false }) {
  const docDir = path.dirname(manifestPath);
  const meta = JSON.parse(fs.readFileSync(path.join(docDir, 'meta.json'), 'utf8'));
  const publish = meta.publish || {};

  // Single-doc mode is about refreshing *published* docs; the sweep checks
  // screenshot drift on drafts too, so it skips this short-circuit.
  if (!publish.url && !sweep) {
    return {
      slug: meta.slug,
      published: false,
      url: null,
      tmpDir: null,
      copy: null,
      screenshots: { changedCount: 0, skippedCount: 0, total: 0, shots: [] },
      anyDrift: false,
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // ponytail: temp dirs intentionally not cleaned up here; caller owns tmpDir cleanup.
  const makeTmp = tmpFactory || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'update-')));
  const tmpDir = makeTmp();

  try {
    capture({ manifestPath, appKey, outDir: tmpDir }); // before drift computation
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const copy =
    !sweep || publish.publishedHash
      ? detectCopyDrift(path.join(docDir, 'index.md'), publish.publishedHash)
      : null;
  const shots = classifyScreenshots(path.join(docDir, 'screenshots'), tmpDir, manifest.shots);
  return buildReport({
    slug: meta.slug,
    url: publish.url || null,
    published: Boolean(publish.url),
    tmpDir,
    copy,
    shots,
  });
}

/**
 * Sweep every doc dir under docsDir. Report-only: temp capture dirs are
 * deleted immediately after each comparison. A selector timeout in one doc
 * becomes that doc's `error` and the sweep continues; auth expiry (10)
 * aborts — every subsequent doc would fail identically.
 */
function runAll({ docsDir, appKey, capture = realCapture, tmpFactory }) {
  const docs = [];
  const skipped = [];
  const entries = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];

  for (const e of entries) {
    const dir = path.join(docsDir, e.name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      skipped.push({ dir: e.name, reason: 'no manifest.json' });
      continue;
    }
    if (!fs.existsSync(path.join(dir, 'meta.json'))) {
      skipped.push({ dir: e.name, reason: 'no meta.json' });
      continue;
    }

    let report;
    try {
      report = run({ manifestPath: path.join(dir, 'manifest.json'), appKey, capture, tmpFactory, sweep: true });
    } catch (err) {
      if (err.exitCode === 20) {
        docs.push({ slug: e.name, published: null, copy: null, screenshots: null, error: 'selector-timeout', anyDrift: false });
        continue;
      }
      throw err;
    }

    if (report.tmpDir) fs.rmSync(report.tmpDir, { recursive: true, force: true });
    docs.push({
      slug: report.slug || e.name,
      published: report.published,
      copy: report.copy,
      screenshots: report.screenshots,
      error: null,
      anyDrift: report.anyDrift,
    });
  }

  return {
    docs,
    skipped,
    checked: docs.length,
    anyDrift: docs.some((d) => d.anyDrift),
  };
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

module.exports = { run, runAll, realCapture };

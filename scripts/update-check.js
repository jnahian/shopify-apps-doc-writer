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
 * (UI changed — fix manifest); 30 bot challenge (re-run with --headed);
 * 1 other errors. In --all sweep mode, selector timeouts are per-doc report
 * entries, not exit 20.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, resolveAppKey, loadConfig } = require('./lib/config');
const {
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
  formatReport,
} = require('./lib/staleness');

const EXIT_AUTH = 10;
const EXIT_SELECTOR = 20;
const EXIT_CHALLENGE = 30;

/**
 * @typedef {Error & {exitCode?: number}} ExitError
 * @typedef {(opts: {manifestPath: string, appKey: string, outDir: string}) => void} CaptureFn
 */

/**
 * Re-shoot by invoking capture.js so it remains the only screenshotter.
 * @type {CaptureFn}
 */
function realCapture({ manifestPath, appKey, outDir }) {
  // capture.js prints progress to stdout via console.log; we need clean JSON on our stdout,
  // so route its stdout+stderr to our stderr (fd 2), keeping the contract intact.
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'capture.js'), '--manifest', manifestPath, '--app', appKey, '--out-dir', outDir],
    { stdio: ['ignore', 2, 2] }
  );
  if (res.status === EXIT_AUTH) {
    const e = /** @type {ExitError} */ (new Error('Session expired — run /docs-setup auth, then re-run.'));
    e.exitCode = EXIT_AUTH;
    throw e;
  }
  if (res.status === EXIT_CHALLENGE) {
    const e = /** @type {ExitError} */ (new Error('Bot challenge — the browser was interstitialed; re-run with capture --headed.'));
    e.exitCode = EXIT_CHALLENGE;
    throw e;
  }
  if (res.status === EXIT_SELECTOR) {
    const e = /** @type {ExitError} */ (new Error('Selector timeout — the UI has likely changed; update the manifest.'));
    e.exitCode = EXIT_SELECTOR;
    throw e;
  }
  if (res.status !== 0) {
    const cause = res.error ? ` — ${res.error.message}` : '';
    const e = /** @type {ExitError} */ (new Error(`capture.js failed (exit ${res.status})${cause}.`));
    e.exitCode = 1;
    throw e;
  }
}

/**
 * @param {{manifestPath: string, appKey: string, capture?: CaptureFn, tmpFactory?: () => string, sweep?: boolean}} opts
 */
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
  // Published-ness keys off meta.publish.url (is there anything to republish?);
  // build-site.js keys off meta.status. SKILL.md sets both at publish time, so
  // they agree unless meta.json was hand-edited.
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
 * deleted immediately after each comparison. Doc-local failures are contained:
 * missing/malformed files skip the doc, a selector timeout or capture crash
 * becomes that doc's `error`, and the sweep continues. Auth expiry (10) and a
 * bot challenge (30) abort — both are environment-level, so every subsequent
 * doc would fail identically.
 * @param {{docsDir: string, appKey: string, capture?: CaptureFn, tmpFactory?: () => string}} opts
 */
function runAll({ docsDir, appKey, capture = realCapture, tmpFactory }) {
  /**
   * Discriminated on `error`: a doc that failed capture has no comparison data.
   * @type {Array<{slug: string, published: null, copy: null, screenshots: null, error: 'selector-timeout'|'capture-failed', anyDrift: false}
   *   | {slug: string, published: boolean, copy: {changed: boolean}|null,
   *      screenshots: {changedCount: number, skippedCount: number, total: number, shots: object[]},
   *      error: null, anyDrift: boolean}>}
   */
  const docs = [];
  /** @type {Array<{dir: string, reason: string}>} */
  const skipped = [];
  const entries = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];

  for (const e of entries) {
    const dir = path.join(docsDir, e.name);
    /** @type {string|null} */
    let defect = null;
    for (const f of ['manifest.json', 'meta.json']) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) defect = `no ${f}`;
      else {
        try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { defect = `${f} is not valid JSON`; }
      }
      if (defect) break;
    }
    if (!defect && !fs.existsSync(path.join(dir, 'index.md'))) defect = 'no index.md';
    if (defect) {
      skipped.push({ dir: e.name, reason: defect });
      continue;
    }

    let report;
    try {
      report = run({ manifestPath: path.join(dir, 'manifest.json'), appKey, capture, tmpFactory, sweep: true });
    } catch (err) {
      // exitCode 10 (auth), 30 (bot challenge) and unexpected errors abort;
      // anything else from capture is doc-local and must not kill the sweep.
      if (err.exitCode === EXIT_AUTH || err.exitCode === EXIT_CHALLENGE || !err.exitCode) throw err;
      docs.push({
        slug: e.name,
        published: null,
        copy: null,
        screenshots: null,
        error: err.exitCode === EXIT_SELECTOR ? 'selector-timeout' : 'capture-failed',
        anyDrift: false,
      });
      continue;
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

/** @param {ReturnType<typeof runAll>} report */
function formatSweep(report) {
  const lines = [`Checked ${report.checked} doc(s)`];
  for (const d of report.docs) {
    if (d.error) {
      const hint = d.error === 'selector-timeout' ? ' — manifest needs updating (/write-docs)' : '';
      lines.push(`  ${d.slug}   ERROR: ${d.error}${hint}`);
      continue;
    }
    const parts = [];
    if (d.copy && d.copy.changed) parts.push('copy changed');
    if (d.screenshots.changedCount) parts.push(`${d.screenshots.changedCount}/${d.screenshots.total} shots changed`);
    if (d.screenshots.skippedCount) parts.push(`${d.screenshots.skippedCount} not compared`);
    lines.push(`  ${d.slug}${d.published ? '' : ' (draft)'}   ${parts.length ? parts.join(', ') : 'up to date'}`);
  }
  for (const s of report.skipped) lines.push(`  skipped ${s.dir}: ${s.reason}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Boolean(args.all) === Boolean(args.manifest)) {
    console.error(
      'Usage: node scripts/update-check.js --manifest docs/<slug>/manifest.json --app <key>\n' +
        '   or: node scripts/update-check.js --all --app <key>'
    );
    process.exit(1);
  }
  const appKey = resolveAppKey(/** @type {string|undefined} */ (args.app));

  /** @type {any} */
  let report;
  try {
    if (args.all) {
      const config = loadConfig(appKey);
      report = runAll({ docsDir: path.resolve(config.capture.outputDir), appKey });
    } else {
      report = run({ manifestPath: path.resolve(String(args.manifest)), appKey });
    }
  } catch (err) {
    if (err.exitCode) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err.stack || String(err));
    process.exit(1);
  }

  console.error(args.all ? formatSweep(report) : formatReport(report)); // human summary
  console.log(JSON.stringify(report)); // machine-readable for the command layer
  process.exit(0);
}

if (require.main === module) main();

module.exports = { run, runAll, realCapture };

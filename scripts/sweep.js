#!/usr/bin/env node
'use strict';

/**
 * sweep.js — unattended staleness-sweep runner for scheduled (launchd) runs.
 *
 * Spawns update-check.js --all (the same sweep /docs-check uses), classifies
 * the outcome, and overwrites ~/.config/shopify-apps-doc-writer/
 * <app-key>.sweep.json for the SessionStart hook to surface next session.
 * Latest state is the only state: a clean sweep clears a previous drifty one.
 *
 * Report-only by construction: update-check re-shoots to temp and deletes it;
 * this script adds no write paths beyond sweep.json. Progress goes to stderr,
 * which launchd routes to <app-key>.sweep.log. Always exits 0 once the app
 * key is known — the record is the report, even for failures.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, resolveAppKey, sweepPath, CONFIG_DIR } = require('./lib/config');

// update-check launches a browser per doc, so a real docs set legitimately
// runs for a while — but launchd will not start a second copy of a job that
// is still running, so one hung capture silently kills every future sweep.
// A generous ceiling, then the record says what happened the next morning.
const SWEEP_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * @typedef {{slug: string, copyChanged: boolean, shotsChanged: number, total: number, published: boolean|null}} StaleDoc
 * @typedef {{checked: number, stale: StaleDoc[], errors: Array<{slug: string, error: string}>, skipped: Array<{dir: string, reason: string}>}} SweepSummary
 * @typedef {{status: 'ok'|'drift'|'auth-expired'|'bot-challenge'|'error', message?: string, summary?: SweepSummary, raw?: object}} Outcome
 */

/**
 * Human-readable reason a spawn never produced an exit code.
 * @param {{code?: string, message: string}} [err] spawnSync's `error`
 * @returns {string}
 */
function describeSpawnError(err) {
  if (!err) return '';
  if (err.code === 'ETIMEDOUT') {
    return (
      `update-check timed out after ${SWEEP_TIMEOUT_MS / 60000} minutes and was killed — ` +
      'a capture is probably hung; the next scheduled run starts clean'
    );
  }
  return err.message;
}

/**
 * Classify a finished `update-check.js --all` run. Per-doc capture errors
 * (selector-timeout / capture-failed) count as drift: they are actionable
 * findings, not sweep failures.
 * @param {{exitCode: number|null, stdout: string, errorText?: string}} run
 * @returns {Outcome}
 */
function classifyOutcome({ exitCode, stdout, errorText }) {
  if (exitCode === 10) return { status: 'auth-expired' };
  if (exitCode === 30) return { status: 'bot-challenge' };
  if (exitCode !== 0) {
    return { status: 'error', message: (errorText || `update-check exited ${exitCode}`).trim() };
  }
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { status: 'error', message: 'update-check produced no parsable JSON' };
  }
  const stale = report.docs
    .filter((/** @type {any} */ d) => !d.error && d.anyDrift)
    .map((/** @type {any} */ d) => ({
      slug: d.slug,
      copyChanged: Boolean(d.copy && d.copy.changed),
      shotsChanged: d.screenshots.changedCount,
      total: d.screenshots.total,
      published: d.published,
    }));
  const errors = report.docs
    .filter((/** @type {any} */ d) => d.error)
    .map((/** @type {any} */ d) => ({ slug: d.slug, error: d.error }));
  const summary = { checked: report.checked, stale, errors, skipped: report.skipped };
  // Checking nothing is not a clean bill of health. install() bakes in the cwd
  // it ran from; point that at anything but the docs repo and every nightly
  // sweep would otherwise come back 'ok' — silent, forever.
  if (report.checked === 0) {
    return {
      status: 'error',
      message:
        'update-check found no docs to check — the schedule is pointing at a directory with no docs. ' +
        'Re-run /docs-schedule from your docs repo.',
      summary,
      raw: report,
    };
  }
  return { status: stale.length || errors.length ? 'drift' : 'ok', summary, raw: report };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // The shim always passes --app; resolveAppKey covers manual invocation.
  const appKey =
    typeof args.app === 'string' ? args.app : resolveAppKey(/** @type {string|undefined} */ (undefined));

  /** @type {Outcome} */
  let outcome;
  try {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'update-check.js'), '--all', '--app', appKey],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: SWEEP_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }
    );
    outcome = classifyOutcome({
      exitCode: res.status,
      stdout: res.stdout || '',
      errorText: describeSpawnError(res.error),
    });
  } catch (err) {
    // Even a crash leaves a record — a broken sweep must be visible, not absent.
    outcome = { status: 'error', message: err.message };
  }

  const record = { at: new Date().toISOString(), ...outcome };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(sweepPath(appKey), JSON.stringify(record, null, 2) + '\n');
  console.error(`sweep ${record.status}${record.summary ? ` — ${record.summary.stale.length} stale, ${record.summary.errors.length} errored` : ''}`);
}

if (require.main === module) main();

module.exports = { classifyOutcome, describeSpawnError, SWEEP_TIMEOUT_MS };

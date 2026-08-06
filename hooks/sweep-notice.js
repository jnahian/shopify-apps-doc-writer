'use strict';

/**
 * Session-start notices for scheduled staleness sweeps: read every
 * <app-key>.sweep.json under the config dir and produce at most one line per
 * app. Pure formatting, separated from the hook for testing. The notice
 * repeats each session until a sweep comes back clean — deliberate nagging
 * for a report-only signal; fixing the docs clears it naturally.
 */

const fs = require('fs');
const path = require('path');

// 2× the daily interval: an older record means the schedule stopped firing
// (stale plugin-root pointer, unloaded job, machine off) — say so instead of
// presenting stale results as current.
const STUCK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * @param {{appKey: string, record: any, logPath: string}} entry
 * @param {number} now epoch ms
 * @returns {string|null} one notice line, or null for silence
 */
function formatNotice({ appKey, record, logPath }, now) {
  const when = String(record.at).slice(0, 16).replace('T', ' ');
  const age = now - Date.parse(record.at);
  if (Number.isFinite(age) && age > STUCK_MS) {
    return (
      `[${appKey}] scheduled sweep looks stuck — last ran ${when}. ` +
      `Check it: node <plugin-root>/scripts/schedule-sweep.js --status --app ${appKey}`
    );
  }
  switch (record.status) {
    case 'auth-expired':
      return `[${appKey}] scheduled sweeps are blocked — auth expired; run /docs-setup auth.`;
    case 'bot-challenge':
      return `[${appKey}] last scheduled sweep (${when}) was bot-challenged; run /docs-check yourself (headed capture) to get a real result.`;
    case 'error':
      return `[${appKey}] last scheduled sweep (${when}) failed — see ${logPath}`;
    case 'drift': {
      const stale = record.summary.stale.map((/** @type {any} */ s) => s.slug);
      const errs = record.summary.errors.map((/** @type {any} */ e) => `${e.slug} (${e.error})`);
      const parts = [];
      if (stale.length) {
        parts.push(
          `found ${stale.length} stale doc(s): ${stale.join(', ')} — run /update-docs <slug>, or /docs-check for the full report + Slack draft`
        );
      }
      if (errs.length) parts.push(`capture errors: ${errs.join(', ')}`);
      return `[${appKey}] scheduled sweep (${when}) ${parts.join('; ')}.`;
    }
    default:
      return null; // 'ok', or an unknown status from a future version
  }
}

/**
 * @param {string} configDir
 * @param {number} now epoch ms
 * @returns {string[]}
 */
function collectNotices(configDir, now) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  let files;
  try {
    files = fs.readdirSync(configDir).filter((f) => f.endsWith('.sweep.json'));
  } catch {
    return lines; // config dir missing — sweeps never scheduled
  }
  for (const f of files) {
    const appKey = f.replace(/\.sweep\.json$/, '');
    try {
      const record = JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf8'));
      const line = formatNotice({ appKey, record, logPath: path.join(configDir, `${appKey}.sweep.log`) }, now);
      if (line) lines.push(line);
    } catch {
      /* corrupt record — sweep.js rewrites it next run; never break the hook */
    }
  }
  return lines;
}

module.exports = { formatNotice, collectNotices };

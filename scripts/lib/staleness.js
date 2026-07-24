'use strict';

/**
 * staleness.js — pure drift-detection logic for /update-docs.
 *
 * Compares the current local doc state against the state recorded at last
 * publish. Byte-level sensitivity: a screenshot that differs by one byte
 * counts as changed (no perceptual scoring). Hashes are sha256 hex of raw
 * file bytes, matching `shasum -a 256`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function detectCopyDrift(indexPath, publishedHash) {
  const currentHash = sha256File(indexPath);
  return { changed: currentHash !== publishedHash, currentHash, publishedHash };
}

/**
 * Shots come from the manifest; each maps to `<id>.png` in both dirs. Accepts
 * either shot objects or bare ids.
 *
 * A shot with `driftCheck: false` is never compared. Some shots contain
 * content nobody controls — third-party widgets that render intermittently,
 * host-app chrome — so their bytes differ between captures of an unchanged
 * feature. Comparing them would report drift that isn't there, so they are
 * re-shot but reported as skipped rather than silently counted as clean.
 */
function classifyScreenshots(committedDir, freshDir, shots) {
  return shots.map((shot) => {
    const id = typeof shot === 'string' ? shot : shot.id;
    const file = `${id}.png`;
    if (typeof shot === 'object' && shot.driftCheck === false) {
      return { file, changed: false, skipped: true };
    }
    const committed = path.join(committedDir, file);
    const fresh = path.join(freshDir, file);
    const hasCommitted = fs.existsSync(committed);
    const hasFresh = fs.existsSync(fresh);
    let changed;
    if (!hasCommitted || !hasFresh) {
      changed = true; // added or removed
    } else {
      changed = sha256File(committed) !== sha256File(fresh);
    }
    return { file, changed, skipped: false };
  });
}

function buildReport({ slug, url, published, tmpDir, copy, shots }) {
  const changedCount = shots.filter((s) => s.changed && !s.skipped).length;
  const skippedCount = shots.filter((s) => s.skipped).length;
  const anyDrift = Boolean((copy && copy.changed) || changedCount > 0);
  return {
    slug,
    published,
    url,
    tmpDir,
    copy,
    screenshots: { changedCount, skippedCount, total: shots.length, shots },
    anyDrift,
  };
}

function formatReport(report) {
  if (!report.published) {
    return `"${report.slug}" has not been published yet — nothing to compare against.`;
  }
  const { changedCount, skippedCount, total } = report.screenshots;
  const lines = [`Doc: ${report.slug}  (published → ${report.url})`];
  lines.push(`Copy:        ${report.copy.changed ? 'CHANGED since publish' : 'unchanged'}`);
  lines.push(
    `Screenshots: ${changedCount} of ${total} changed` +
      (skippedCount ? ` (${skippedCount} skipped)` : '')
  );
  for (const shot of report.screenshots.shots) {
    if (shot.skipped) lines.push(`  ${shot.file}   not compared (volatile)`);
    else if (shot.changed) lines.push(`  ${shot.file}   CHANGED`);
  }
  if (!report.anyDrift) lines.push('Up to date — nothing to do.');
  return lines.join('\n');
}

module.exports = {
  sha256File,
  detectCopyDrift,
  classifyScreenshots,
  buildReport,
  formatReport,
};

'use strict';

/**
 * republish-diff.js — exact comparison of the publish-time snapshot of an
 * external doc against its live text, for the clobber check in
 * /shopify-apps-doc-writer:update-docs.
 *
 * Both inputs are read-backs through the same MCP tool (the snapshot was
 * saved at publish time from the same fetch path), so md→Doc conversion
 * noise cancels out by construction — any hunk is a human edit. Only
 * trivial transport noise is normalized away: CRLF, trailing whitespace
 * per line, trailing blank lines at EOF. No fuzzy matching.
 *
 * CLI: node republish-diff.js <snapshotFile> <liveFile>
 * JSON {identical, hunks} on stdout, human rendering on stderr. Exit 0
 * whether or not hunks exist — diff presence is data, not an error.
 */

/** @typedef {{snapshotLine: number, liveLine: number, removed: string[], added: string[]}} Hunk */

/** @param {string} text */
function normalize(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line-based LCS diff, grouped into hunks of contiguous change.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Hunk[]}
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  /** @type {number[][]} */
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk|null} */
  let open = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (open === null) {
      open = { snapshotLine: i + 1, liveLine: j + 1, removed: [], added: [] };
      hunks.push(open);
    }
    if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
      open.removed.push(a[i]);
      i++;
    } else {
      open.added.push(b[j]);
      j++;
    }
  }
  return hunks;
}

/**
 * @param {string} snapshotText
 * @param {string} liveText
 */
function compare(snapshotText, liveText) {
  const hunks = diffLines(normalize(snapshotText), normalize(liveText));
  return { identical: hunks.length === 0, hunks };
}

/** @param {Hunk[]} hunks */
function formatHunks(hunks) {
  /** @type {string[]} */
  const lines = [];
  for (const hunk of hunks) {
    lines.push(`@ snapshot line ${hunk.snapshotLine} / live line ${hunk.liveLine}`);
    for (const line of hunk.removed) lines.push(`- ${line}`);
    for (const line of hunk.added) lines.push(`+ ${line}`);
  }
  return lines.join('\n');
}

module.exports = { compare, formatHunks };

if (require.main === module) {
  const fs = require('fs');
  const [snapshotFile, liveFile] = process.argv.slice(2);
  if (!snapshotFile || !liveFile) {
    console.error('usage: node republish-diff.js <snapshotFile> <liveFile>');
    process.exit(2);
  }
  const result = compare(
    fs.readFileSync(snapshotFile, 'utf8'),
    fs.readFileSync(liveFile, 'utf8')
  );
  if (!result.identical) console.error(formatHunks(result.hunks));
  console.log(JSON.stringify(result, null, 2));
}

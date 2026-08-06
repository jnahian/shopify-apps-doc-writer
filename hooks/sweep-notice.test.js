#!/usr/bin/env node
'use strict';

/** Self-check for session-start sweep notices. Run: node hooks/sweep-notice.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatNotice, collectNotices } = require('./sweep-notice');

const NOW = Date.parse('2026-08-13T09:00:00Z');
/** @param {object} record */
const notice = (record) => formatNotice({ appKey: 'storeseo', record, logPath: '/logs/storeseo.sweep.log' }, NOW);

// Fresh ok → silence.
assert.strictEqual(notice({ at: '2026-08-13T03:00:00Z', status: 'ok', summary: { checked: 3, stale: [], errors: [], skipped: [] } }), null);

// Drift → slugs listed, routed to /update-docs and /docs-check.
const driftResult = notice({
  at: '2026-08-13T03:00:00Z',
  status: 'drift',
  summary: {
    checked: 4,
    stale: [
      { slug: 'ai-seo', copyChanged: true, shotsChanged: 2, total: 5, published: true },
      { slug: 'img-opt', copyChanged: false, shotsChanged: 1, total: 4, published: false },
    ],
    errors: [{ slug: 'broken', error: 'selector-timeout' }],
    skipped: [],
  },
});
assert.ok(driftResult && driftResult.includes('2 stale doc(s): ai-seo, img-opt'), `slugs listed: ${driftResult}`);
assert.ok(driftResult && driftResult.includes('/update-docs') && driftResult.includes('/docs-check'), 'routes to both commands');
assert.ok(driftResult && driftResult.includes('broken (selector-timeout)'), 'per-doc capture errors surfaced');
assert.ok(driftResult && driftResult.includes('2026-08-13 03:00 UTC'), `displayed time is labeled UTC: ${driftResult}`);

// Environment failures → their documented remedies.
const authExpired = notice({ at: '2026-08-13T03:00:00Z', status: 'auth-expired' });
assert.ok(authExpired && /docs-setup auth/.test(authExpired));
const challenged = notice({ at: '2026-08-13T03:00:00Z', status: 'bot-challenge' });
assert.ok(challenged && /bot-challenged/.test(challenged) && /docs-check/.test(challenged) && !/manifest/.test(challenged), 'exit-30 contract: no manifest blame');
assert.ok(challenged && challenged.includes('2026-08-13 03:00 UTC'), `bot-challenge time is labeled UTC: ${challenged}`);
const errorResult = notice({ at: '2026-08-13T03:00:00Z', status: 'error', message: 'boom' });
assert.ok(errorResult && errorResult.includes('/logs/storeseo.sweep.log'), 'error points at the log');
assert.ok(errorResult && errorResult.includes('2026-08-13 03:00 UTC'), `error time is labeled UTC: ${errorResult}`);

// Stuck schedule: record older than 2 days wins over its own status.
const stuckResult = notice({ at: '2026-08-10T03:00:00Z', status: 'ok', summary: { checked: 3, stale: [], errors: [], skipped: [] } });
assert.ok(stuckResult && /stuck/.test(stuckResult) && /--status/.test(stuckResult), `stale record → stuck notice: ${stuckResult}`);
assert.ok(stuckResult && stuckResult.includes('2026-08-10 03:00 UTC'), `stuck-record time is labeled UTC: ${stuckResult}`);

// collectNotices: reads every *.sweep.json in a dir; no files → no notices.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-test-'));
assert.deepStrictEqual(collectNotices(dir, NOW), [], 'no sweep files → silence');
fs.writeFileSync(path.join(dir, 'a.sweep.json'), JSON.stringify({ at: '2026-08-13T03:00:00Z', status: 'auth-expired' }));
fs.writeFileSync(path.join(dir, 'b.sweep.json'), JSON.stringify({ at: '2026-08-13T03:00:00Z', status: 'ok', summary: { checked: 1, stale: [], errors: [], skipped: [] } }));
fs.writeFileSync(path.join(dir, 'a.json'), '{}'); // config file — not a sweep record
fs.writeFileSync(path.join(dir, 'c.sweep.json'), 'not json'); // corrupt → skipped, never throws
const lines = collectNotices(dir, NOW);
assert.strictEqual(lines.length, 1, 'one noteworthy record → one line');
assert.ok(lines[0].startsWith('[a]'), 'prefixed with the app key');
assert.deepStrictEqual(collectNotices(path.join(dir, 'missing'), NOW), [], 'missing dir → silence, no throw');

console.log('sweep-notice.test.js OK');

# Scheduled Staleness Sweeps (0.6.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily launchd-scheduled local run of the existing staleness sweep, persisted to a per-app `sweep.json`, surfaced as a one-line notice at the next Claude Code session start — no Claude session, no Slack, no publishing in the scheduled path.

**Architecture:** launchd runs a shim in `~/.config/shopify-apps-doc-writer/` that resolves the current plugin root from a pointer file (refreshed each session by the existing SessionStart hook) and runs `scripts/sweep.js`, which wraps `update-check.js --all`, classifies the outcome, and overwrites `<app-key>.sweep.json`. The hook reads all `*.sweep.json` files and prints notices. A new `/docs-schedule` command orchestrates install/uninstall/status via `scripts/schedule-sweep.js`.

**Tech Stack:** Plain Node (CommonJS, `'use strict'`, JSDoc types under strict `checkJs`), plain-`assert` test scripts auto-discovered by `node --test`, macOS launchd (`launchctl bootstrap/bootout/print/kickstart`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-scheduled-sweeps-design.md` — read it first.

## Global Constraints

- **TDD is mandatory for JS** (CLAUDE.md): failing test first, watch it fail, then implement. `npm test` and `npm run typecheck` must both pass before every commit.
- Strict `checkJs` covers `scripts/**/*.js` **and** `hooks/**/*.js` — every new function needs JSDoc types or `tsc` fails.
- Tests must sandbox `HOME`/`USERPROFILE` **before** requiring `scripts/lib/config.js` (its `CONFIG_DIR` is computed at require time) — copy the pattern at the top of `scripts/lib/config.test.js`.
- macOS-only: `schedule-sweep.js` must refuse on `process.platform !== 'darwin'` with the exact message `Scheduled sweeps are macOS-only in 0.6.0 (launchd). Linux cron is deferred.`
- Report-only: the scheduled path writes **only** `~/.config/shopify-apps-doc-writer/<app-key>.sweep.json` and `<app-key>.sweep.log`. It never publishes, never touches `docs/`, never sends Slack.
- The SessionStart hook must **always exit 0** and never block session start — all new hook work wrapped in try/catch.
- Version ships as exactly **0.6.0** in both `.claude-plugin/plugin.json` and `package.json`.
- launchd label: `com.shopify-apps-doc-writer.sweep.<app-key>`. Default schedule: daily at `03:00`.

---

### Task 1: `scripts/sweep.js` — classify and persist the unattended sweep

**Files:**
- Modify: `scripts/lib/config.js` (add `sweepPath`)
- Modify: `scripts/lib/config.test.js` (cover `sweepPath`)
- Create: `scripts/sweep.js`
- Create: `scripts/sweep.test.js`

**Interfaces:**
- Consumes: `update-check.js --all --app <key>` CLI contract — JSON report on stdout `{ docs, skipped, checked, anyDrift }` where each `docs[]` entry is either `{slug, error: 'selector-timeout'|'capture-failed', ...}` or `{slug, published, copy: {changed}|null, screenshots: {changedCount, skippedCount, total, shots}, error: null, anyDrift}`; exit codes 0 / 10 (auth) / 30 (bot challenge) / 1.
- Consumes: `resolveAppKey`, `parseArgs`, `CONFIG_DIR` from `scripts/lib/config.js`.
- Produces: `sweepPath(appKey)` → `~/.config/shopify-apps-doc-writer/<appKey>.sweep.json` (exported from `config.js`).
- Produces: `classifyOutcome({exitCode, stdout, errorText})` → `{status, message?, summary?, raw?}` where `status` is `'ok'|'drift'|'auth-expired'|'bot-challenge'|'error'` and `summary` is `{checked, stale: Array<{slug, copyChanged, shotsChanged, total, published}>, errors: Array<{slug, error}>, skipped: Array<{dir, reason}>}` (exported from `sweep.js`).
- Produces: the on-disk **SweepRecord** shape `{at: ISO-8601 string, status, message?, summary?, raw?}` — Task 3's notice formatter reads exactly this.

- [ ] **Step 1: Write the failing tests**

Add to the end of `scripts/lib/config.test.js` (before the final `console.log` if one exists, otherwise at the end):

```js
// sweepPath: sibling of configPath/authPath, one record per app.
const { sweepPath } = require('./config');
assert.strictEqual(
  sweepPath('storeseo'),
  path.join(CONFIG_DIR, 'storeseo.sweep.json'),
  'sweepPath lives in CONFIG_DIR'
);
```

Create `scripts/sweep.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for the unattended sweep runner. Run: node scripts/sweep.test.js */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox HOME before requiring anything that derives CONFIG_DIR from it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const assert = require('assert');
const { spawnSync } = require('child_process');
const { saveConfig, sweepPath } = require('./lib/config');
const { classifyOutcome } = require('./sweep');

// --- classifyOutcome: environment-level exits map to their own statuses ---
assert.deepStrictEqual(classifyOutcome({ exitCode: 10, stdout: '' }), { status: 'auth-expired' });
assert.deepStrictEqual(classifyOutcome({ exitCode: 30, stdout: '' }), { status: 'bot-challenge' });

// Other nonzero exits → error, carrying whatever text we have.
assert.deepStrictEqual(
  classifyOutcome({ exitCode: 1, stdout: '', errorText: 'boom' }),
  { status: 'error', message: 'boom' }
);
assert.deepStrictEqual(
  classifyOutcome({ exitCode: 7, stdout: '' }),
  { status: 'error', message: 'update-check exited 7' }
);

// Exit 0 but stdout is not JSON → error, not a crash.
assert.strictEqual(classifyOutcome({ exitCode: 0, stdout: 'garbage' }).status, 'error');

// Clean report → ok, with an empty-but-present summary.
const clean = {
  docs: [
    { slug: 'a', published: true, copy: { changed: false }, screenshots: { changedCount: 0, skippedCount: 0, total: 3, shots: [] }, error: null, anyDrift: false },
  ],
  skipped: [],
  checked: 1,
  anyDrift: false,
};
const okOut = classifyOutcome({ exitCode: 0, stdout: JSON.stringify(clean) });
assert.strictEqual(okOut.status, 'ok');
assert.deepStrictEqual(okOut.summary, { checked: 1, stale: [], errors: [], skipped: [] });
assert.deepStrictEqual(okOut.raw, clean, 'raw report kept for /docs-check reuse');

// Drift and per-doc errors → drift, with the notice-ready summary.
const drifty = {
  docs: [
    { slug: 'ai-seo', published: true, copy: { changed: true }, screenshots: { changedCount: 2, skippedCount: 0, total: 5, shots: [] }, error: null, anyDrift: true },
    { slug: 'img-opt', published: false, copy: null, screenshots: { changedCount: 1, skippedCount: 1, total: 4, shots: [] }, error: null, anyDrift: true },
    { slug: 'broken', published: null, copy: null, screenshots: null, error: 'selector-timeout', anyDrift: false },
    { slug: 'fine', published: true, copy: { changed: false }, screenshots: { changedCount: 0, skippedCount: 0, total: 2, shots: [] }, error: null, anyDrift: false },
  ],
  skipped: [{ dir: 'not-a-doc', reason: 'no manifest.json' }],
  checked: 4,
  anyDrift: true,
};
const driftOut = classifyOutcome({ exitCode: 0, stdout: JSON.stringify(drifty) });
assert.strictEqual(driftOut.status, 'drift');
assert.deepStrictEqual(driftOut.summary.stale, [
  { slug: 'ai-seo', copyChanged: true, shotsChanged: 2, total: 5, published: true },
  { slug: 'img-opt', copyChanged: false, shotsChanged: 1, total: 4, published: false },
]);
assert.deepStrictEqual(driftOut.summary.errors, [{ slug: 'broken', error: 'selector-timeout' }]);
assert.deepStrictEqual(driftOut.summary.skipped, [{ dir: 'not-a-doc', reason: 'no manifest.json' }]);

// Per-doc errors alone (no stale docs) are still noteworthy → drift.
const errOnly = { docs: [{ slug: 'broken', published: null, copy: null, screenshots: null, error: 'capture-failed', anyDrift: false }], skipped: [], checked: 1, anyDrift: false };
assert.strictEqual(classifyOutcome({ exitCode: 0, stdout: JSON.stringify(errOnly) }).status, 'drift');

// --- CLI integration: no docs dir → checked 0 → ok record written to sweep.json ---
// update-check's runAll returns {docs: [], checked: 0} for a missing docs dir,
// so this exercises the full spawn → classify → persist path with no browser.
saveConfig('teststore', { store: 't.myshopify.com', appHandle: 'teststore' });
const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-repo-'));
const res = spawnSync(process.execPath, [path.join(__dirname, 'sweep.js'), '--app', 'teststore'], {
  cwd: emptyRepo,
  env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
  encoding: 'utf8',
});
assert.strictEqual(res.status, 0, `sweep.js exits 0 (stderr: ${res.stderr})`);
const record = JSON.parse(fs.readFileSync(sweepPath('teststore'), 'utf8'));
assert.strictEqual(record.status, 'ok');
assert.strictEqual(record.summary.checked, 0);
assert.ok(!Number.isNaN(Date.parse(record.at)), 'at is a parsable timestamp');

console.log('sweep.test.js OK');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/sweep.test.js`
Expected: FAIL — `Cannot find module './sweep'`.

Run: `node --test scripts/lib/config.test.js`
Expected: FAIL — `sweepPath` is not exported.

- [ ] **Step 3: Implement**

Add to `scripts/lib/config.js`, directly after `authPath`:

```js
/** Latest scheduled-sweep result for an app (written by scripts/sweep.js). @param {string} appKey */
function sweepPath(appKey) {
  return path.join(CONFIG_DIR, `${appKey}.sweep.json`);
}
```

and add `sweepPath,` to its `module.exports`.

Create `scripts/sweep.js`:

```js
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

/**
 * @typedef {{slug: string, copyChanged: boolean, shotsChanged: number, total: number, published: boolean|null}} StaleDoc
 * @typedef {{checked: number, stale: StaleDoc[], errors: Array<{slug: string, error: string}>, skipped: Array<{dir: string, reason: string}>}} SweepSummary
 * @typedef {{status: 'ok'|'drift'|'auth-expired'|'bot-challenge'|'error', message?: string, summary?: SweepSummary, raw?: object}} Outcome
 */

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
      { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    outcome = classifyOutcome({
      exitCode: res.status,
      stdout: res.stdout || '',
      errorText: res.error ? res.error.message : '',
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

module.exports = { classifyOutcome };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/sweep.test.js scripts/lib/config.test.js`
Expected: both PASS.

Run: `npm test && npm run typecheck`
Expected: all suites pass, `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep.js scripts/sweep.test.js scripts/lib/config.js scripts/lib/config.test.js
git commit -m "feat(sweep): unattended sweep runner — classify update-check --all into sweep.json"
```

---

### Task 2: `scripts/schedule-sweep.js` — launchd install/uninstall/status

**Files:**
- Create: `scripts/schedule-sweep.js`
- Create: `scripts/schedule-sweep.test.js`

**Interfaces:**
- Consumes: `parseArgs`, `resolveAppKey`, `sweepPath`, `CONFIG_DIR` from `scripts/lib/config.js`; `scripts/sweep.js` as the shim's target (path only).
- Produces (exported for tests): `parseAt(at)` → `{hour, minute}` (throws on invalid); `plistContent({appKey, hour, minute})` → XML string; `shimContent({appKey, docsRepo, nodePath})` → sh script string; `label(appKey)`, `plistPath(appKey)`, `shimPath(appKey)`, `logPath(appKey)`.
- Produces (CLI, used by `/docs-schedule` in Task 4): `--install --app <key> [--at HH:MM]` (docs repo = cwd), `--uninstall --app <key>`, `--status --app <key>`.
- Produces (on disk): shim at `CONFIG_DIR/<key>.sweep-runner.sh` reading the pointer file `CONFIG_DIR/plugin-root` — Task 3's hook must write that exact path.

- [ ] **Step 1: Write the failing test**

Create `scripts/schedule-sweep.test.js`:

```js
#!/usr/bin/env node
'use strict';

/** Self-check for launchd plist/shim generation. Run: node scripts/schedule-sweep.test.js */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox HOME before requiring — CONFIG_DIR and plistPath derive from it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const assert = require('assert');
const { CONFIG_DIR } = require('./lib/config');
const { parseAt, plistContent, shimContent, label, plistPath, shimPath, logPath } = require('./schedule-sweep');

// parseAt: 24h HH:MM, strict.
assert.deepStrictEqual(parseAt('03:00'), { hour: 3, minute: 0 });
assert.deepStrictEqual(parseAt('23:59'), { hour: 23, minute: 59 });
assert.deepStrictEqual(parseAt('9:30'), { hour: 9, minute: 30 }, 'single-digit hour allowed');
for (const bad of ['24:00', '12:60', '12', 'noon', '12:5', '']) {
  assert.throws(() => parseAt(bad), /HH:MM/, `rejects "${bad}"`);
}

// Paths: per-app, stable, derived from the app key.
assert.strictEqual(label('storeseo'), 'com.shopify-apps-doc-writer.sweep.storeseo');
assert.strictEqual(plistPath('storeseo'), path.join(tmp, 'Library', 'LaunchAgents', 'com.shopify-apps-doc-writer.sweep.storeseo.plist'));
assert.strictEqual(shimPath('storeseo'), path.join(CONFIG_DIR, 'storeseo.sweep-runner.sh'));
assert.strictEqual(logPath('storeseo'), path.join(CONFIG_DIR, 'storeseo.sweep.log'));

// plist: label, shim via /bin/sh, calendar interval, both stdio → the log.
const plist = plistContent({ appKey: 'storeseo', hour: 3, minute: 0 });
assert.ok(plist.includes('<string>com.shopify-apps-doc-writer.sweep.storeseo</string>'), 'label present');
assert.ok(plist.includes('<string>/bin/sh</string>'), 'runs via /bin/sh');
assert.ok(plist.includes(`<string>${shimPath('storeseo')}</string>`), 'points at the shim');
assert.ok(plist.includes('<key>Hour</key><integer>3</integer>'), 'hour as integer');
assert.ok(plist.includes('<key>Minute</key><integer>0</integer>'), 'minute as integer');
assert.strictEqual(plist.split(`<string>${logPath('storeseo')}</string>`).length, 3, 'stdout+stderr both routed to the log');

// shim: resolves the pointer, fails loudly when stale, cds to the docs repo,
// execs sweep.js with the baked node path and app key.
const shim = shimContent({ appKey: 'storeseo', docsRepo: '/repos/app', nodePath: '/usr/local/bin/node' });
assert.ok(shim.startsWith('#!/bin/sh'), 'sh shebang');
assert.ok(shim.includes(path.join(CONFIG_DIR, 'plugin-root')), 'reads the pointer file');
assert.ok(/open a Claude Code session/.test(shim), 'stale pointer → actionable message');
assert.ok(shim.includes('cd "/repos/app"'), 'runs from the docs repo');
assert.ok(shim.includes('exec "/usr/local/bin/node" "$ROOT/scripts/sweep.js" --app "storeseo"'), 'execs sweep.js from the CURRENT plugin root');

console.log('schedule-sweep.test.js OK');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/schedule-sweep.test.js`
Expected: FAIL — `Cannot find module './schedule-sweep'`.

- [ ] **Step 3: Implement**

Create `scripts/schedule-sweep.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * schedule-sweep.js — install/uninstall/status for the daily staleness sweep
 * (macOS launchd only in 0.6.0).
 *
 * The plist does NOT point into the plugin: installed plugins live under a
 * version-numbered cache path that changes on every update. It runs a shim in
 * CONFIG_DIR instead, which re-resolves the current plugin root from the
 * `plugin-root` pointer file that hooks/ensure-deps.js refreshes each
 * session. Baked into the shim at install time: the docs-repo path (cwd),
 * the app key, and the absolute node path (launchd's PATH is nearly empty).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, resolveAppKey, sweepPath, CONFIG_DIR } = require('./lib/config');

/** @param {string} appKey */
function label(appKey) {
  return `com.shopify-apps-doc-writer.sweep.${appKey}`;
}
/** @param {string} appKey */
function plistPath(appKey) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(appKey)}.plist`);
}
/** @param {string} appKey */
function shimPath(appKey) {
  return path.join(CONFIG_DIR, `${appKey}.sweep-runner.sh`);
}
/** @param {string} appKey */
function logPath(appKey) {
  return path.join(CONFIG_DIR, `${appKey}.sweep.log`);
}

/**
 * @param {string} at "HH:MM", 24-hour
 * @returns {{hour: number, minute: number}}
 */
function parseAt(at) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new Error(`--at must be HH:MM (24-hour), got "${at}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** @param {{appKey: string, hour: number, minute: number}} opts */
function plistContent({ appKey, hour, minute }) {
  // StartCalendarInterval: launchd runs a missed interval on wake (laptop
  // asleep overnight still sweeps); intervals missed while powered off skip.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(appKey)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${shimPath(appKey)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${logPath(appKey)}</string>
  <key>StandardErrorPath</key><string>${logPath(appKey)}</string>
</dict>
</plist>
`;
}

/** @param {{appKey: string, docsRepo: string, nodePath: string}} opts */
function shimContent({ appKey, docsRepo, nodePath }) {
  const pointer = path.join(CONFIG_DIR, 'plugin-root');
  return `#!/bin/sh
# Generated by shopify-apps-doc-writer /docs-schedule — do not edit.
ROOT=$(cat "${pointer}" 2>/dev/null)
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "plugin-root pointer missing or stale (${pointer}) — open a Claude Code session to refresh it, then this sweep recovers on its own" >&2
  exit 1
fi
cd "${docsRepo}" || exit 1
exec "${nodePath}" "$ROOT/scripts/sweep.js" --app "${appKey}"
`;
}

/** @returns {number} */
function uid() {
  return process.getuid ? process.getuid() : 0;
}

/** @param {{appKey: string, at: string, docsRepo: string}} opts */
function install({ appKey, at, docsRepo }) {
  const { hour, minute } = parseAt(at);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(plistPath(appKey)), { recursive: true });
  fs.writeFileSync(shimPath(appKey), shimContent({ appKey, docsRepo, nodePath: process.execPath }), { mode: 0o755 });
  fs.writeFileSync(plistPath(appKey), plistContent({ appKey, hour, minute }));
  // Replace any loaded copy: one schedule per app key.
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${label(appKey)}`], { stdio: 'ignore' });
  const res = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(appKey)], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${res.status}): ${res.stderr || res.stdout || ''}`.trim());
  }
  console.log(`Scheduled daily sweep for "${appKey}" at ${at} (docs repo: ${docsRepo}).`);
  console.log(`plist: ${plistPath(appKey)}\nshim:  ${shimPath(appKey)}\nlog:   ${logPath(appKey)}`);
}

/** @param {string} appKey */
function uninstall(appKey) {
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${label(appKey)}`], { stdio: 'ignore' });
  // Remove the record too, so session notices stop.
  for (const f of [plistPath(appKey), shimPath(appKey), sweepPath(appKey), logPath(appKey)]) {
    fs.rmSync(f, { force: true });
  }
  console.log(`Removed the scheduled sweep for "${appKey}".`);
}

/** @param {string} appKey */
function status(appKey) {
  const loaded = spawnSync('launchctl', ['print', `gui/${uid()}/${label(appKey)}`], { stdio: 'ignore' }).status === 0;
  console.log(`plist:  ${fs.existsSync(plistPath(appKey)) ? plistPath(appKey) : 'not installed'}`);
  console.log(`loaded: ${loaded}`);
  if (fs.existsSync(sweepPath(appKey))) {
    const record = JSON.parse(fs.readFileSync(sweepPath(appKey), 'utf8'));
    console.log(`last sweep: ${record.at} — ${record.status}`);
  } else {
    console.log('last sweep: never ran');
  }
  console.log(`log: ${logPath(appKey)}`);
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('Scheduled sweeps are macOS-only in 0.6.0 (launchd). Linux cron is deferred.');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const modes = ['install', 'uninstall', 'status'].filter((m) => args[m]);
  if (modes.length !== 1) {
    console.error(
      'Usage: node scripts/schedule-sweep.js --install --app <key> [--at HH:MM]   (run from the docs repo)\n' +
        '   or: node scripts/schedule-sweep.js --uninstall --app <key>\n' +
        '   or: node scripts/schedule-sweep.js --status --app <key>'
    );
    process.exit(1);
  }
  const appKey = resolveAppKey(/** @type {string|undefined} */ (typeof args.app === 'string' ? args.app : undefined));
  try {
    if (args.install) install({ appKey, at: typeof args.at === 'string' ? args.at : '03:00', docsRepo: process.cwd() });
    else if (args.uninstall) uninstall(appKey);
    else status(appKey);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseAt, plistContent, shimContent, label, plistPath, shimPath, logPath };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/schedule-sweep.test.js`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: all suites pass, `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add scripts/schedule-sweep.js scripts/schedule-sweep.test.js
git commit -m "feat(schedule): launchd install/uninstall/status for the daily sweep"
```

---

### Task 3: SessionStart hook — pointer file + sweep notices

**Files:**
- Create: `hooks/sweep-notice.js`
- Create: `hooks/sweep-notice.test.js`
- Modify: `hooks/ensure-deps.js`

**Interfaces:**
- Consumes: the SweepRecord shape from Task 1 (`{at, status, message?, summary?}`); `CONFIG_DIR` from `scripts/lib/config.js`; sweep files named `<appKey>.sweep.json`, logs `<appKey>.sweep.log` (Task 2's naming).
- Produces: `formatNotice({appKey, record, logPath}, now)` → `string|null`; `collectNotices(configDir, now)` → `string[]` (both exported from `hooks/sweep-notice.js`).
- Produces: `CONFIG_DIR/plugin-root` — one line, the current plugin root, rewritten every session start; Task 2's shim depends on it.

- [ ] **Step 1: Write the failing test**

Create `hooks/sweep-notice.test.js`:

```js
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
const drift = notice({
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
assert.ok(drift.includes('2 stale doc(s): ai-seo, img-opt'), `slugs listed: ${drift}`);
assert.ok(drift.includes('/update-docs') && drift.includes('/docs-check'), 'routes to both commands');
assert.ok(drift.includes('broken (selector-timeout)'), 'per-doc capture errors surfaced');

// Environment failures → their documented remedies.
assert.ok(/docs-setup auth/.test(notice({ at: '2026-08-13T03:00:00Z', status: 'auth-expired' })));
const challenged = notice({ at: '2026-08-13T03:00:00Z', status: 'bot-challenge' });
assert.ok(/bot-challenged/.test(challenged) && /docs-check/.test(challenged) && !/manifest/.test(challenged), 'exit-30 contract: no manifest blame');
assert.ok(notice({ at: '2026-08-13T03:00:00Z', status: 'error', message: 'boom' }).includes('/logs/storeseo.sweep.log'), 'error points at the log');

// Stuck schedule: record older than 2 days wins over its own status.
const stuck = notice({ at: '2026-08-10T03:00:00Z', status: 'ok', summary: { checked: 3, stale: [], errors: [], skipped: [] } });
assert.ok(/stuck/.test(stuck) && /--status/.test(stuck), `stale record → stuck notice: ${stuck}`);

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test hooks/sweep-notice.test.js`
Expected: FAIL — `Cannot find module './sweep-notice'`.

- [ ] **Step 3: Implement `hooks/sweep-notice.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test hooks/sweep-notice.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into `hooks/ensure-deps.js`**

In `hooks/ensure-deps.js`, insert between `const root = ...` (line 29) and the "Already installed?" block (line 31) — before the early `process.exit(0)`, which currently ends the common path:

```js
// Scheduled-sweep support (0.6.0): keep the plugin-root pointer fresh so the
// launchd shim survives version-numbered plugin-path changes, and surface the
// latest sweep results as session context. Best-effort — never break startup.
try {
  const { CONFIG_DIR } = require('../scripts/lib/config');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'plugin-root'), root + '\n');
  for (const line of require('./sweep-notice').collectNotices(CONFIG_DIR, Date.now())) {
    console.log(line);
  }
} catch {
  /* hook must always exit 0 with no drama */
}
```

Update the file's top doc comment: append one sentence — `Also refreshes the plugin-root pointer for scheduled sweeps and prints any sweep notices (see hooks/sweep-notice.js).`

- [ ] **Step 6: Verify the hook end-to-end and run the full suite**

```bash
node hooks/ensure-deps.js; echo "exit: $?"
cat ~/.config/shopify-apps-doc-writer/plugin-root
```

Expected: exit 0; the pointer file contains this repo's absolute path (no `CLAUDE_PLUGIN_ROOT` set, so it falls back to the repo root). No notice lines unless a real `*.sweep.json` exists.

Run: `npm test && npm run typecheck`
Expected: all suites pass, `tsc` silent.

- [ ] **Step 7: Commit**

```bash
git add hooks/sweep-notice.js hooks/sweep-notice.test.js hooks/ensure-deps.js
git commit -m "feat(hooks): plugin-root pointer + sweep notices at session start"
```

---

### Task 4: `/docs-schedule` command

**Files:**
- Create: `commands/docs-schedule.md`

**Interfaces:**
- Consumes: `schedule-sweep.js`'s CLI (Task 2) — `--install/--uninstall/--status`, `--app`, `--at`; docs repo = cwd at install time.
- Produces: the user-facing `/docs-schedule [off|status]` command.

- [ ] **Step 1: Write the command file**

Create `commands/docs-schedule.md`:

```markdown
---
description: Schedule a daily background staleness sweep (macOS) — results surface as a notice at your next session
argument-hint: "[off|status] [--app <key>] [--at HH:MM]"
---

Manage the scheduled staleness sweep. The sweep is the same deterministic
check `/docs-check` runs (`update-check.js --all`), executed daily by launchd
with no Claude session; it only **reports** — results land in
`~/.config/shopify-apps-doc-writer/<app-key>.sweep.json` and show up as a
one-line notice when you next start a session. Nothing is ever published or
sent to Slack unattended; you act on a notice by running `/update-docs
<slug>` or `/docs-check` yourself.

macOS only (launchd). On other platforms the script refuses with a clear
message — tell the user Linux cron support is deferred.

`<plugin-root>` below is the directory holding `.claude-plugin/`.

## No argument → install (or replace)

1. **Confirm the docs repo.** The schedule bakes in the *current directory*
   as the docs repo. Verify cwd contains the app's docs (the `docs/` dir, or
   whatever `capture.outputDir` is configured as). If it doesn't look like
   the docs repo, stop and ask the user to `cd` there and re-run.
2. **Resolve the app key** (`--app`, or the single existing config — same
   rule as every other command).
3. **Confirm before writing.** This writes a LaunchAgent plist and a runner
   shim on the user's machine — a plain confirmation, not one of the three
   hard gates (it is local and reversible). Show exactly:
   - schedule: daily at `<HH:MM>` (default `03:00`; `--at` overrides — ask
     if the user wants a different time)
   - docs repo: `<cwd>`
   - files: `~/Library/LaunchAgents/com.shopify-apps-doc-writer.sweep.<key>.plist`
     and `~/.config/shopify-apps-doc-writer/<key>.sweep-runner.sh`
4. On yes:

   ```bash
   node <plugin-root>/scripts/schedule-sweep.js --install --app <key> --at <HH:MM>
   ```

   Then verify: run `--status` and show the user the output. Mention that
   re-running `/docs-schedule` any time replaces the schedule (one per app),
   and `/docs-schedule off` removes it.

## `off` → uninstall

```bash
node <plugin-root>/scripts/schedule-sweep.js --uninstall --app <key>
```

Removes the launchd job, plist, shim, the sweep record, and its log —
session notices stop immediately.

## `status`

```bash
node <plugin-root>/scripts/schedule-sweep.js --status --app <key>
```

Show the output as-is: whether the job is installed and loaded, the last
sweep result, and the log path. If the last sweep is `auth-expired`, route to
`/docs-setup auth`; if `drift`, route to `/update-docs <slug>` /
`/docs-check`.

## Notes

- The sweep runs `capture.js` under the hood — the read-only guarantee and
  the exit-code contract (10 auth / 30 bot challenge) apply unchanged. Both
  outcomes surface in the next-session notice with their usual remedies.
- The shim resolves the plugin's current install path from
  `~/.config/shopify-apps-doc-writer/plugin-root`, refreshed every session —
  a plugin update doesn't break the schedule as long as a session has run
  since. A schedule whose record goes stale (>2 days) is reported as stuck
  by the session notice.
```

- [ ] **Step 2: Verify consistency (markdown has no runner)**

Read the file once more against Task 2's CLI flags and Task 3's notice wording — flags, paths, and remedies must match exactly. Check `commands/docs-check.md` still reads correctly alongside it (no changes expected there).

- [ ] **Step 3: Commit**

```bash
git add commands/docs-schedule.md
git commit -m "feat(commands): /docs-schedule — install/inspect/remove the daily sweep"
```

---

### Task 5: Docs, version bump, and manual launchd verification

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md`
- Modify: `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `package.json`

- [ ] **Step 1: README**

In the command list near the top (after the `/docs-check` line, currently line 17):

```
/docs-schedule         daily background sweep (launchd) → notice at your next session
```

In the repo-structure listing (line ~92), extend the `commands/` line to include `· /docs-schedule`, and after the `scripts/update-check.js` line add:

```
scripts/sweep.js                     unattended sweep runner for /docs-schedule (launchd)
scripts/schedule-sweep.js            install/uninstall/status of the launchd job (macOS)
```

Remove "scheduled sweeps" from any deferred/roadmap prose if mentioned; add one short paragraph near the `/docs-check` prose:

```markdown
`/docs-schedule` (macOS) runs that same sweep daily in the background via
launchd — no Claude session involved. It only reports: results are saved
locally and surface as a one-line notice at your next session start. Nothing
publishes and nothing posts to Slack unattended; the draft-only Slack path
still happens through `/docs-check`, with you present.
```

- [ ] **Step 2: SPEC.md**

Replace the §13 `### 0.6 — Scheduled staleness sweeps` body with:

```markdown
### 0.6 — Scheduled staleness sweeps — SHIPPED as 0.6.0
Fixed daily schedule (not release-triggered), macOS launchd, fully local:
a shim + plugin-root pointer file survive version-numbered plugin updates;
`scripts/sweep.js` wraps `update-check.js --all` and persists a classified
record; the SessionStart hook surfaces it as a notice. Slack stays
human-gated via `/docs-check`. See
`docs/superpowers/specs/2026-08-07-scheduled-sweeps-design.md`. 0.4
(annotation) and 0.5 (re-publish diffing) remain queued.
```

In §10 (Scripts), after the `scripts/capture.js` entry, add:

```markdown
### `scripts/sweep.js` / `scripts/schedule-sweep.js` (0.6.0)
Unattended daily staleness sweep: `schedule-sweep.js` manages the launchd
job (macOS), `sweep.js` runs `update-check.js --all` and persists
`<app-key>.sweep.json` for the SessionStart notice. Report-only.
```

- [ ] **Step 3: CHANGELOG + version bump**

Set `"version": "0.6.0"` in **both** `.claude-plugin/plugin.json` and `package.json`. Add to `CHANGELOG.md` above the 0.3.0 entry:

```markdown
## [0.6.0] - 2026-08-07

### Added

- `/docs-schedule` — a daily background staleness sweep on macOS (launchd),
  fully local and report-only. Results surface as a one-line notice at your
  next session start: stale docs route to `/update-docs`, auth expiry to
  `/docs-setup auth`, bot challenges to a headed `/docs-check`. Nothing
  publishes and nothing posts to Slack unattended. Backed by
  `scripts/sweep.js` and `scripts/schedule-sweep.js`; the schedule survives
  plugin updates via a plugin-root pointer the session-start hook refreshes.

(0.4 annotation pipeline and 0.5 re-publish diffing remain queued; the
version number tracks the roadmap item, not release order.)
```

- [ ] **Step 4: Full suite**

Run: `npm test && npm run typecheck`
Expected: all suites pass, `tsc` silent.

- [ ] **Step 5: Manual launchd verification (the untested boundary)**

The `launchctl` calls have no unit tests by design — verify them once by hand, from the dogfood docs repo (this repo):

```bash
node scripts/schedule-sweep.js --install --app <key> --at 03:00
node scripts/schedule-sweep.js --status --app <key>          # expect: loaded: true, last sweep: never ran
launchctl kickstart gui/$(id -u)/com.shopify-apps-doc-writer.sweep.<key>   # force an immediate run
# wait for capture to finish (watch the log), then:
cat ~/.config/shopify-apps-doc-writer/<key>.sweep.json        # expect a record with a fresh `at`
node hooks/ensure-deps.js                                     # expect: notice line iff status warrants one
node scripts/schedule-sweep.js --uninstall --app <key>
node scripts/schedule-sweep.js --status --app <key>          # expect: not installed, loaded: false
```

Record the outcome in the commit message body (what ran, what the record said). If the kickstarted sweep hits a bot challenge (exit 30 → `status: "bot-challenge"`), that is itself a **successful** verification of the unattended failure path — note it and move on.

- [ ] **Step 6: Commit**

```bash
git add README.md SPEC.md CHANGELOG.md .claude-plugin/plugin.json package.json
git commit -m "chore(release): 0.6.0 — scheduled staleness sweeps"
```

---

## Out of scope (from the spec — do not add)

Release-triggered sweeps, Slack auto-send/webhooks, Linux/Windows scheduling, auto-repairing a stale pointer from the sweep itself, multi-machine coordination, and any change to `/docs-check`'s own flow.

#!/usr/bin/env node
'use strict';

/**
 * SessionStart bootstrap: make sure the plugin's npm deps (Playwright) are
 * installed. node_modules is gitignored and not part of the plugin source, so
 * a fresh install has none — this runs `npm install` on first session and
 * again after a plugin update wipes it. Normally a no-op.
 *
 * Design:
 *  - Exit immediately if Playwright already resolves (the common path).
 *  - Otherwise install in the BACKGROUND (detached) and return at once, so
 *    session start never blocks on a ~minute-long npm install. Capture is a
 *    later step in the workflow, so the install has finished by the time it
 *    runs; if not, capture.js already fails gracefully with an install hint.
 *  - A lock guards against two parallel sessions installing at once.
 *
 * Always exits 0 — a bootstrap must never break session start.
 *
 * Note: this installs npm deps only. Playwright's browser binaries
 * (`npx playwright install chromium`) are a separate ~150MB download; the
 * capture scripts print that hint if the browser is missing.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

// Already installed? Nothing to do — this is every session after the first.
try {
  require.resolve('playwright', { paths: [root] });
  process.exit(0);
} catch {
  /* not installed — fall through */
}

// Don't let two sessions install concurrently (corrupts node_modules).
const lock = path.join(root, 'node_modules', '.plugin-installing');
try {
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) {
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
} catch {
  /* best-effort lock; proceed regardless */
}

console.log(
  'shopify-apps-doc-writer: installing Playwright in the background (first run) — ' +
    'screenshot capture will be ready shortly.'
);

// shell:true so `npm` resolves to npm.cmd on Windows.
const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  shell: true,
});
child.on('error', () => {}); // e.g. npm not on PATH — capture.js will surface it
child.unref();

process.exit(0);

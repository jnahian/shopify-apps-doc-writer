#!/usr/bin/env node
'use strict';

/**
 * setup-auth.js — Phase 1 of /docs-setup.
 *
 * Spawns a real Chrome at the store's admin with a CDP port and attaches to
 * it (Playwright-launched browsers are rejected by Shopify's login), waits
 * for the user to log in manually (2FA/captcha are theirs to solve — this
 * script never touches credentials), persists storageState to the auth path,
 * then takes a headless verification screenshot of the app page with the
 * saved session so wrong-store / app-not-installed / broken-session problems
 * surface at setup time.
 *
 * Usage:
 *   node scripts/setup-auth.js --app <key> [--store <x.myshopify.com>] [--handle <app-handle>]
 *
 * --store/--handle create or update the config; without them the existing
 * config for --app is used.
 *
 * Exit codes: 0 success · 10 login not completed / session invalid · 1 other.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  CONFIG_DIR,
  authPath,
  configPath,
  loadConfig,
  saveConfig,
  parseArgs,
  resolveAppKey,
} = require('./lib/config');
const { adminUrl, appUrl, isAdminUrl, ADMIN_SHELL_SELECTOR } = require('./lib/shopify');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Shopify's identity page silently no-ops the login submit in any browser
 * Playwright *launches* (automation flags / navigator.webdriver) — bundled
 * Chromium and channel:'chrome' alike. So we spawn a real Chrome ourselves
 * with a debugging port and attach over CDP: no automation flags, login
 * behaves normally. Once authenticated, the cookies drive headless system
 * Chrome fine — capture and the verification shot both use channel:'chrome'.
 */
const CDP_PORT = 9333;

const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
};

// Dedicated profile: Chrome 136+ refuses --remote-debugging-port on the
// default profile, and this keeps our session out of the user's own Chrome.
const PROFILE_DIR = path.join(os.homedir(), '.claude-browser-profiles', 'shopify-apps-doc-writer-chrome');

function findChrome() {
  for (const candidate of CHROME_PATHS[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function probeCdp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error('Playwright is not installed. From the plugin root run:\n  npm install');
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appKey = resolveAppKey(args.app);

  if (args.store || args.handle) {
    saveConfig(appKey, {
      ...(args.store ? { store: args.store } : {}),
      ...(args.handle ? { appHandle: args.handle } : {}),
    });
  }
  if (!fs.existsSync(configPath(appKey))) {
    console.error(
      `No config for "${appKey}". Provide --store and --handle on first run, e.g.\n` +
        `  node scripts/setup-auth.js --app ${appKey} --store ${appKey}-dev.myshopify.com --handle ${appKey}`
    );
    process.exit(1);
  }
  const config = loadConfig(appKey);
  const statePath = authPath(appKey);

  const { chromium } = loadPlaywright();

  // --- Headed login ---------------------------------------------------------
  console.log(`Opening ${adminUrl(config.store, '/admin')} in a browser window.`);
  console.log('Log into the Shopify admin there (2FA/captcha included).');
  console.log('This script only waits for the admin to load — it never sees your credentials.');

  let child = null;
  if (await probeCdp()) {
    console.log(`Reusing the browser already listening on CDP port ${CDP_PORT}.`);
  } else {
    const chrome = findChrome();
    if (!chrome) {
      console.error(
        'Google Chrome not found. Login needs real Chrome — Shopify rejects ' +
          'browsers launched by automation tooling, including bundled Chromium.'
      );
      process.exit(1);
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    child = spawn(
      chrome,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        adminUrl(config.store, '/admin'),
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    if (!(await waitFor(probeCdp, 20000))) {
      console.error(`Chrome did not open CDP port ${CDP_PORT} within 20s.`);
      process.exit(1);
    }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0]; // the real profile's context — holds the login cookies
  const quitChrome = () => {
    if (!child) return;
    try {
      process.kill(child.pid);
    } catch {
      /* already gone */
    }
  };

  const loggedIn = await waitFor(
    async () => {
      for (const page of context.pages()) {
        if (!isAdminUrl(page.url())) continue;
        const shell = await page
          .locator(ADMIN_SHELL_SELECTOR)
          .first()
          .isVisible()
          .catch(() => false);
        if (shell) return true;
      }
      return false;
    },
    LOGIN_TIMEOUT_MS,
    2000
  );

  if (!loggedIn) {
    console.error(
      `Login was not completed within ${LOGIN_TIMEOUT_MS / 60000} minutes ` +
        '(or the window was closed) — re-run to try again.'
    );
    await browser.close().catch(() => {});
    quitChrome();
    process.exit(10);
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  await context.storageState({ path: statePath });
  fs.chmodSync(statePath, 0o600);
  saveConfig(appKey, { storageState: statePath });
  await browser.close().catch(() => {});
  quitChrome();
  console.log(`Auth state saved: ${statePath}`);

  // --- Headless verification shot ------------------------------------------
  // System Chrome (channel:'chrome'), same as capture — no bundled-Chromium
  // download needed. Loading the saved session, no login page involved.
  console.log('Verifying the saved session headlessly…');
  const verifyBrowser = await chromium.launch({ headless: true, channel: 'chrome' });
  const verifyContext = await verifyBrowser.newContext({
    viewport: config.viewport,
    storageState: statePath,
  });
  const verifyPage = await verifyContext.newPage();
  const target = appUrl(config.store, config.appHandle);
  await verifyPage.goto(target, { waitUntil: 'domcontentloaded' });
  await verifyPage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await verifyPage.waitForTimeout(2000);

  const verifyShot = path.join(CONFIG_DIR, `${appKey}.verify.png`);
  await verifyPage.screenshot({ path: verifyShot });
  const finalUrl = verifyPage.url();
  await verifyBrowser.close();

  console.log(`Verification screenshot: ${verifyShot}`);
  if (!isAdminUrl(finalUrl)) {
    console.error(
      `Verification landed on ${finalUrl} — the saved session did not authenticate headlessly.\n` +
        'Re-run this script (/docs-setup auth).'
    );
    process.exit(10);
  }
  console.log(
    `Session verified for ${target}.\n` +
      'Open the screenshot and confirm it shows your app inside the Shopify admin.'
  );
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});

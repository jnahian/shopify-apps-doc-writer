#!/usr/bin/env node
'use strict';

/**
 * setup-auth.js — Phase 1 of /docs-setup.
 *
 * Launches a HEADED browser at the store's admin, waits for the user to log
 * in manually (2FA/captcha are theirs to solve — this script never touches
 * credentials), persists Playwright storageState to the per-user auth path,
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
const path = require('path');
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

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error(
      'Playwright is not installed. From the plugin root run:\n' +
        '  npm install\n  npx playwright install chromium'
    );
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

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (err) {
    console.error(
      `Could not launch Chromium: ${err.message}\n` +
        'If the browser is missing, run: npx playwright install chromium'
    );
    process.exit(1);
  }
  const context = await browser.newContext({ viewport: config.viewport });
  const page = await context.newPage();
  await page.goto(adminUrl(config.store, '/admin'), { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isAdminUrl(url)) {
      const shell = await page
        .locator(ADMIN_SHELL_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false);
      if (shell) {
        loggedIn = true;
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    console.error(`Login was not completed within ${LOGIN_TIMEOUT_MS / 60000} minutes.`);
    await browser.close();
    process.exit(10);
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  await context.storageState({ path: statePath });
  fs.chmodSync(statePath, 0o600);
  saveConfig(appKey, { storageState: statePath });
  await browser.close();
  console.log(`Auth state saved: ${statePath}`);

  // --- Headless verification shot ------------------------------------------
  console.log('Verifying the saved session headlessly…');
  const verifyBrowser = await chromium.launch({ headless: true });
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

#!/usr/bin/env node
'use strict';

/**
 * capture.js — executes a shot manifest deterministically.
 *
 * Usage:
 *   node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--headed]
 *
 * Per shot: navigate → run actions → apply wait strategy → screenshot
 * (viewport for crop "full-admin"; app-iframe bounding box for "iframe")
 * → save docs/<slug>/screenshots/<id>.png next to the manifest.
 *
 * Exit codes:
 *   0  success
 *   10 auth expired — run /docs-setup auth
 *   20 selector timeout — UI likely changed; the manifest needs updating
 *   1  anything else (including read-only-guarantee refusal)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, parseArgs, resolveAppKey } = require('./lib/config');
const {
  APP_IFRAME_SELECTOR,
  adminUrl,
  isLoginUrl,
  findInPageOrIframe,
  applyWaitStrategy,
} = require('./lib/shopify');

const EXIT_AUTH = 10;
const EXIT_SELECTOR = 20;

const ACTION_TIMEOUT_MS = 15000;
const WAITFOR_TIMEOUT_MS = 30000;

/**
 * Read-only guarantee: refuse manifests whose actions target elements that
 * look like they submit or destroy something, unless the shot explicitly
 * sets "mutation": true (which the SKILL.md forbids Claude from doing in v1).
 */
const DESTRUCTIVE_PATTERN =
  /\b(delete|remove|destroy|discard|uninstall|disconnect|revoke|reset|save|submit|publish|apply|confirm|approve|activate|deactivate|pay|charge|subscribe|upgrade|install)\b/i;

function actionTargets(action) {
  if (typeof action.click === 'string') return [action.click];
  if (action.fill) return [action.fill.selector];
  if (action.select) return [action.select.selector];
  if (typeof action.hover === 'string') return [action.hover];
  if (action.press && action.press.selector) return [action.press.selector];
  return [];
}

function checkReadOnly(manifest) {
  const violations = [];
  for (const shot of manifest.shots) {
    if (shot.mutation === true) continue; // explicit opt-out (forbidden for Claude in v1)
    for (const action of shot.actions || []) {
      for (const target of actionTargets(action)) {
        if (target && DESTRUCTIVE_PATTERN.test(target)) {
          violations.push(`  shot "${shot.id}": ${JSON.stringify(action)}`);
        }
      }
    }
  }
  if (violations.length) {
    console.error(
      'Refusing to run: these actions look destructive (read-only guarantee):\n' +
        violations.join('\n') +
        '\nIf a selector merely *matches* a destructive word without mutating anything,' +
        ' set "mutation": true on that shot to override — human review required.'
    );
    process.exit(1);
  }
}

function validateManifest(manifest, manifestPath) {
  const fail = (msg) => {
    console.error(`Invalid manifest ${manifestPath}: ${msg}`);
    process.exit(1);
  };
  if (!manifest.app) fail('missing "app"');
  if (!manifest.feature) fail('missing "feature"');
  if (!Array.isArray(manifest.shots) || manifest.shots.length === 0) fail('missing "shots"');
  const seen = new Set();
  for (const shot of manifest.shots) {
    if (!shot.id) fail('a shot is missing "id"');
    if (seen.has(shot.id)) fail(`duplicate shot id "${shot.id}"`);
    seen.add(shot.id);
    if (!shot.path) fail(`shot "${shot.id}" is missing "path"`);
    if (!shot.waitFor) fail(`shot "${shot.id}" is missing "waitFor" (required — skeleton loaders photobomb otherwise)`);
    if (shot.crop && !['full-admin', 'iframe'].includes(shot.crop)) {
      fail(`shot "${shot.id}" has unknown crop "${shot.crop}"`);
    }
  }
}

async function runAction(page, action) {
  const resolve = async (selector) => {
    const loc = await findInPageOrIframe(page, selector, ACTION_TIMEOUT_MS);
    if (!loc) {
      const err = new Error(`action selector never became visible: ${selector}`);
      err.code = 'SELECTOR_TIMEOUT';
      throw err;
    }
    return loc;
  };

  if (typeof action.click === 'string') {
    await (await resolve(action.click)).click();
  } else if (action.fill) {
    await (await resolve(action.fill.selector)).fill(String(action.fill.value));
  } else if (action.select) {
    await (await resolve(action.select.selector)).selectOption(String(action.select.value));
  } else if (typeof action.hover === 'string') {
    await (await resolve(action.hover)).hover();
  } else if (action.press) {
    if (action.press.selector) {
      await (await resolve(action.press.selector)).press(action.press.key);
    } else {
      await page.keyboard.press(action.press.key);
    }
  } else if (typeof action.waitMs === 'number') {
    await page.waitForTimeout(action.waitMs);
  } else {
    throw new Error(`Unknown action: ${JSON.stringify(action)}`);
  }
}

async function captureShot(page, config, shot, outDir) {
  await page.goto(adminUrl(config.store, shot.path), { waitUntil: 'domcontentloaded' });
  if (isLoginUrl(page.url())) {
    const err = new Error('redirected to login');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  for (const action of shot.actions || []) {
    await runAction(page, action);
  }

  await applyWaitStrategy(page, shot, WAITFOR_TIMEOUT_MS);

  // Auth can also expire mid-run after in-page redirects.
  if (isLoginUrl(page.url())) {
    const err = new Error('redirected to login');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  const file = path.join(outDir, `${shot.id}.png`);
  if (shot.crop === 'iframe') {
    const frameEl = page.locator(APP_IFRAME_SELECTOR).first();
    if (!(await frameEl.isVisible().catch(() => false))) {
      const err = new Error(
        `shot "${shot.id}": crop is "iframe" but no app iframe (${APP_IFRAME_SELECTOR}) is visible`
      );
      err.code = 'SELECTOR_TIMEOUT';
      throw err;
    }
    await frameEl.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file }); // viewport = full-admin context shot
  }
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error(
      'Usage: node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--headed]'
    );
    process.exit(1);
  }

  const manifestPath = path.resolve(args.manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest, manifestPath);
  checkReadOnly(manifest);

  const appKey = resolveAppKey(args.app || manifest.app);
  const config = loadConfig(appKey);

  if (!fs.existsSync(config.storageState)) {
    console.error(`No auth state at ${config.storageState}. Run /docs-setup auth.`);
    process.exit(EXIT_AUTH);
  }

  let shots = manifest.shots;
  if (args.only) {
    shots = shots.filter((s) => s.id === args.only);
    if (shots.length === 0) {
      console.error(
        `No shot with id "${args.only}". Available: ${manifest.shots.map((s) => s.id).join(', ')}`
      );
      process.exit(1);
    }
  }

  const outDir = path.join(path.dirname(manifestPath), 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is not installed. From the plugin root run:\n  npm install');
    process.exit(1);
  }

  let browser;
  try {
    // Drive the system Google Chrome (channel:'chrome') — the same browser
    // login uses — so no bundled-Chromium download is needed. Capture loads an
    // already-authenticated session, so the login-page automation detection
    // that forces CDP in setup-auth doesn't apply; output is identical to
    // bundled Chromium (validated 2026-07-24).
    browser = await chromium.launch({
      channel: 'chrome',
      headless: args.headed ? false : config.capture.headless !== false,
    });
  } catch (err) {
    console.error(
      `Could not launch Google Chrome: ${err.message}\n` +
        'Capture uses your installed Google Chrome — install it from https://www.google.com/chrome/.'
    );
    process.exit(1);
  }

  const viewport = manifest.viewport || config.viewport;
  const context = await browser.newContext({
    viewport,
    storageState: config.storageState,
    locale: config.locale,
  });
  const page = await context.newPage();

  console.log(
    `Capturing ${shots.length} shot(s) for "${manifest.feature}" ` +
      `(${config.store}, viewport ${viewport.width}x${viewport.height})`
  );

  try {
    for (const shot of shots) {
      process.stdout.write(`  ${shot.id} … `);
      const file = await captureShot(page, config, shot, outDir);
      console.log(`saved ${path.relative(process.cwd(), file)}`);
    }
  } catch (err) {
    console.log('failed');
    if (err.code === 'AUTH_EXPIRED') {
      console.error('Session expired — run /docs-setup auth, then re-run this capture.');
      await browser.close();
      process.exit(EXIT_AUTH);
    }
    if (err.code === 'SELECTOR_TIMEOUT') {
      console.error(
        `${err.message}\nThe UI has likely changed — update the manifest (and re-approve it), then re-run.` +
          `\nRe-shoot just this shot with: --only <shot-id>`
      );
      await browser.close();
      process.exit(EXIT_SELECTOR);
    }
    console.error(err.stack || String(err));
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});

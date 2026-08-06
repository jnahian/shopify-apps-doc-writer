#!/usr/bin/env node
'use strict';

/**
 * capture.js — executes a shot manifest deterministically.
 *
 * Usage:
 *   node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--out-dir <dir>] [--browser chrome|msedge|chromium|firefox|webkit] [--headed]
 *
 * Per shot: navigate → run actions → apply wait strategy → inject
 * annotations (if any) → screenshot
 * (viewport for crop "full-admin"; app-iframe bounding box for "iframe")
 * → save docs/<slug>/screenshots/<id>.png next to the manifest.
 *
 * Exit codes:
 *   0  success
 *   10 auth expired — run /docs-setup auth
 *   20 selector timeout — UI likely changed; the manifest needs updating
 *   30 bot challenge — the browser was interstitialed; re-run with --headed
 *   1  anything else (including read-only-guarantee refusal)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, parseArgs, resolveAppKey } = require('./lib/config');
const {
  APP_IFRAME_SELECTOR,
  adminUrl,
  isLoginUrl,
  detectBotChallenge,
  findInPageOrIframe,
  applyWaitStrategy,
} = require('./lib/shopify');
const { validateAnnotations, resolveGeometry, overlayHtml } = require('./lib/annotate');

const EXIT_AUTH = 10;
const EXIT_SELECTOR = 20;
const EXIT_CHALLENGE = 30;

/**
 * @typedef {import('playwright').Page} Page
 * @typedef {Error & {code?: string}} CodedError
 * @typedef {{
 *   click?: string, fill?: {selector: string, value: string|number},
 *   select?: {selector: string, value: string|number}, hover?: string,
 *   press?: {selector?: string, key: string}, waitMs?: number,
 * }} Action
 * @typedef {{
 *   id: string, path: string, waitFor: string, waitStrategy?: string,
 *   crop?: string, actions?: Action[], mutation?: boolean, driftCheck?: boolean,
 *   annotate?: import('./lib/annotate').Annotation[],
 * }} Shot
 * @typedef {{
 *   app: string, feature: string, browser?: string,
 *   viewport?: {width: number, height: number}, shots: Shot[],
 * }} Manifest
 */

const ACTION_TIMEOUT_MS = 15000;
const WAITFOR_TIMEOUT_MS = 30000;

// Settle budget. The floor matters: third-party widgets can mount seconds
// after networkidle, and without it the poll finds two matching frames during
// the quiet gap *before* they appear and declares the page settled too early.
const SETTLE_MIN_MS = 3000;
const SETTLE_POLL_MS = 1000;
const SETTLE_MAX_TRIES = 10;

/**
 * Read-only guarantee: refuse manifests whose actions target elements that
 * look like they submit or destroy something, unless the shot explicitly
 * sets "mutation": true (which the SKILL.md forbids Claude from doing in v1).
 */
const DESTRUCTIVE_PATTERN =
  /\b(delete|remove|destroy|discard|uninstall|disconnect|revoke|reset|save|submit|publish|apply|confirm|approve|activate|deactivate|pay|charge|subscribe|upgrade|install)\b/i;

/** @param {Action} action */
function actionTargets(action) {
  if (typeof action.click === 'string') return [action.click];
  if (action.fill) return [action.fill.selector];
  if (action.select) return [action.select.selector];
  if (typeof action.hover === 'string') return [action.hover];
  if (action.press && action.press.selector) return [action.press.selector];
  return [];
}

/** @param {Manifest} manifest */
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

/**
 * @param {Manifest} manifest
 * @param {string} manifestPath
 */
function validateManifest(manifest, manifestPath) {
  /** @param {string} msg */
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
    const annErr = validateAnnotations(shot.annotate);
    if (annErr) fail(`shot "${shot.id}": ${annErr}`);
  }
}

/**
 * @param {Page} page
 * @param {Action} action
 */
async function runAction(page, action) {
  /** @param {string} selector */
  const resolve = async (selector) => {
    const loc = await findInPageOrIframe(page, selector, ACTION_TIMEOUT_MS);
    if (!loc) {
      const err = /** @type {CodedError} */ (
        new Error(`action selector never became visible: ${selector}`)
      );
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

const OVERLAY_ID = '__sadw_annotations';

/**
 * Resolve each annotation's target to a live bounding box and inject the
 * overlay into the top document. Runs before settle() so the overlay is part
 * of the render that must stabilise — determinism comes from the same
 * mechanism as the rest of the shot. Fixed-position children clip into
 * `crop: "iframe"` shots too, because element screenshots clip the full page
 * render.
 * @param {Page} page
 * @param {Shot} shot
 */
async function applyAnnotations(page, shot) {
  /** @type {import('./lib/annotate').Geometry[]} */
  const geometries = [];
  for (const ann of shot.annotate || []) {
    const loc = await findInPageOrIframe(page, ann.target, ACTION_TIMEOUT_MS);
    const box = loc && (await loc.boundingBox());
    if (!box) {
      const err = /** @type {CodedError} */ (
        new Error(`annotation target never became visible: ${ann.target}`)
      );
      err.code = 'SELECTOR_TIMEOUT';
      throw err;
    }
    geometries.push(resolveGeometry(box, ann));
  }
  await page.evaluate(
    ({ id, html }) => {
      const prev = document.getElementById(id);
      if (prev) prev.remove();
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      el.innerHTML = html;
      document.body.appendChild(el);
    },
    { id: OVERLAY_ID, html: overlayHtml(geometries) }
  );
}

/**
 * @param {Page} page
 * @param {import('./lib/config').AppConfig} config
 * @param {Shot} shot
 * @param {string} outDir
 */
async function captureShot(page, config, shot, outDir) {
  await page.goto(adminUrl(config.store, shot.path), { waitUntil: 'domcontentloaded' });
  if (isLoginUrl(page.url())) {
    const err = /** @type {CodedError} */ (new Error('redirected to login'));
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  for (const action of shot.actions || []) {
    await runAction(page, action);
  }

  await applyWaitStrategy(page, shot, WAITFOR_TIMEOUT_MS);

  // Auth can also expire mid-run after in-page redirects.
  if (isLoginUrl(page.url())) {
    const err = /** @type {CodedError} */ (new Error('redirected to login'));
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  if (shot.annotate && shot.annotate.length) {
    await applyAnnotations(page, shot);
  }

  const file = path.join(outDir, `${shot.id}.png`);

  /** @type {() => Promise<Buffer>} */
  let shoot;
  if (shot.crop === 'iframe') {
    const frameEl = page.locator(APP_IFRAME_SELECTOR).first();
    if (!(await frameEl.isVisible().catch(() => false))) {
      const err = /** @type {CodedError} */ (
        new Error(
          `shot "${shot.id}": crop is "iframe" but no app iframe (${APP_IFRAME_SELECTOR}) is visible`
        )
      );
      err.code = 'SELECTOR_TIMEOUT';
      throw err;
    }
    shoot = () => frameEl.screenshot({ animations: 'disabled' });
  } else {
    // viewport = full-admin context shot
    shoot = () => page.screenshot({ animations: 'disabled' });
  }

  const buf = await settle(page, shoot);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * Re-shoot until two consecutive captures are byte-identical.
 *
 * `waitFor` returns once the page is navigable, but third-party widgets and
 * transition indicators keep repainting for a few seconds after that — enough
 * to make every re-capture of an unchanged UI differ, which would make
 * /update-docs report drift that isn't there. Polling until the bytes stop
 * moving makes re-capture reproducible without hardcoding per-app selectors
 * or a blanket sleep on every shot.
 * @param {Page} page
 * @param {() => Promise<Buffer>} shoot
 */
async function settle(page, shoot) {
  await page.waitForTimeout(SETTLE_MIN_MS);
  let prev = await shoot();
  for (let i = 1; i < SETTLE_MAX_TRIES; i++) {
    await page.waitForTimeout(SETTLE_POLL_MS);
    const next = await shoot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  // ponytail: give up after the budget and return the last frame — a shot that
  // never settles (video, live counter) still produces a usable screenshot.
  return prev;
}

/** @type {Record<string, {engine: 'chromium'|'firefox'|'webkit', channel?: string}>} */
const BROWSERS = {
  chrome: { engine: 'chromium', channel: 'chrome' },
  msedge: { engine: 'chromium', channel: 'msedge' },
  chromium: { engine: 'chromium' },
  firefox: { engine: 'firefox' },
  webkit: { engine: 'webkit' },
};

/**
 * Precedence: --browser CLI > manifest.browser > config.capture.browser > 'chrome'.
 * @param {{browser?: string|true}} args
 * @param {{browser?: string}} manifest
 * @param {{capture?: {browser?: string}}} config
 */
function resolveBrowser(args, manifest, config) {
  const name = /** @type {string} */ (
    args.browser || manifest.browser || (config.capture && config.capture.browser) || 'chrome'
  );
  const spec = BROWSERS[name];
  if (!spec) {
    throw new Error(
      `Unknown browser "${name}". Valid values: ${Object.keys(BROWSERS).join(', ')}`
    );
  }
  return { name, ...spec };
}

/**
 * @param {{"out-dir"?: string|true}} args
 * @param {string} manifestPath
 */
function resolveOutDir(args, manifestPath) {
  if (args['out-dir']) return path.resolve(String(args['out-dir']));
  return path.join(path.dirname(manifestPath), 'screenshots');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error(
      'Usage: node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--out-dir <dir>] [--browser chrome|msedge|chromium|firefox|webkit] [--headed]'
    );
    process.exit(1);
  }

  const manifestPath = path.resolve(String(args.manifest));
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  /** @type {Manifest} */
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest, manifestPath);
  checkReadOnly(manifest);

  const appKey = resolveAppKey(/** @type {string} */ (args.app) || manifest.app);
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

  const outDir = resolveOutDir(args, manifestPath);
  fs.mkdirSync(outDir, { recursive: true });

  /** @type {typeof import('playwright')} */
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.error('Playwright is not installed. From the plugin root run:\n  npm install');
    process.exit(1);
  }

  let spec;
  try {
    spec = resolveBrowser(args, manifest, config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Capture loads an already-authenticated session, so the login-page
  // automation detection that forces CDP in setup-auth doesn't apply here.
  // storageState is engine-portable JSON and Shopify accepts a Chrome-minted
  // session in firefox/webkit too (validated live 2026-07-27). Caveat: settle()
  // only converges reliably on chrome — firefox/webkit re-encode enough of the
  // frame between runs to trip /docs-check drift. See SPEC.md § Dependencies.
  const engine = playwright[spec.engine];
  /** @type {{headless: boolean, channel?: string}} */
  const launchOpts = {
    headless: args.headed ? false : config.capture.headless !== false,
  };
  if (spec.channel) launchOpts.channel = spec.channel;

  let browser;
  try {
    browser = await engine.launch(launchOpts);
  } catch (err) {
    if (spec.channel) {
      // System browsers can't be auto-installed.
      const vendorUrl =
        spec.name === 'msedge'
          ? 'https://www.microsoft.com/edge/'
          : 'https://www.google.com/chrome/';
      console.error(
        `Could not launch ${spec.name}: ${err.message}\n` +
          `Capture uses your installed browser — get it from ${vendorUrl}`
      );
      process.exit(1);
    }
    // Only a missing browser binary is auto-installable. Any other launch
    // failure (missing system lib, sandbox) would just download ~100MB and
    // fail again with the real cause discarded.
    // (Same string Playwright itself matches on to mean "run playwright install".
    // Case-sensitive: the lowercase variant means a bad explicit executablePath.)
    if (!err.message.includes("Executable doesn't exist")) {
      console.error(`Could not launch ${spec.name}: ${err.message}`);
      process.exit(1);
    }
    console.error(`${spec.name} is not installed — running: npx playwright install ${spec.name}`);
    const install = spawnSync('npx', ['playwright', 'install', spec.name], {
      stdio: 'inherit',
      // Pin to the plugin root so npx uses the local playwright that this
      // script required — not a registry copy whose browser revisions differ.
      cwd: path.resolve(__dirname, '..'),
      shell: process.platform === 'win32',
    });
    if (install.error || install.status !== 0) {
      console.error(
        `playwright install ${spec.name} failed: ${install.error ? install.error.message : `exit ${install.status}`}`
      );
      process.exit(1);
    }
    try {
      browser = await engine.launch(launchOpts);
    } catch (err2) {
      console.error(`Could not launch ${spec.name} after install: ${err2.message}`);
      process.exit(1);
    }
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
      `(${config.store}, ${spec.name}, viewport ${viewport.width}x${viewport.height})`
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
      // Every selector times out on a bot interstitial too, and blaming the
      // manifest for that sends the user to fix something that isn't broken.
      // Classified here rather than at each throw site so it covers all three
      // (action resolve, waitFor, iframe crop).
      if (await detectBotChallenge(page)) {
        console.error(
          `${err.message}\nThat page is a bot challenge, not the admin (${page.url()}) — the manifest is fine.` +
            (launchOpts.headless
              ? `\nHeadless ${spec.name} gets challenged on some stores; re-run with --headed.`
              : `\n${spec.name} was challenged even headed — wait and re-run, or try another store session.`)
        );
        await browser.close();
        process.exit(EXIT_CHALLENGE);
      }
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

module.exports = { resolveOutDir, resolveBrowser, checkReadOnly, validateManifest };

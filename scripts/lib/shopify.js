'use strict';

/**
 * Shopify admin helpers: URL builders, iframe location, wait strategies,
 * and login detection. Shared by setup-auth.js and capture.js.
 */

/** Selector for the embedded-app iframe inside the Shopify admin. */
const APP_IFRAME_SELECTOR = 'iframe[name="app-iframe"]';

/** Selector that reliably exists once the admin shell has rendered. */
const ADMIN_SHELL_SELECTOR = 'nav, [role="navigation"]';

/**
 * Build an absolute admin URL from a manifest path like "/admin/apps/x/y".
 * Navigating via the store domain lets Shopify redirect to the canonical
 * admin.shopify.com/store/<name>/... form on its own.
 * @param {string} store
 * @param {string} [adminPath]
 */
function adminUrl(store, adminPath) {
  const host = store.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let p = adminPath || '/admin';
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.startsWith('/admin')) p = '/admin' + p;
  return `https://${host}${p}`;
}

/**
 * @param {string} store
 * @param {string} appHandle
 * @param {string} [subPath]
 */
function appUrl(store, appHandle, subPath = '') {
  const sub = subPath ? (subPath.startsWith('/') ? subPath : '/' + subPath) : '';
  return adminUrl(store, `/admin/apps/${appHandle}${sub}`);
}

/**
 * True when the URL is a Shopify login/auth page rather than the admin.
 * @param {string} url
 */
function isLoginUrl(url) {
  return (
    /accounts\.shopify\.com/.test(url) ||
    /\/admin\/auth\//.test(url) ||
    /\/login/.test(url) ||
    /identity\.shopify\.com/.test(url)
  );
}

/**
 * True when a page looks like a Cloudflare-style bot interstitial rather than
 * the admin. Headless Chrome gets challenged on some stores; the page then has
 * no admin markup at all, so every selector times out and the failure reads as
 * "the UI changed" unless it's classified.
 *
 * Deliberately strict: this runs only *after* a shot already failed, and a
 * false positive would send the user chasing a bot challenge when the UI really
 * did change — the same wrong-diagnosis bug, inverted. So it matches on the
 * challenge markup itself, never on the "Just a moment..." title alone.
 */
const CHALLENGE_MARKER =
  /connection needs to be verified|verify(ing)? you are human|checking your browser|cf-browser-verification|challenge-(running|form)|checking_browser|_cf_chl/i;

/** @param {string} html */
function isBotChallenge(html) {
  return CHALLENGE_MARKER.test(html || '');
}

/**
 * Read the live page's markup and classify it. Never throws.
 * @param {import('playwright').Page} page
 */
async function detectBotChallenge(page) {
  try {
    const html = await page.evaluate(() =>
      document.body ? document.body.innerHTML.slice(0, 4000) : ''
    );
    return isBotChallenge(html);
  } catch {
    return false;
  }
}

/**
 * True when the URL is an authenticated admin page.
 * @param {string} url
 */
function isAdminUrl(url) {
  if (isLoginUrl(url)) return false;
  return (
    /admin\.shopify\.com\/store\//.test(url) ||
    /\.myshopify\.com\/admin(\/|$|\?)/.test(url)
  );
}

/**
 * Find a selector on the admin page or inside the embedded-app iframe.
 * Returns a Playwright locator for the first visible match, or null after
 * the timeout. Polls both frames so manifest authors don't have to care
 * which frame an element lives in.
 *
 * Filters to visible matches *before* taking .first() — responsive Polaris
 * layouts render duplicate controls (one desktop, one mobile) and the hidden
 * one is often first in the DOM. Matching .first() and then testing
 * visibility would poll the hidden twin until timeout.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {number} timeoutMs
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function findInPageOrIframe(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const onPage = page.locator(selector).locator('visible=true').first();
    if (await onPage.isVisible().catch(() => false)) return onPage;
    const inFrame = page
      .frameLocator(APP_IFRAME_SELECTOR)
      .locator(selector)
      .locator('visible=true')
      .first();
    if (await inFrame.isVisible().catch(() => false)) return inFrame;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
}

/**
 * Apply a shot's wait strategy: "networkidle+selector" (default) or
 * "selector". Throws { code: 'SELECTOR_TIMEOUT' } if waitFor never shows.
 * @param {import('playwright').Page} page
 * @param {{id: string, waitFor?: string, waitStrategy?: string}} shot
 * @param {number} [timeoutMs]
 */
async function applyWaitStrategy(page, shot, timeoutMs = 30000) {
  const strategy = shot.waitStrategy || 'networkidle+selector';
  if (strategy.includes('networkidle')) {
    // Best-effort: pages with long-polling never go idle; the selector
    // wait below is the real gate.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  if (!shot.waitFor) {
    const err = /** @type {Error & {code?: string}} */ (
      new Error(`Shot "${shot.id}" has no waitFor selector (required).`)
    );
    err.code = 'MANIFEST_INVALID';
    throw err;
  }
  const found = await findInPageOrIframe(page, shot.waitFor, timeoutMs);
  if (!found) {
    const err = /** @type {Error & {code?: string}} */ (
      new Error(`Shot "${shot.id}": selector never became visible: ${shot.waitFor}`)
    );
    err.code = 'SELECTOR_TIMEOUT';
    throw err;
  }
  return found;
}

module.exports = {
  APP_IFRAME_SELECTOR,
  ADMIN_SHELL_SELECTOR,
  adminUrl,
  appUrl,
  isLoginUrl,
  isAdminUrl,
  isBotChallenge,
  detectBotChallenge,
  findInPageOrIframe,
  applyWaitStrategy,
};

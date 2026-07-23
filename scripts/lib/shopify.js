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
 */
function adminUrl(store, adminPath) {
  const host = store.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let p = adminPath || '/admin';
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.startsWith('/admin')) p = '/admin' + p;
  return `https://${host}${p}`;
}

function appUrl(store, appHandle, subPath = '') {
  const sub = subPath ? (subPath.startsWith('/') ? subPath : '/' + subPath) : '';
  return adminUrl(store, `/admin/apps/${appHandle}${sub}`);
}

/** True when the URL is a Shopify login/auth page rather than the admin. */
function isLoginUrl(url) {
  return (
    /accounts\.shopify\.com/.test(url) ||
    /\/admin\/auth\//.test(url) ||
    /\/login/.test(url) ||
    /identity\.shopify\.com/.test(url)
  );
}

/** True when the URL is an authenticated admin page. */
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
 */
async function applyWaitStrategy(page, shot, timeoutMs = 30000) {
  const strategy = shot.waitStrategy || 'networkidle+selector';
  if (strategy.includes('networkidle')) {
    // Best-effort: pages with long-polling never go idle; the selector
    // wait below is the real gate.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  if (!shot.waitFor) {
    const err = new Error(`Shot "${shot.id}" has no waitFor selector (required).`);
    err.code = 'MANIFEST_INVALID';
    throw err;
  }
  const found = await findInPageOrIframe(page, shot.waitFor, timeoutMs);
  if (!found) {
    const err = new Error(
      `Shot "${shot.id}": selector never became visible: ${shot.waitFor}`
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
  findInPageOrIframe,
  applyWaitStrategy,
};

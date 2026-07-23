#!/usr/bin/env node
'use strict';

/**
 * Self-check for findInPageOrIframe. Run: node scripts/lib/shopify.test.js
 *
 * Guards the responsive-duplicate case: Polaris renders the same control
 * twice (desktop + mobile) and the hidden one often comes first in the DOM.
 */

const assert = require('assert');
const { chromium } = require('playwright');
const { findInPageOrIframe } = require('./shopify');

const PAGE = `
  <button style="display:none">Manage Settings</button>
  <button id="real">Manage Settings</button>
  <button style="display:none">Only Hidden</button>
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(PAGE);

  const found = await findInPageOrIframe(page, 'button:has-text("Manage Settings")', 2000);
  assert.ok(found, 'should find the visible duplicate, not poll the hidden one');
  assert.strictEqual(await found.getAttribute('id'), 'real', 'should return the visible twin');

  const missing = await findInPageOrIframe(page, 'button:has-text("Only Hidden")', 1000);
  assert.strictEqual(missing, null, 'all-hidden matches should time out to null');

  await browser.close();
  console.log('ok — findInPageOrIframe prefers visible matches');
})();

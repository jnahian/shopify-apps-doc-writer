#!/usr/bin/env node
'use strict';

/**
 * Self-check for findInPageOrIframe and isBotChallenge.
 * Run: node scripts/lib/shopify.test.js
 *
 * Guards the responsive-duplicate case: Polaris renders the same control
 * twice (desktop + mobile) and the hidden one often comes first in the DOM.
 * Also guards bot-challenge classification in both directions — a false
 * positive blames a challenge for a real UI change.
 */

const assert = require('assert');
const { chromium } = require('playwright');
const { findInPageOrIframe, isBotChallenge, detectBotChallenge } = require('./shopify');

const PAGE = `
  <button style="display:none">Manage Settings</button>
  <button id="real">Manage Settings</button>
  <button style="display:none">Only Hidden</button>
`;

// Shape of the page reported in issue #3 (headless Chrome, Cloudflare).
const CHALLENGE_PAGE = `
  <div id="challenge-running"></div>
  <h2>Your connection needs to be verified before you can proceed</h2>
`;

(async () => {
  // System Chrome, like the plugin itself: present on dev machines (the one
  // required browser) and on GitHub's ubuntu runners — no bundled-Chromium
  // download needed anywhere.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent(PAGE);

  const found = await findInPageOrIframe(page, 'button:has-text("Manage Settings")', 2000);
  assert.ok(found, 'should find the visible duplicate, not poll the hidden one');
  assert.strictEqual(await found.getAttribute('id'), 'real', 'should return the visible twin');

  const missing = await findInPageOrIframe(page, 'button:has-text("Only Hidden")', 1000);
  assert.strictEqual(missing, null, 'all-hidden matches should time out to null');

  // Bot-challenge classification (issue #3): the challenge page's own markup.
  assert.ok(
    isBotChallenge('<h2>Your connection needs to be verified before you can proceed</h2>'),
    'classic interstitial copy is a challenge'
  );
  assert.ok(isBotChallenge('<div id="challenge-running"></div>'), 'cf challenge div is a challenge');
  assert.ok(
    isBotChallenge('<h1>Verifying you are human</h1><script>window._cf_chl_opt={}</script>'),
    'turnstile-style interstitial is a challenge'
  );
  assert.ok(!isBotChallenge(''), 'an empty body is not a challenge');
  assert.ok(
    !isBotChallenge('<nav aria-label="Main"><a href="/admin/products">Products</a></nav>'),
    'a real admin page is not a challenge'
  );

  await page.setContent(CHALLENGE_PAGE);
  assert.strictEqual(await detectBotChallenge(page), true, 'live challenge page classified');
  await page.setContent(PAGE);
  assert.strictEqual(await detectBotChallenge(page), false, 'live ordinary page not classified');

  await browser.close();
  console.log('ok — findInPageOrIframe prefers visible matches; bot challenges classify both ways');
})();

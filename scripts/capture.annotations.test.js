#!/usr/bin/env node
'use strict';

/**
 * Browser self-check for annotation alignment.
 * Run: node scripts/capture.annotations.test.js
 *
 * The unit tests in lib/annotate.test.js prove the geometry maths; they cannot
 * prove the overlay lands on the right pixels. The failure this guards is
 * silent by construction: `crop: "iframe"` takes an *element* screenshot,
 * which scrolls the iframe into view and clips in document space, so a
 * viewport-anchored (position:fixed) overlay is offset by exactly the scroll
 * — and offset identically on every re-shoot, so settle()'s byte-stability
 * check is happy and the wrong PNG ships.
 *
 * The check needs no image decoder: paint the target's own background the
 * annotation colour and screenshot that, then screenshot the annotated page.
 * The overlay is on the right pixels if and only if the two are byte-equal.
 */

const assert = require('assert');
const { chromium } = require('playwright');
const { measureAnnotations, injectOverlay, captureAnnotated } = require('./capture');
const { overlayHtml } = require('./lib/annotate');

const FILL = '#00ff00';
const TARGET = 'width:200px;height:80px;position:absolute;left:120px;top:150px';
const FRAME = `<style>html,body{margin:0;background:#fff}</style><div id="t" style="${TARGET};background:#eee"></div>`;
// The iframe sits entirely below the fold, so an element screenshot must
// scroll to reach it — the exact situation that breaks a fixed overlay.
const PAGE = `<style>html,body{margin:0;background:#fff}</style>
  <div style="height:900px"></div>
  <iframe name="app-iframe" style="display:block;width:800px;height:500px;border:0" srcdoc='${FRAME}'></iframe>
  <div style="height:900px"></div>`;

/** @type {import('./capture').Shot} */
const SHOT = {
  id: 'annotated',
  path: '/x',
  waitFor: '#t',
  crop: 'iframe',
  annotate: [{ type: 'blur', target: '#t', fill: FILL }],
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(PAGE);
  await page.waitForTimeout(200);

  const frameEl = () => page.locator('iframe[name="app-iframe"]').first();
  const shoot = () => frameEl().screenshot({ animations: 'disabled' });
  // An element screenshot leaves the page scrolled, so re-read the rect every
  // time — captureShot's captureBounds does the same.
  const captureBounds = async () => {
    const box = await frameEl().boundingBox();
    assert.ok(box, 'iframe has a box');
    return box;
  };
  const top = () => page.evaluate(() => window.scrollTo(0, 0));
  const removeOverlay = () =>
    page.evaluate(() => {
      const prev = document.getElementById('__sadw_annotations');
      if (prev) prev.remove();
    });
  /** @param {string} color */
  const paint = (color) =>
    page
      .frameLocator('iframe[name="app-iframe"]')
      .locator('#t')
      .evaluate((el, c) => {
        el.style.background = /** @type {string} */ (c);
      }, color);

  await top();
  assert.ok((await captureBounds()).y > 600, 'the iframe starts entirely below the fold');

  // Reference: the target painted the annotation colour by the page itself.
  await paint(FILL);
  await top();
  const expected = await shoot();
  await paint('#eee');

  // Measure and inject at the same scroll position a real capture would, then
  // let the element screenshot scroll the iframe into view underneath it.
  await top();
  const geometries = await measureAnnotations(page, SHOT, await captureBounds());
  await injectOverlay(page, geometries);
  await top();
  const annotated = await shoot();
  assert.ok(
    annotated.equals(expected),
    'the redaction box must cover exactly the target it was anchored to'
  );

  // Same geometry, viewport-anchored the way it used to be: the screenshot
  // scrolls, the overlay does not, and the box is nowhere in the frame.
  // Without this the assertion above could pass for the wrong reason.
  await removeOverlay();
  await top();
  await page.evaluate((html) => {
    const el = document.createElement('div');
    el.id = '__sadw_annotations';
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    el.innerHTML = html;
    document.body.appendChild(el);
  }, overlayHtml(geometries).replace(/position:absolute/g, 'position:fixed'));
  await top();
  assert.ok(!(await shoot()).equals(expected), 'a fixed overlay is misaligned — the bug this guards');
  await removeOverlay();

  // End to end, including the measure → inject → settle → re-measure loop.
  // The re-measure lands after a screenshot has scrolled the page; counting
  // shots proves the loop doesn't read that scroll as a moved target. settle()
  // takes exactly two frames on a stable page, so anything above two means a
  // wasted retry cycle — or, past the budget, a failed shot on a fine manifest.
  await top();
  let shots = 0;
  const countedShoot = () => {
    shots++;
    return shoot();
  };
  const viaCapture = await captureAnnotated(page, SHOT, countedShoot, captureBounds);
  assert.ok(viaCapture.equals(expected), 'captureAnnotated produces the same aligned frame');
  assert.strictEqual(shots, 2, 'one measure/settle pass — the re-measure must be scroll-invariant');
  await removeOverlay();

  // Off-region targets fail loudly rather than shipping an annotation-free
  // PNG: this one is on screen, but outside the iframe the shot crops to.
  await top();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'outside';
    d.style.cssText = 'position:absolute;left:10px;top:10px;width:40px;height:20px';
    document.body.appendChild(d);
  });
  /** @type {import('./capture').Shot} */
  const outsideShot = {
    id: 'outside',
    path: '/x',
    waitFor: '#outside',
    crop: 'iframe',
    annotate: [{ type: 'highlight', target: '#outside' }],
  };
  await assert.rejects(
    async () => measureAnnotations(page, outsideShot, await captureBounds()),
    /outside the capture region/
  );

  await browser.close();
  console.log('ok — annotation overlays land on their target through an iframe crop');
})();

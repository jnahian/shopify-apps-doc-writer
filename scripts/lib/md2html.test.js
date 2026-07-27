#!/usr/bin/env node
'use strict';

/**
 * Self-check for mdToHtml. Run: node scripts/lib/md2html.test.js
 *
 * The load-bearing case is the numbering trap: a screenshot between two
 * numbered steps must NOT close the <ol>, or every step renders as "1.".
 */

const assert = require('assert');
const { mdToHtml } = require('./md2html');

const MD = `# Title

> Value statement.

## Steps

1. First step with **bold**.

   ![a caption](screenshots/01-navigate.png)

2. Second step with \`code\`.

3. Third step.

## List

- One
- Two
`;

const html = mdToHtml(MD, 'my-feature');

// One list, so numbering runs 1-2-3 instead of restarting at each screenshot.
assert.strictEqual((html.match(/<ol>/g) || []).length, 1, 'screenshot must not split the ordered list');
assert.strictEqual((html.match(/<li>/g) || []).length, 5, '3 steps + 2 bullets');

// The screenshot is folded into the step it documents.
assert.ok(
  /First step with <b>bold<\/b>\.<br><i>\[Screenshot: 01-navigate\.png/.test(html),
  'screenshot should be appended inside the preceding <li>'
);

assert.ok(html.includes('<h1>Title</h1>'), 'h1');
assert.ok(html.includes('<h2>Steps</h2>'), 'h2');
assert.ok(html.includes('<p><i>Value statement.</i></p>'), 'blockquote → italic line');
assert.ok(html.includes('<code>code</code>'), 'inline code emitted (Drive flattens it, but emit it anyway)');
assert.ok(html.includes('<ul>'), 'bullet list');
assert.ok(html.includes('docs/my-feature/screenshots/'), 'slug in the placeholder path');

// Markup in prose must not become live HTML.
assert.ok(mdToHtml('Use <script> tags', 'x').includes('&lt;script&gt;'), 'escapes raw HTML');

// --- Site mode: real inline images, no document wrapper -------------------

const site = mdToHtml(MD, 'my-feature', { images: 'inline', wrap: false });

assert.ok(!site.startsWith('<html>'), 'wrap:false omits the <html><body> wrapper');
assert.ok(!site.includes('[Screenshot:'), 'inline mode emits no placeholder markers');
assert.ok(
  site.includes(
    '<figure><img src="screenshots/01-navigate.png" alt="a caption"><figcaption>a caption</figcaption></figure>'
  ),
  'inline mode emits a real <img> with figcaption'
);
// The numbering trap must hold in inline mode too.
assert.strictEqual((site.match(/<ol>/g) || []).length, 1, 'inline image must not split the ordered list');

// A standalone image is a bare <figure>, not nested inside <p>.
const bare = mdToHtml('![cap](screenshots/02-x.png)', 'x', { images: 'inline' });
assert.ok(bare.includes('<figure><img src="screenshots/02-x.png" alt="cap">'), 'standalone inline image');
assert.ok(!bare.includes('<p><figure>'), 'figure must not be wrapped in <p>');

// Quotes in captions must not break the alt attribute.
const quoted = mdToHtml('!["hi"](screenshots/03-x.png)', 'x', { images: 'inline' });
assert.ok(quoted.includes('alt="&quot;hi&quot;"'), 'quotes escaped in alt');

// Defaults unchanged: no third argument behaves exactly as before.
assert.strictEqual(mdToHtml(MD, 'my-feature'), html, 'default call unchanged by the new options');

console.log('ok — mdToHtml keeps numbering intact and converts the template subset');

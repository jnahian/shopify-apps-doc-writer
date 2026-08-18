#!/usr/bin/env node
'use strict';

/** Self-check for lib/annotate.js. Run: node scripts/lib/annotate.test.js */

const assert = require('assert');
const {
  validateAnnotations,
  resolveGeometry,
  overlayHtml,
  geometryBounds,
  checkGeometryFits,
} = require('./annotate');

assert.strictEqual(validateAnnotations(undefined), null, 'absent annotate is fine');
assert.strictEqual(
  validateAnnotations([
    { type: 'highlight', target: '#x' },
    { type: 'arrow', target: '#x', side: 'bottom', length: 30, gap: 4, color: '#000' },
    { type: 'blur', target: '#x', fill: '#1a1a1a', offset: { x: 2, y: -2 } },
  ]),
  null,
  'valid annotations of all three types pass'
);
assert.match(validateAnnotations({}) || '', /must be an array/);
assert.match(validateAnnotations([null]) || '', /annotate\[0\] is not an object/);
assert.match(validateAnnotations([{ type: 'circle', target: '#x' }]) || '', /unknown type "circle"/);
assert.match(validateAnnotations([{ type: 'blur' }]) || '', /missing "target"/);
assert.match(validateAnnotations([{ type: 'arrow', target: '#x', length: '56' }]) || '', /length must be a finite number/);
assert.match(validateAnnotations([{ type: 'arrow', target: '#x', side: 'up' }]) || '', /side must be one of/);
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', color: 3 }]) || '', /color must be a string/);
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', offset: { x: '1' } }]) || '', /offset\.x must be a finite number/);

// Fix 2: NaN/Infinity are typeof 'number' but not finite — must be rejected.
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', strokeWidth: NaN }]) || '', /strokeWidth must be a finite number/);
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', offset: { y: Infinity } }]) || '', /offset\.y must be a finite number/);

// Fix 3: color/fill are interpolated into a style attribute, so only real
// color syntax passes — an allowlist, not a blocklist.
assert.match(
  validateAnnotations([{ type: 'blur', target: '#x', fill: '"><script>' }]) || '',
  /fill is not a color/
);
// A ';' would close the declaration and inject further CSS (e.g. overriding
// position), detaching a redaction box from what it is meant to hide.
assert.match(
  validateAnnotations([{ type: 'blur', target: '#x', fill: '#000;position:static;top:0;left:0' }]) || '',
  /fill is not a color/
);
assert.match(
  validateAnnotations([{ type: 'highlight', target: '#x', color: 'red;border:0' }]) || '',
  /color is not a color/
);
assert.match(
  validateAnnotations([{ type: 'highlight', target: '#x', color: 'url(x)' }]) || '',
  /color is not a color/
);
for (const ok of ['#fff', '#1a2b3c', '#1a2b3cdd', 'red', 'transparent', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'hsl(210 40% 50%)']) {
  assert.strictEqual(validateAnnotations([{ type: 'blur', target: '#x', fill: ok }]), null, `${ok} is a color`);
}

console.log('ok — validateAnnotations');

// --- resolveGeometry ---

const box = { x: 100.4, y: 200.6, width: 50.2, height: 30.0 };

// highlight: rounds to integers, then grows by default padding 4.
assert.deepStrictEqual(resolveGeometry(box, { type: 'highlight', target: '#x' }), {
  type: 'highlight', x: 96, y: 197, width: 58, height: 38,
  color: '#d72c0d', strokeWidth: 3, radius: 6,
});

// offset nudges after anchoring; explicit knobs override defaults.
assert.deepStrictEqual(
  resolveGeometry(box, { type: 'highlight', target: '#x', padding: 0, offset: { x: 10, y: -5 } }),
  { type: 'highlight', x: 110, y: 196, width: 50, height: 30, color: '#d72c0d', strokeWidth: 3, radius: 6 }
);

// blur: default padding 0, no fill key unless given.
assert.deepStrictEqual(resolveGeometry(box, { type: 'blur', target: '#x' }), {
  type: 'blur', x: 100, y: 201, width: 50, height: 30, blur: 12,
});
assert.deepStrictEqual(resolveGeometry(box, { type: 'blur', target: '#x', fill: '#000' }), {
  type: 'blur', x: 100, y: 201, width: 50, height: 30, blur: 12, fill: '#000',
});

// arrows: tip `gap` px off the side's midpoint, tail `length` further out.
const square = { x: 100, y: 200, width: 40, height: 20 };
assert.deepStrictEqual(resolveGeometry(square, { type: 'arrow', target: '#x' }), {
  type: 'arrow', tip: { x: 92, y: 210 }, tail: { x: 36, y: 210 },
  color: '#d72c0d', strokeWidth: 3,
});
assert.deepStrictEqual(
  resolveGeometry(square, { type: 'arrow', target: '#x', side: 'bottom', length: 30, gap: 4 }),
  { type: 'arrow', tip: { x: 120, y: 224 }, tail: { x: 120, y: 254 }, color: '#d72c0d', strokeWidth: 3 }
);
assert.deepStrictEqual(
  resolveGeometry(square, { type: 'arrow', target: '#x', side: 'right' }),
  { type: 'arrow', tip: { x: 148, y: 210 }, tail: { x: 204, y: 210 }, color: '#d72c0d', strokeWidth: 3 }
);
assert.deepStrictEqual(
  resolveGeometry(square, { type: 'arrow', target: '#x', side: 'top' }),
  { type: 'arrow', tip: { x: 120, y: 192 }, tail: { x: 120, y: 136 }, color: '#d72c0d', strokeWidth: 3 }
);

// arrows honor round-the-box-first like highlight/blur: fractional box is
// rounded before the midpoint is taken.
assert.deepStrictEqual(
  resolveGeometry({ x: 100, y: 200.4, width: 40, height: 20.4 }, { type: 'arrow', target: '#x' }),
  { type: 'arrow', tip: { x: 92, y: 210 }, tail: { x: 36, y: 210 }, color: '#d72c0d', strokeWidth: 3 }
);

// strokeWidth and radius are coordinates too: arrowHtml derives the SVG
// origin from strokeWidth, so a fractional one reintroduces the fractional
// positions the integer invariant exists to avoid.
assert.deepStrictEqual(
  resolveGeometry(square, { type: 'highlight', target: '#x', strokeWidth: 2.5, radius: 3.4 }),
  { type: 'highlight', x: 96, y: 196, width: 48, height: 28, color: '#d72c0d', strokeWidth: 3, radius: 3 }
);
assert.deepStrictEqual(
  resolveGeometry(square, { type: 'arrow', target: '#x', strokeWidth: 2.5 }),
  { type: 'arrow', tip: { x: 92, y: 210 }, tail: { x: 36, y: 210 }, color: '#d72c0d', strokeWidth: 3 }
);

console.log('ok — resolveGeometry');

// --- overlayHtml ---

const geoms = [
  resolveGeometry(square, { type: 'highlight', target: '#x' }),
  resolveGeometry(square, { type: 'arrow', target: '#x' }),
  resolveGeometry(square, { type: 'blur', target: '#x' }),
  resolveGeometry(square, { type: 'blur', target: '#x', fill: '#1a1a1a' }),
];
const html = overlayHtml(geoms);

// Deterministic: recomputing everything from scratch yields the same bytes.
const again = overlayHtml([
  resolveGeometry(square, { type: 'highlight', target: '#x' }),
  resolveGeometry(square, { type: 'arrow', target: '#x' }),
  resolveGeometry(square, { type: 'blur', target: '#x' }),
  resolveGeometry(square, { type: 'blur', target: '#x', fill: '#1a1a1a' }),
]);
assert.strictEqual(html, again, 'byte-stable for identical input');

// One element per geometry, correct paint per type.
assert.match(html, /border:3px solid #d72c0d;border-radius:6px/);
assert.match(html, /<svg [^>]*>.*<line .*stroke="#d72c0d"/);
assert.match(html, /<polygon points="[0-9,. -]+" fill="#d72c0d"/);
assert.match(html, /backdrop-filter:blur\(12px\)/);
assert.match(html, /background:#1a1a1a/);

// A solid redaction must not also blur, and vice versa.
const parts = html.split('<div').filter((p) => p.includes('background:#1a1a1a'));
assert.strictEqual(parts.length, 1);
assert.ok(!parts[0].includes('backdrop-filter'), 'fill suppresses blur');

// Everything is absolutely positioned (4 geometries → 4 elements). Absolute,
// not fixed: an element screenshot clips in document space after scrolling
// the target into view, and a fixed overlay does not scroll with it.
assert.strictEqual((html.match(/position:absolute/g) || []).length, 4);
assert.ok(!html.includes('position:fixed'), 'no fixed positioning survives');

// Arrow SVG spans its own bbox: default-left arrow tip(92,210) tail(36,210),
// margin 9 → svg at left:27px top:201px, 74x18.
assert.match(html, /<svg style="position:absolute;left:27px;top:201px" width="74" height="18"/);

console.log('ok — overlayHtml');

// --- geometryBounds ---

// A highlight/blur draws exactly its own rect.
assert.deepStrictEqual(
  geometryBounds(resolveGeometry(square, { type: 'highlight', target: '#x' })),
  { x: 96, y: 196, width: 48, height: 28 }
);
// An arrow draws beyond tip/tail by the head half-width and round linecap —
// the same margin arrowHtml uses to size its SVG.
assert.deepStrictEqual(
  geometryBounds(resolveGeometry(square, { type: 'arrow', target: '#x' })),
  { x: 27, y: 201, width: 74, height: 18 }
);

console.log('ok — geometryBounds');

// --- checkGeometryFits ---

const viewport = { x: 0, y: 0, width: 1280, height: 800 };
/** @param {{x: number, y: number, width: number, height: number}} b */
const hl = (b) => resolveGeometry(b, { type: 'highlight', target: '#x', padding: 0 });

// Fully inside, and partially overlapping an edge: both fine. A highlight
// traces a real element, whose size the manifest author does not control.
assert.strictEqual(checkGeometryFits(hl({ x: 100, y: 100, width: 50, height: 50 }), viewport), null);
assert.strictEqual(checkGeometryFits(hl({ x: 1260, y: 100, width: 50, height: 50 }), viewport), null);

// Entirely outside in any direction: nothing would be drawn.
for (const off of [
  { x: 100, y: 900, width: 50, height: 50 },
  { x: 1300, y: 100, width: 50, height: 50 },
  { x: -100, y: -100, width: 50, height: 50 },
]) {
  assert.match(checkGeometryFits(hl(off), viewport) || '', /outside the capture region/);
}

// crop: "iframe" bounds are the iframe's rect, not the viewport. A box in the
// admin's left nav is on-screen but absent from the cropped PNG.
const iframe = { x: 240, y: 56, width: 1040, height: 744 };
assert.strictEqual(checkGeometryFits(hl({ x: 300, y: 100, width: 50, height: 50 }), iframe), null);
assert.match(
  checkGeometryFits(hl({ x: 20, y: 100, width: 50, height: 50 }), iframe) || '',
  /outside the capture region/
);

// Arrows must fit entirely: we choose where they go, and a half-drawn arrow
// points from nowhere. Default side 'left' on a box at x=20 tails off-canvas.
assert.match(
  checkGeometryFits(resolveGeometry({ x: 20, y: 100, width: 40, height: 20 }, { type: 'arrow', target: '#x' }), viewport) || '',
  /clipped by the capture region.*side, length, or offset/
);
assert.strictEqual(
  checkGeometryFits(resolveGeometry({ x: 20, y: 100, width: 40, height: 20 }, { type: 'arrow', target: '#x', side: 'right' }), viewport),
  null
);
// Same arrow, iframe crop: it fits the viewport but not the iframe rect.
assert.match(
  checkGeometryFits(resolveGeometry({ x: 300, y: 100, width: 40, height: 20 }, { type: 'arrow', target: '#x', side: 'left' }), iframe) || '',
  /clipped by the capture region/
);

console.log('ok — checkGeometryFits');

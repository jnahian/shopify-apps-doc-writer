#!/usr/bin/env node
'use strict';

/** Self-check for lib/annotate.js. Run: node scripts/lib/annotate.test.js */

const assert = require('assert');
const { validateAnnotations, resolveGeometry } = require('./annotate');

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
assert.match(validateAnnotations([{ type: 'arrow', target: '#x', length: '56' }]) || '', /length must be a number/);
assert.match(validateAnnotations([{ type: 'arrow', target: '#x', side: 'up' }]) || '', /side must be one of/);
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', color: 3 }]) || '', /color must be a string/);
assert.match(validateAnnotations([{ type: 'highlight', target: '#x', offset: { x: '1' } }]) || '', /offset\.x must be a number/);

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

console.log('ok — resolveGeometry');

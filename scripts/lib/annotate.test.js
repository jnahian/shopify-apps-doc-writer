#!/usr/bin/env node
'use strict';

/** Self-check for lib/annotate.js. Run: node scripts/lib/annotate.test.js */

const assert = require('assert');
const { validateAnnotations } = require('./annotate');

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

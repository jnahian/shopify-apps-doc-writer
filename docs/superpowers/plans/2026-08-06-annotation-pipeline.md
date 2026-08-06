# Annotation Pipeline (0.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-shot `annotate` list in the shot manifest — selector-anchored highlight rects, arrows, and blur/redaction boxes, drawn as an in-browser overlay before the screenshot, byte-deterministic on re-capture.

**Architecture:** A new pure module `scripts/lib/annotate.js` does all validation, geometry, and HTML-string work (unit-testable, no browser). `scripts/capture.js` gains one step between `applyWaitStrategy` and `settle()`: resolve each annotation's `target` via the existing `findInPageOrIframe`, take its bounding box, and inject the overlay HTML into the top document. Determinism is inherited from `settle()` — the overlay is just more DOM in the render it already stabilizes.

**Tech Stack:** Node (plain JS + JSDoc under strict `checkJs`), Playwright (already a dependency), plain-`assert` test scripts run by `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-06-annotation-pipeline-design.md` (approved). Work happens on branch `annotation-pipeline-0.4`.

## Global Constraints

- **No new dependencies** — runtime dep list stays exactly `playwright`.
- **TDD is mandatory for JS** (CLAUDE.md): failing test first, watch it fail, then implement. `npm test` and `npm run typecheck` must pass before every commit.
- Tests are plain `assert` scripts named `<module>.test.js` beside their module; `node --test` auto-discovers them; each must also run standalone via `node <file>`.
- **Exit-code contract unchanged**: a missing annotation target is `SELECTOR_TIMEOUT` → exit `20`, inheriting the bot-challenge reclassification to `30` (classified centrally in `capture.js`'s catch — do not classify at the throw site).
- **Determinism**: identical inputs → byte-identical overlay HTML; all output coordinates are integers. House default color is exactly `#d72c0d`.
- Annotation types are exactly `highlight`, `arrow`, `blur` (fill present → solid redaction). Defaults, verbatim from the spec: highlight `color #d72c0d, strokeWidth 3, radius 6, padding 4`; arrow `color #d72c0d, strokeWidth 3, side "left", length 56, gap 8`; blur `padding 0, blur 12, fill none`; all types `offset {x:0, y:0}`.
- **Surgical diffs**: don't reformat or refactor untouched code.
- Shots without `annotate` must behave exactly as before.

---

### Task 1: `validateAnnotations` in `scripts/lib/annotate.js`

**Files:**
- Create: `scripts/lib/annotate.js`
- Create (test): `scripts/lib/annotate.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `validateAnnotations(annotate: any): string|null` — returns the first problem as a message (no shot-id prefix; the caller adds it), or `null` if valid/absent. Exported from `scripts/lib/annotate.js`.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/annotate.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/annotate.test.js`
Expected: FAIL with `Cannot find module './annotate'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/annotate.js`:

```js
'use strict';

/**
 * annotate.js — pure logic for the annotation pipeline: manifest validation,
 * geometry (bounding box → drawn shape), and overlay HTML.
 *
 * Selector resolution and DOM injection live in capture.js; everything here
 * is deterministic number/string work so it unit-tests without a browser.
 * Determinism is a contract: identical inputs must produce byte-identical
 * HTML, or /docs-check reports phantom drift on every annotated doc.
 */

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Box
 * @typedef {'top'|'right'|'bottom'|'left'} Side
 * @typedef {{
 *   type: 'highlight'|'arrow'|'blur',
 *   target: string,
 *   color?: string, strokeWidth?: number, radius?: number, padding?: number,
 *   side?: Side, length?: number, gap?: number,
 *   blur?: number, fill?: string,
 *   offset?: {x?: number, y?: number},
 * }} Annotation
 */

const TYPES = ['highlight', 'arrow', 'blur'];
const SIDES = ['top', 'right', 'bottom', 'left'];
const NUMERIC_KNOBS = ['strokeWidth', 'radius', 'padding', 'length', 'gap', 'blur'];

// Polaris critical red — reads as documentation ink, not app UI.
const DEFAULT_COLOR = '#d72c0d';

/**
 * Validate one shot's `annotate` value. Returns the first problem as a
 * message (the caller prefixes the shot id), or null if valid or absent.
 * @param {any} annotate
 * @returns {string|null}
 */
function validateAnnotations(annotate) {
  if (annotate === undefined) return null;
  if (!Array.isArray(annotate)) return '"annotate" must be an array';
  for (let i = 0; i < annotate.length; i++) {
    const ann = annotate[i];
    const at = `annotate[${i}]`;
    if (typeof ann !== 'object' || ann === null) return `${at} is not an object`;
    if (!TYPES.includes(ann.type)) {
      return `${at} has unknown type "${ann.type}" (valid: ${TYPES.join(', ')})`;
    }
    if (typeof ann.target !== 'string' || !ann.target) return `${at} is missing "target"`;
    for (const knob of NUMERIC_KNOBS) {
      if (ann[knob] !== undefined && typeof ann[knob] !== 'number') {
        return `${at}.${knob} must be a number`;
      }
    }
    if (ann.side !== undefined && !SIDES.includes(ann.side)) {
      return `${at}.side must be one of ${SIDES.join(', ')}`;
    }
    for (const str of ['color', 'fill']) {
      if (ann[str] !== undefined && typeof ann[str] !== 'string') {
        return `${at}.${str} must be a string`;
      }
    }
    if (ann.offset !== undefined) {
      if (typeof ann.offset !== 'object' || ann.offset === null) return `${at}.offset must be {x, y}`;
      for (const axis of ['x', 'y']) {
        if (ann.offset[axis] !== undefined && typeof ann.offset[axis] !== 'number') {
          return `${at}.offset.${axis} must be a number`;
        }
      }
    }
  }
  return null;
}

module.exports = { validateAnnotations };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/annotate.test.js`
Expected: prints `ok — validateAnnotations`, exit 0

- [ ] **Step 5: Verify the full gates**

Run: `npm test && npm run typecheck`
Expected: all suites pass (the new file is auto-discovered), typecheck clean

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/annotate.js scripts/lib/annotate.test.js
git commit -m "feat(annotate): validateAnnotations for the manifest annotate field"
```

---

### Task 2: `resolveGeometry` in `scripts/lib/annotate.js`

**Files:**
- Modify: `scripts/lib/annotate.js` (add below `validateAnnotations`)
- Modify (test): `scripts/lib/annotate.test.js` (append)

**Interfaces:**
- Consumes: the `Annotation` typedef and `DEFAULT_COLOR` from Task 1.
- Produces: `resolveGeometry(box: Box, ann: Annotation): Geometry`, exported, plus these typedefs (Task 3 and capture.js import them by name via `import('./annotate')`):
  - `HighlightGeometry = {type:'highlight', x, y, width, height, color: string, strokeWidth: number, radius: number}` (all coords integer)
  - `BlurGeometry = {type:'blur', x, y, width, height, blur: number, fill?: string}`
  - `ArrowGeometry = {type:'arrow', tip:{x,y}, tail:{x,y}, color: string, strokeWidth: number}`
  - `Geometry = HighlightGeometry|BlurGeometry|ArrowGeometry`

Anchoring semantics (from the spec): round the raw bounding box to integers, grow by `padding` on all sides, then shift by `offset`. Arrows: tip sits `gap` px outside the midpoint of the target's `side` edge, pointing at the element; tail is `length` px further out along the same axis.

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/annotate.test.js` (and add `resolveGeometry` to the require at the top: `const { validateAnnotations, resolveGeometry } = require('./annotate');`):

```js
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

console.log('ok — resolveGeometry');
```

(Worked expectations: `round(100.4)=100`, `round(200.6)=201`; highlight default pad 4 → `96,197,58,38`. Arrow default left on `square`: left-edge midpoint `(100,210)`, tip `100−8=92`, tail `92−56=36`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/annotate.test.js`
Expected: FAIL with `resolveGeometry is not a function`

- [ ] **Step 3: Write the implementation**

Add to `scripts/lib/annotate.js` below `validateAnnotations`, and extend `module.exports`:

```js
/**
 * @typedef {{type: 'highlight', x: number, y: number, width: number, height: number,
 *   color: string, strokeWidth: number, radius: number}} HighlightGeometry
 * @typedef {{type: 'blur', x: number, y: number, width: number, height: number,
 *   blur: number, fill?: string}} BlurGeometry
 * @typedef {{type: 'arrow', tip: {x: number, y: number}, tail: {x: number, y: number},
 *   color: string, strokeWidth: number}} ArrowGeometry
 * @typedef {HighlightGeometry|BlurGeometry|ArrowGeometry} Geometry
 */

/**
 * Arrow approach axis per side, pointing *away* from the target.
 * @type {Record<Side, {dx: number, dy: number}>}
 */
const AXIS = {
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  top: { dx: 0, dy: -1 },
  bottom: { dx: 0, dy: 1 },
};

/**
 * Anchor an annotation to a live bounding box. All output coordinates are
 * integers — boundingBox() returns fractional CSS pixels, and fractional
 * overlay positions invite anti-aliasing differences between runs.
 * @param {Box} box
 * @param {Annotation} ann
 * @returns {Geometry}
 */
function resolveGeometry(box, ann) {
  const ox = Math.round((ann.offset && ann.offset.x) || 0);
  const oy = Math.round((ann.offset && ann.offset.y) || 0);
  const color = ann.color !== undefined ? ann.color : DEFAULT_COLOR;
  const strokeWidth = ann.strokeWidth !== undefined ? ann.strokeWidth : 3;

  if (ann.type === 'arrow') {
    const side = ann.side !== undefined ? ann.side : 'left';
    const length = Math.round(ann.length !== undefined ? ann.length : 56);
    const gap = Math.round(ann.gap !== undefined ? ann.gap : 8);
    const { dx, dy } = AXIS[side];
    const midX = box.x + (dx === 0 ? box.width / 2 : dx === 1 ? box.width : 0);
    const midY = box.y + (dy === 0 ? box.height / 2 : dy === 1 ? box.height : 0);
    const tip = { x: Math.round(midX + dx * gap) + ox, y: Math.round(midY + dy * gap) + oy };
    const tail = { x: tip.x + dx * length, y: tip.y + dy * length };
    return { type: 'arrow', tip, tail, color, strokeWidth };
  }

  const padding = Math.round(
    ann.padding !== undefined ? ann.padding : ann.type === 'highlight' ? 4 : 0
  );
  const x = Math.round(box.x) - padding + ox;
  const y = Math.round(box.y) - padding + oy;
  const width = Math.round(box.width) + 2 * padding;
  const height = Math.round(box.height) + 2 * padding;

  if (ann.type === 'highlight') {
    const radius = ann.radius !== undefined ? ann.radius : 6;
    return { type: 'highlight', x, y, width, height, color, strokeWidth, radius };
  }

  /** @type {BlurGeometry} */
  const g = { type: 'blur', x, y, width, height, blur: ann.blur !== undefined ? ann.blur : 12 };
  if (ann.fill !== undefined) g.fill = ann.fill;
  return g;
}

module.exports = { validateAnnotations, resolveGeometry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/annotate.test.js`
Expected: `ok — validateAnnotations` then `ok — resolveGeometry`, exit 0

- [ ] **Step 5: Verify the full gates**

Run: `npm test && npm run typecheck`
Expected: pass / clean

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/annotate.js scripts/lib/annotate.test.js
git commit -m "feat(annotate): resolveGeometry — selector box → integer draw geometry"
```

---

### Task 3: `overlayHtml` in `scripts/lib/annotate.js`

**Files:**
- Modify: `scripts/lib/annotate.js` (add below `resolveGeometry`)
- Modify (test): `scripts/lib/annotate.test.js` (append)

**Interfaces:**
- Consumes: the `Geometry` typedefs from Task 2.
- Produces: `overlayHtml(geometries: Geometry[]): string`, exported — the innerHTML of the overlay container, elements in array order (drawn back-to-front). Every element is `position:fixed` so nothing shifts page layout. capture.js (Task 4) injects this string verbatim.

Rendering rules: highlight → bordered div (`box-sizing:border-box` so the border sits on the geometry rect); blur without `fill` → `backdrop-filter:blur(Npx)` div (plus `-webkit-` prefix for webkit engines); blur with `fill` → solid `background` div, no blur; arrow → SVG sized to the arrow's own bounding box with a round-capped line (shortened so it doesn't poke through the head) and a triangular head at the tip (head length `4×strokeWidth`, half-width `2×strokeWidth`, SVG margin `3×strokeWidth`).

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/annotate.test.js` (add `overlayHtml` to the require):

```js
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

// Everything is fixed-position (4 geometries → 4 fixed elements).
assert.strictEqual((html.match(/position:fixed/g) || []).length, 4);

// Arrow SVG spans its own bbox: default-left arrow tip(92,210) tail(36,210),
// margin 9 → svg at left:27px top:201px, 74x18.
assert.match(html, /<svg style="position:fixed;left:27px;top:201px" width="74" height="18"/);

console.log('ok — overlayHtml');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/annotate.test.js`
Expected: FAIL with `overlayHtml is not a function`

- [ ] **Step 3: Write the implementation**

Add to `scripts/lib/annotate.js` below `resolveGeometry`, and extend `module.exports`:

```js
/**
 * Render geometries to the innerHTML of the overlay container. Elements in
 * array order (drawn back-to-front), all position:fixed so page layout never
 * shifts. Deterministic: identical input → identical string.
 * @param {Geometry[]} geometries
 * @returns {string}
 */
function overlayHtml(geometries) {
  return geometries.map(geometryHtml).join('');
}

/** @param {Geometry} g */
function geometryHtml(g) {
  if (g.type === 'highlight') {
    return (
      `<div style="position:fixed;left:${g.x}px;top:${g.y}px;width:${g.width}px;height:${g.height}px;` +
      `border:${g.strokeWidth}px solid ${g.color};border-radius:${g.radius}px;box-sizing:border-box"></div>`
    );
  }
  if (g.type === 'blur') {
    const paint =
      g.fill !== undefined
        ? `background:${g.fill}`
        : `backdrop-filter:blur(${g.blur}px);-webkit-backdrop-filter:blur(${g.blur}px)`;
    return (
      `<div style="position:fixed;left:${g.x}px;top:${g.y}px;` +
      `width:${g.width}px;height:${g.height}px;${paint}"></div>`
    );
  }
  return arrowHtml(g);
}

/**
 * Axis-aligned arrow as an SVG covering just the arrow's bounding box: a
 * round-capped line shortened to the head base, and a triangular head at the
 * tip.
 * @param {ArrowGeometry} g
 */
function arrowHtml(g) {
  const { tip, tail, color, strokeWidth } = g;
  const headLen = strokeWidth * 4;
  const headHalf = strokeWidth * 2;
  const margin = strokeWidth * 3; // covers head half-width + round linecap
  const minX = Math.min(tip.x, tail.x) - margin;
  const minY = Math.min(tip.y, tail.y) - margin;
  const width = Math.abs(tip.x - tail.x) + 2 * margin;
  const height = Math.abs(tip.y - tail.y) + 2 * margin;
  // Local (svg) coordinates.
  const t = { x: tip.x - minX, y: tip.y - minY };
  const b = { x: tail.x - minX, y: tail.y - minY };
  // Unit direction tail→tip (axis-aligned by construction).
  const dx = Math.sign(t.x - b.x);
  const dy = Math.sign(t.y - b.y);
  const base = { x: t.x - dx * headLen, y: t.y - dy * headLen };
  const p1 = { x: base.x - dy * headHalf, y: base.y - dx * headHalf };
  const p2 = { x: base.x + dy * headHalf, y: base.y + dx * headHalf };
  return (
    `<svg style="position:fixed;left:${minX}px;top:${minY}px" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="${b.x}" y1="${b.y}" x2="${base.x}" y2="${base.y}" ` +
    `stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>` +
    `<polygon points="${t.x},${t.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="${color}"/>` +
    `</svg>`
  );
}

module.exports = { validateAnnotations, resolveGeometry, overlayHtml };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/annotate.test.js`
Expected: three `ok —` lines, exit 0

- [ ] **Step 5: Verify the full gates**

Run: `npm test && npm run typecheck`
Expected: pass / clean

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/annotate.js scripts/lib/annotate.test.js
git commit -m "feat(annotate): overlayHtml — deterministic overlay markup"
```

---

### Task 4: Wire annotations into `scripts/capture.js`

**Files:**
- Modify: `scripts/capture.js` (imports ~line 25; header comment lines 10–12; `Shot` typedef ~line 47; `validateManifest` ~line 123; `captureShot` ~line 199; exports line 472)
- Modify (test): `scripts/capture.test.js` (require line 8 + append)

**Interfaces:**
- Consumes: `validateAnnotations`, `resolveGeometry`, `overlayHtml` and the `Annotation`/`Geometry` typedefs from `./lib/annotate`; existing `findInPageOrIframe` from `./lib/shopify`.
- Produces: `module.exports = { resolveOutDir, resolveBrowser, checkReadOnly, validateManifest }` (two new exports, used by the test). New internal `applyAnnotations(page, shot)` called from `captureShot`.

- [ ] **Step 1: Write the failing test**

In `scripts/capture.test.js`, change line 8 to:

```js
const { resolveOutDir, resolveBrowser, checkReadOnly, validateManifest } = require('./capture');
```

and append:

```js
// A manifest with valid annotations passes validation (returns; any failure
// would process.exit(1) and fail this suite).
validateManifest(
  {
    app: 'x',
    feature: 'f',
    shots: [
      {
        id: '01-a',
        path: '/admin/apps/x',
        waitFor: '#ready',
        annotate: [
          { type: 'highlight', target: "[data-testid='sov-score']" },
          { type: 'arrow', target: "[data-testid='add-keyword']", side: 'bottom' },
          { type: 'blur', target: "[data-testid='store-email']", fill: '#1a1a1a' },
        ],
      },
    ],
  },
  'test-manifest.json'
);

console.log('ok — validateManifest accepts a valid annotate array');

// Annotate targets are measured, never clicked — a destructive-looking
// selector in an annotation must not trip the read-only guarantee.
checkReadOnly({
  app: 'x',
  feature: 'f',
  shots: [
    {
      id: '01-a',
      path: '/admin/apps/x',
      waitFor: '#ready',
      annotate: [{ type: 'highlight', target: "[data-testid='save-button']" }],
    },
  ],
});

console.log('ok — checkReadOnly ignores annotate targets');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/capture.test.js`
Expected: FAIL with `validateManifest is not a function` (not yet exported)

- [ ] **Step 3: Implement the wiring**

Five edits in `scripts/capture.js`:

**(a)** Header comment — line 10 currently reads:

```
 * Per shot: navigate → run actions → apply wait strategy → screenshot
```

change to:

```
 * Per shot: navigate → run actions → apply wait strategy → inject
 * annotations (if any) → screenshot
```

**(b)** Imports — after the `./lib/shopify` require block, add:

```js
const { validateAnnotations, resolveGeometry, overlayHtml } = require('./lib/annotate');
```

**(c)** `Shot` typedef — add `annotate` to the existing typedef:

```js
 * @typedef {{
 *   id: string, path: string, waitFor: string, waitStrategy?: string,
 *   crop?: string, actions?: Action[], mutation?: boolean, driftCheck?: boolean,
 *   annotate?: import('./lib/annotate').Annotation[],
 * }} Shot
```

**(d)** `validateManifest` — inside the `for (const shot of manifest.shots)` loop, after the `crop` check, add:

```js
    const annErr = validateAnnotations(shot.annotate);
    if (annErr) fail(`shot "${shot.id}": ${annErr}`);
```

**(e)** Annotation step — add this function above `captureShot`:

```js
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
```

and in `captureShot`, immediately after the second `isLoginUrl` check (the "Auth can also expire mid-run" block, before `const file = …`), add:

```js
  if (shot.annotate && shot.annotate.length) {
    await applyAnnotations(page, shot);
  }
```

**(f)** Exports — change the last line to:

```js
module.exports = { resolveOutDir, resolveBrowser, checkReadOnly, validateManifest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/capture.test.js`
Expected: the two existing `ok —` lines plus the two new ones, exit 0

- [ ] **Step 5: Verify the full gates**

Run: `npm test && npm run typecheck`
Expected: pass / clean

- [ ] **Step 6: Commit**

```bash
git add scripts/capture.js scripts/capture.test.js
git commit -m "feat(capture): inject selector-anchored annotations before the screenshot"
```

---

### Task 5: Documentation — manifest schema + SKILL.md

Markdown has no test runner (CLAUDE.md); the capture-affecting behavior is verified live in Task 6.

**Files:**
- Modify: `skills/shopify-apps-doc-writer/references/manifest-schema.md` (shot-object table + new section after "## Actions (v1)")
- Modify: `skills/shopify-apps-doc-writer/SKILL.md` (§2 bullet list)

**Interfaces:**
- Consumes: the schema shipped in Tasks 1–4 — field names and defaults must match `annotate.js` exactly.
- Produces: nothing downstream; these are the authoring contract Claude reads at runtime.

- [ ] **Step 1: Add `annotate` to the shot-object table in `manifest-schema.md`**

Add this row after the `driftCheck` row (before `mutation`):

```
| `annotate` | no | Ordered list of annotations drawn onto this shot at capture time — see [Annotations](#annotations). Default `[]` |
```

- [ ] **Step 2: Add the Annotations section to `manifest-schema.md`**

Insert after the "## Actions (v1)" section (before "## Selector policy (enforced)"):

````markdown
## Annotations

Optional per-shot `annotate` array. Each annotation anchors to a **selector** (same policy and frame transparency as `waitFor` and actions) and is drawn as a browser overlay just before the screenshot — the annotated PNG is the artifact. Determinism holds: an unchanged UI with an unchanged `annotate` list re-captures byte-identical, so `/docs-check` reports no phantom drift. If a target moves or disappears, capture fails with exit `20` instead of drawing a misplaced box. Entries are drawn in order, back-to-front.

```json
"annotate": [
  { "type": "highlight", "target": "[data-testid='sov-score']" },
  { "type": "arrow", "target": "[data-testid='add-keyword']", "side": "left" },
  { "type": "blur", "target": "[data-testid='store-email']", "fill": "#1a1a1a" }
]
```

| Type | Knobs (default) | Renders as |
|---|---|---|
| `highlight` | `color` (`#d72c0d`), `strokeWidth` (3), `radius` (6), `padding` (4) | Rounded rectangle around the target |
| `arrow` | `color` (`#d72c0d`), `strokeWidth` (3), `side` (`"left"`), `length` (56), `gap` (8) | Arrow pointing at the midpoint of the target's given side, tip `gap` px away |
| `blur` | `padding` (0), `blur` (12), `fill` (none) | Frosted blur over the target; setting `fill` makes it an opaque redaction box instead |

All types also take `offset: {x, y}` (px, default 0/0) to nudge the anchored position; `padding` grows the box beyond the element's bounds. Every knob is optional — a bare annotation renders in the house style (Polaris critical red, so annotations read as documentation ink, not app UI).

Annotation targets follow the selector policy but are **exempt from the destructive-pattern check** — they are measured, never interacted with, so highlighting a "Save" button is fine.
````

- [ ] **Step 3: Add authoring guidance to SKILL.md §2**

In "## 2. Manifest authoring — gate 1", insert a new bullet after the "Actions are read-only navigation…" bullet:

```markdown
- Annotations (`annotate`) are optional and sparing — a highlight or arrow only where the merchant's eye genuinely needs directing, and a `blur` over anything merchant-identifying (store name, email, revenue numbers). Targets follow the same selector policy; they're measured, never clicked, so a destructive-looking target (e.g. pointing an arrow at a "Save" button) is fine and won't trip the read-only check.
```

- [ ] **Step 4: Verify gates still pass (no JS touched, cheap sanity)**

Run: `npm test && npm run typecheck`
Expected: pass / clean

- [ ] **Step 5: Commit**

```bash
git add skills/shopify-apps-doc-writer/references/manifest-schema.md skills/shopify-apps-doc-writer/SKILL.md
git commit -m "docs(skill): document the annotate field and authoring guidance"
```

---

### Task 6: Live determinism verification

The spec requires empirical proof: one real capture using all three types, run twice, byte-identical outputs. Config and auth for the `storeseo` app already exist at `~/.config/shopify-apps-doc-writer/`.

**Files:**
- Create (scratch only, not committed): `<scratchpad>/annotate-verify/manifest.json`

**Interfaces:**
- Consumes: the full pipeline from Task 4; the live StoreSEO admin.
- Produces: a pass/fail verdict recorded in the final report — no repo changes.

- [ ] **Step 1: Discover selectors**

The manifest needs real, stable selectors on the StoreSEO app home. Run a probe capture with a generous `waitFor` (e.g. the app iframe having loaded) or use the Playwright MCP browser to snapshot `/admin/apps/storeseo` on the configured store and pick **two** visible elements, preferring `data-testid`, else aria-label/role (never hashed Polaris classes). Record them as `SEL_A` (something to highlight + point at) and `SEL_B` (something to blur).

- [ ] **Step 2: Author the scratch manifest**

Write `<scratchpad>/annotate-verify/manifest.json` (substitute the discovered selectors and the app iframe-visible `waitFor`):

```json
{
  "app": "storeseo",
  "feature": "annotate-verify",
  "browser": "chrome",
  "shots": [
    {
      "id": "01-annotated",
      "path": "/admin/apps/storeseo",
      "waitFor": "SEL_A",
      "crop": "full-admin",
      "caption": "annotation determinism probe",
      "annotate": [
        { "type": "highlight", "target": "SEL_A" },
        { "type": "arrow", "target": "SEL_A", "side": "bottom" },
        { "type": "blur", "target": "SEL_B" }
      ]
    },
    {
      "id": "02-annotated-iframe",
      "path": "/admin/apps/storeseo",
      "waitFor": "SEL_A",
      "crop": "iframe",
      "caption": "annotation determinism probe (iframe crop)",
      "annotate": [
        { "type": "highlight", "target": "SEL_A" },
        { "type": "blur", "target": "SEL_B" }
      ]
    }
  ]
}
```

(All actions absent → nothing for the read-only check to flag; the manifest never touches `docs/` in the repo.)

- [ ] **Step 3: Capture twice and compare bytes**

From the plugin root:

```bash
node scripts/capture.js --manifest <scratchpad>/annotate-verify/manifest.json --app storeseo --out-dir <scratchpad>/annotate-verify/run1
node scripts/capture.js --manifest <scratchpad>/annotate-verify/manifest.json --app storeseo --out-dir <scratchpad>/annotate-verify/run2
shasum -a 256 <scratchpad>/annotate-verify/run1/01-annotated.png <scratchpad>/annotate-verify/run2/01-annotated.png
shasum -a 256 <scratchpad>/annotate-verify/run1/02-annotated-iframe.png <scratchpad>/annotate-verify/run2/02-annotated-iframe.png
```

Expected: both captures exit 0; the two sha256 hashes are **identical** for each shot (full-admin pair and iframe pair).
- Exit 10 → auth expired: pause and ask the user to run `/docs-setup auth`, then re-run.
- Exit 30 → bot challenge: re-run the same commands with `--headed`.
- Hashes differ → this is a bug in the feature's core promise. Do not rationalize it away (e.g. "the page is just dynamic"): first re-run the same manifest **without** `annotate` twice to check whether the base page itself settles byte-stable. If the base is stable but annotated runs differ, the overlay is nondeterministic — debug before proceeding (suspect fractional coordinates or `backdrop-filter` sampling; try the solid-`fill` variant to isolate).

- [ ] **Step 4: Visual sanity check**

Open `run1/01-annotated.png` and confirm: rounded red rectangle around SEL_A, arrow below it pointing up at it, frosted blur over SEL_B, nothing overlapping illegibly. Show the screenshot to the user in the session.

Also open `run1/02-annotated-iframe.png` and confirm the highlight on SEL_A and blur on SEL_B both appear correctly in the iframe-cropped shot too.

- [ ] **Step 5: Record the result**

No commit (nothing in the repo changed). Note the verdict + selector pair used in the task report so the wrap-up can cite it.

---

### Task 7: Release prep — SPEC.md, CHANGELOG, version bump

Per CLAUDE.md: user-visible changes ship only when `version` in `.claude-plugin/plugin.json` changes; bump `package.json` to the same semver; CHANGELOG entry required. Tags/GitHub release happen after merge via the `release` skill — not in this task.

**Files:**
- Modify: `SPEC.md` (v1 non-goals line ~21; §13 "### 0.4 — Annotation pipeline" block ~line 377)
- Modify: `CHANGELOG.md` (new entry under the header block)
- Modify: `.claude-plugin/plugin.json` (`"version": "0.3.0"` → `"0.4.0"`)
- Modify: `package.json` (`"version": "0.3.0"` → `"0.4.0"`)

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–6.
- Produces: the release-ready branch state.

- [ ] **Step 1: Update SPEC.md**

The non-goals line currently reads:

```
- Screenshot annotation (arrows, highlight boxes, blur/redaction) → **0.4 on the v2 roadmap (§13)**.
```

change to:

```
- Screenshot annotation (arrows, highlight boxes, blur/redaction) → **shipped in 0.4.0 (§13)**.
```

Replace the "### 0.4 — Annotation pipeline" block (heading + its paragraph, up to but not including "### 0.5") with:

```markdown
### 0.4 — Annotation pipeline (shipped in 0.4.0)
Optional per-shot `annotate` list in the manifest: highlight rects, arrows,
and blur/redaction boxes. Resolved at design time (see
`docs/superpowers/specs/2026-08-06-annotation-pipeline-design.md`):
**selector-anchored, not raw pixels**, drawn as an in-browser overlay
injected before the screenshot — determinism on re-capture is inherited from
the settle() loop rather than re-implemented in a post-process encoder, and
a moved or missing target fails capture (exit 20) instead of silently
drawing a misplaced box.
```

- [ ] **Step 2: Add the CHANGELOG entry**

Insert after the header block (above `## [0.3.0] - 2026-08-06`):

```markdown
## [0.4.0] - 2026-08-06

### Added

- Per-shot `annotate` list in the shot manifest — `highlight` rectangles,
  `arrow` pointers, and `blur`/redaction boxes, anchored to selectors and
  drawn as an in-browser overlay just before the screenshot. Deterministic on
  re-capture: an unchanged UI with an unchanged `annotate` list produces
  byte-identical PNGs, so `/docs-check` reports no phantom drift. A moved or
  missing target fails capture with exit 20 instead of drawing a misplaced
  box. Every style knob is optional with house defaults; see the manifest
  schema reference for the full table.
```

(If Task 7 lands on a later date than 2026-08-06, use that date.)

- [ ] **Step 3: Bump both versions to 0.4.0**

Edit `"version": "0.3.0"` → `"version": "0.4.0"` in `.claude-plugin/plugin.json` and `package.json`. Verify they match:

```bash
grep '"version"' .claude-plugin/plugin.json package.json
```

Expected: both print `0.4.0`.

- [ ] **Step 4: Verify the full gates one last time**

Run: `npm test && npm run typecheck`
Expected: pass / clean

- [ ] **Step 5: Commit**

```bash
git add SPEC.md CHANGELOG.md .claude-plugin/plugin.json package.json
git commit -m "chore(release): 0.4.0 — annotation pipeline"
```

---

## Completion

After all tasks: run the superpowers:requesting-code-review flow on the branch, then superpowers:finishing-a-development-branch (repo convention is a PR to `main`; the GitHub release itself is the `release` skill's job after merge).

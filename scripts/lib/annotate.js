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

// color/fill land inside a style="" declaration list, so an allowlist is the
// only safe check: a blocklist of quotes and angle brackets still lets ';'
// through, which closes the declaration and injects arbitrary CSS after it.
const COLOR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9a-zA-Z.,%\/ -]*\))$/;

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
      if (ann[knob] !== undefined && !Number.isFinite(ann[knob])) {
        return `${at}.${knob} must be a finite number`;
      }
    }
    if (ann.side !== undefined && !SIDES.includes(ann.side)) {
      return `${at}.side must be one of ${SIDES.join(', ')}`;
    }
    for (const str of ['color', 'fill']) {
      if (ann[str] !== undefined && typeof ann[str] !== 'string') {
        return `${at}.${str} must be a string`;
      }
      if (ann[str] !== undefined && !COLOR.test(ann[str])) {
        return `${at}.${str} is not a color (use #rgb/#rrggbb, rgb()/rgba()/hsl()/hsla(), or a CSS color name)`;
      }
    }
    if (ann.offset !== undefined) {
      if (typeof ann.offset !== 'object' || ann.offset === null) return `${at}.offset must be {x, y}`;
      for (const axis of ['x', 'y']) {
        if (ann.offset[axis] !== undefined && !Number.isFinite(ann.offset[axis])) {
          return `${at}.offset.${axis} must be a finite number`;
        }
      }
    }
  }
  return null;
}

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
  const strokeWidth = Math.round(ann.strokeWidth !== undefined ? ann.strokeWidth : 3);

  if (ann.type === 'arrow') {
    const side = ann.side !== undefined ? ann.side : 'left';
    const length = Math.round(ann.length !== undefined ? ann.length : 56);
    const gap = Math.round(ann.gap !== undefined ? ann.gap : 8);
    const { dx, dy } = AXIS[side];
    const bx = Math.round(box.x);
    const by = Math.round(box.y);
    const bw = Math.round(box.width);
    const bh = Math.round(box.height);
    const midX = bx + (dx === 0 ? bw / 2 : dx === 1 ? bw : 0);
    const midY = by + (dy === 0 ? bh / 2 : dy === 1 ? bh : 0);
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
    const radius = Math.round(ann.radius !== undefined ? ann.radius : 6);
    return { type: 'highlight', x, y, width, height, color, strokeWidth, radius };
  }

  /** @type {BlurGeometry} */
  const g = { type: 'blur', x, y, width, height, blur: ann.blur !== undefined ? ann.blur : 12 };
  if (ann.fill !== undefined) g.fill = ann.fill;
  return g;
}

/**
 * Render geometries to the innerHTML of the overlay container. Elements in
 * array order (drawn back-to-front), all position:absolute so page layout
 * never shifts. Absolute rather than fixed: an element screenshot
 * (`crop: "iframe"`) scrolls its target into view and clips in *document*
 * space, and a fixed overlay does not scroll with it — the container carries
 * the viewport→document offset instead (see applyAnnotations in capture.js).
 * Coordinates here stay in viewport space.
 * Deterministic: identical input → identical string.
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
      `<div style="position:absolute;left:${g.x}px;top:${g.y}px;width:${g.width}px;height:${g.height}px;` +
      `border:${g.strokeWidth}px solid ${g.color};border-radius:${g.radius}px;box-sizing:border-box"></div>`
    );
  }
  if (g.type === 'blur') {
    const paint =
      g.fill !== undefined
        ? `background:${g.fill}`
        : `backdrop-filter:blur(${g.blur}px);-webkit-backdrop-filter:blur(${g.blur}px)`;
    return (
      `<div style="position:absolute;left:${g.x}px;top:${g.y}px;` +
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
  const { x: minX, y: minY, width, height } = geometryBounds(g);
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
    `<svg style="position:absolute;left:${minX}px;top:${minY}px" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="${b.x}" y1="${b.y}" x2="${base.x}" y2="${base.y}" ` +
    `stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>` +
    `<polygon points="${t.x},${t.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="${color}"/>` +
    `</svg>`
  );
}

/**
 * The rect an annotation actually paints, in the same viewport space as
 * resolveGeometry's output. Arrows extend past tip and tail by the head
 * half-width and the round linecap, so they carry a margin.
 * @param {Geometry} g
 * @returns {Box}
 */
function geometryBounds(g) {
  if (g.type !== 'arrow') return { x: g.x, y: g.y, width: g.width, height: g.height };
  const margin = g.strokeWidth * 3; // covers head half-width + round linecap
  return {
    x: Math.min(g.tip.x, g.tail.x) - margin,
    y: Math.min(g.tip.y, g.tail.y) - margin,
    width: Math.abs(g.tip.x - g.tail.x) + 2 * margin,
    height: Math.abs(g.tip.y - g.tail.y) + 2 * margin,
  };
}

/**
 * Why an annotation would not appear correctly in `bounds` — the region the
 * screenshot keeps, in viewport coordinates: the viewport itself for a
 * full-admin shot, the app iframe's rect for `crop: "iframe"`. Returns null
 * if it fits. An annotation that cannot be drawn honestly must fail the
 * capture instead of silently missing from the PNG.
 *
 * Two rules, because we control one shape and not the other. A highlight or
 * blur traces a live element whose size the manifest author cannot choose —
 * a table wider than the crop is still worth boxing — so any overlap passes.
 * An arrow is geometry we synthesise from `side`/`length`/`offset`, and a
 * clipped arrow points from nowhere, so it must fit entirely.
 * @param {Geometry} g
 * @param {Box} bounds
 * @returns {string|null}
 */
function checkGeometryFits(g, bounds) {
  const r = geometryBounds(g);
  if (g.type === 'arrow') {
    const inside =
      r.x >= bounds.x &&
      r.y >= bounds.y &&
      r.x + r.width <= bounds.x + bounds.width &&
      r.y + r.height <= bounds.y + bounds.height;
    return inside
      ? null
      : 'draws an arrow clipped by the capture region — adjust side, length, or offset';
  }
  const overlaps =
    r.x + r.width > bounds.x &&
    r.y + r.height > bounds.y &&
    r.x < bounds.x + bounds.width &&
    r.y < bounds.y + bounds.height;
  return overlaps ? null : 'is outside the capture region';
}

/**
 * The same geometry expressed relative to `origin` — the capture region's
 * top-left corner. Two measurements of an unchanged page taken at different
 * scroll positions have different viewport coordinates but identical relative
 * ones, and the region is what the screenshot keeps: an element screenshot
 * scrolls its target into view and does not reliably restore the scroll
 * afterwards, so comparing raw viewport coordinates would report a moved
 * target on every `crop: "iframe"` shot.
 * @param {Geometry} g
 * @param {Box} origin
 * @returns {Geometry}
 */
function geometryRelativeTo(g, origin) {
  if (g.type === 'arrow') {
    return {
      ...g,
      tip: { x: g.tip.x - origin.x, y: g.tip.y - origin.y },
      tail: { x: g.tail.x - origin.x, y: g.tail.y - origin.y },
    };
  }
  return { ...g, x: g.x - origin.x, y: g.y - origin.y };
}

module.exports = {
  validateAnnotations,
  resolveGeometry,
  overlayHtml,
  geometryBounds,
  checkGeometryFits,
  geometryRelativeTo,
};

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
    const radius = ann.radius !== undefined ? ann.radius : 6;
    return { type: 'highlight', x, y, width, height, color, strokeWidth, radius };
  }

  /** @type {BlurGeometry} */
  const g = { type: 'blur', x, y, width, height, blur: ann.blur !== undefined ? ann.blur : 12 };
  if (ann.fill !== undefined) g.fill = ann.fill;
  return g;
}

module.exports = { validateAnnotations, resolveGeometry };

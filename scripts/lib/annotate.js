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

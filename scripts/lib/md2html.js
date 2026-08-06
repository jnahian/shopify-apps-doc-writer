'use strict';

/**
 * Minimal markdown → HTML for the doc subset the doc template emits:
 * headings, blockquote, ordered/unordered lists, bold, inline code, and
 * screenshot images. Google Drive's create_file converts text/html into a
 * native Google Doc with real heading styles and list numbering.
 *
 * Not a general markdown parser — it handles what `references/doc-template.md`
 * produces and nothing more. If the template grows tables, extend this.
 *
 * Screenshots become placeholder markers: no connected Google Docs API tool
 * can place an inline image, so this is the documented degraded path. In
 * 'inline' image mode (docs-site build) screenshots become real
 * <figure>/<img> elements instead.
 */

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string} s */
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

/** @param {string} s */
const attr = (s) => esc(s).replace(/"/g, '&quot;');

/**
 * @param {string} md      doc markdown (docs/<slug>/index.md)
 * @param {string} slug    feature slug, used in the screenshot placeholder path
 * @param {{images?: 'placeholder'|'inline', wrap?: boolean}} [opts]
 *                         'inline' emits real <img> tags (docs-site build);
 *                         default 'placeholder' is the Google Docs degraded path.
 * @returns {string}       HTML (wrapped in <html><body> unless wrap:false)
 */
function mdToHtml(md, slug, opts = {}) {
  const inlineImages = opts.images === 'inline';
  /** @type {string[]} */
  const out = [];
  /** @type {'ul'|'ol'|null} */
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  /** @param {'ul'|'ol'} kind */
  const openList = (kind) => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };
  // Fold trailing content into the open list item rather than closing the
  // list. Closing it restarts numbering at 1 on the next step — which is
  // exactly what happens when a screenshot sits between two numbered steps.
  /** @param {string} html */
  const appendToLastItem = (html) => {
    const i = out.length - 1;
    out[i] = out[i].replace(/<\/li>$/, `<br>${html}</li>`);
  };

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const img = line.match(/^!\[(.*?)\]\(screenshots\/(.+?)\)$/);
    if (img) {
      if (inlineImages) {
        const fig = `<figure><img src="screenshots/${attr(img[2])}" alt="${attr(img[1])}"><figcaption>${esc(img[1])}</figcaption></figure>`;
        if (list) appendToLastItem(fig);
        else out.push(fig);
      } else {
        const marker = `<i>[Screenshot: ${esc(img[2])} — ${esc(img[1])}. See docs/${slug}/screenshots/ in the repo.]</i>`;
        if (list) appendToLastItem(marker);
        else out.push(`<p>${marker}</p>`);
      }
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith('> ')) {
      closeList();
      out.push(`<p><i>${inline(line.slice(2))}</i></p>`);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      openList('ol');
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    // Indented prose under a numbered step belongs to that step.
    if (list && /^\s/.test(raw)) {
      appendToLastItem(inline(line));
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  const body = out.join('\n');
  return opts.wrap === false ? body : `<html><body>${body}</body></html>`;
}

module.exports = { mdToHtml };

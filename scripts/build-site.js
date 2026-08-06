#!/usr/bin/env node
'use strict';

/**
 * build-site.js — static-site projection of the docs/ tree for internal review.
 *
 * Renders every doc dir (meta.json + index.md) to plain HTML with real inline
 * screenshots, plus a root index listing every doc with a DRAFT badge. The
 * output dir is handed to `npx wrangler pages deploy` by /docs-deploy and then
 * discarded — nothing site-related is committed to any repo.
 *
 * Emits a human report to stderr and machine-readable JSON to stdout (same
 * contract style as update-check.js). Exit 1 when zero docs were built.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, resolveAppKey, loadConfig } = require('./lib/config');
const { mdToHtml } = require('./lib/md2html');

const CSS = `body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
img { max-width: 100%; border: 1px solid #ddd; border-radius: 6px; }
figure { margin: 1rem 0; }
figcaption { font-size: 0.85rem; color: #666; }
nav { margin-bottom: 2rem; }
nav a { text-decoration: none; }
.badge { background: #b45309; color: #fff; font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; vertical-align: middle; letter-spacing: 0.05em; }
ul.docs { list-style: none; padding: 0; }
ul.docs li { padding: 0.5rem 0; border-bottom: 1px solid #ddd; }
ul.docs time { color: #666; font-size: 0.85rem; float: right; }
code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
`;

/** @param {unknown} s */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Draftness here keys off meta.status (draft|approved|published); the
// update-check sweep keys off meta.publish.url. SKILL.md sets both at publish
// time, so they agree unless meta.json was hand-edited.
/** @param {string} status */
const badge = (status) => (status === 'published' ? '' : ' <span class="badge">DRAFT</span>');

/** @param {{title: string, cssHref: string, nav: string, body: string}} parts */
function shell({ title, cssHref, nav, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
${nav}
<main>
${body}
</main>
</body>
</html>
`;
}

/** @param {{docsDir: string, outDir: string, siteTitle?: string}} opts */
function buildSite({ docsDir, outDir, siteTitle = 'Docs' }) {
  /** @type {Array<{slug: string, title: string, status: string, date: string}>} */
  const built = [];
  /** @type {Array<{dir: string, reason: string}>} */
  const skipped = [];

  const entries = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];

  for (const e of entries) {
    const dir = path.join(docsDir, e.name);
    const metaPath = path.join(dir, 'meta.json');
    const mdPath = path.join(dir, 'index.md');
    if (!fs.existsSync(metaPath)) { skipped.push({ dir: e.name, reason: 'no meta.json' }); continue; }
    if (!fs.existsSync(mdPath)) { skipped.push({ dir: e.name, reason: 'no index.md' }); continue; }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      skipped.push({ dir: e.name, reason: 'meta.json is not valid JSON' });
      continue;
    }

    const slug = meta.slug || e.name;
    const status = meta.status || 'draft';
    const title = meta.title || slug;
    const content = mdToHtml(fs.readFileSync(mdPath, 'utf8'), slug, { images: 'inline', wrap: false });

    const docOut = path.join(outDir, e.name);
    fs.mkdirSync(docOut, { recursive: true });
    fs.writeFileSync(
      path.join(docOut, 'index.html'),
      shell({
        title,
        cssHref: '../style.css',
        nav: `<nav><a href="../index.html">← All docs</a>${badge(status)}</nav>`,
        body: content,
      })
    );
    const shotsDir = path.join(dir, 'screenshots');
    if (fs.existsSync(shotsDir)) fs.cpSync(shotsDir, path.join(docOut, 'screenshots'), { recursive: true });

    built.push({
      slug: e.name,
      title,
      status,
      date: ((meta.publish && meta.publish.publishedAt) || meta.createdAt || '').slice(0, 10),
    });
  }

  // Zero docs built → write nothing at all; a caller-supplied outDir must not
  // be polluted with a stylesheet and an empty index.
  if (built.length === 0) return { outDir, built, skipped };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS);

  built.sort((a, b) => a.title.localeCompare(b.title));
  const items = built
    .map(
      (d) =>
        `<li><a href="${esc(d.slug)}/index.html">${esc(d.title)}</a>${badge(d.status)}${d.date ? ` <time>${esc(d.date)}</time>` : ''}</li>`
    )
    .join('\n');
  fs.writeFileSync(
    path.join(outDir, 'index.html'),
    shell({
      title: siteTitle,
      cssHref: 'style.css',
      nav: '',
      body: `<h1>${esc(siteTitle)}</h1>\n<ul class="docs">\n${items}\n</ul>`,
    })
  );

  return { outDir, built, skipped };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appKey = resolveAppKey(/** @type {string|undefined} */ (args.app));
  const config = loadConfig(appKey);
  const docsDir = path.resolve(config.capture.outputDir);
  // Only a dir we created is ours to delete on the zero-docs path.
  const ownsOutDir = !args.out;
  const outDir = ownsOutDir
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'))
    : path.resolve(String(args.out));

  const report = Object.assign(buildSite({ docsDir, outDir, siteTitle: `${appKey} docs` }), {
    pagesProject: (config.deploy && config.deploy.pagesProject) || `${appKey}-docs`,
  });

  if (report.built.length === 0) {
    console.error(`No docs found in ${docsDir} — nothing to build.`);
    if (ownsOutDir) fs.rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }

  const drafts = report.built.filter((d) => d.status !== 'published').length;
  console.error(`Built ${report.built.length} doc(s) (${drafts} draft) → ${outDir}`);
  for (const s of report.skipped) console.error(`  skipped ${s.dir}: ${s.reason}`);
  console.log(JSON.stringify(report));
}

if (require.main === module) main();

module.exports = { buildSite };

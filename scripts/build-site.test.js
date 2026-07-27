#!/usr/bin/env node
'use strict';

/**
 * Self-check for buildSite. Run: node scripts/build-site.test.js
 *
 * Builds a fixture docs dir (one published doc, one draft, one malformed dir)
 * and asserts the projection: index listing, DRAFT badge only on the draft,
 * real <img> tags, screenshots copied, malformed dir skipped not crashed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite } = require('./build-site');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-site-test-'));
const docsDir = path.join(root, 'docs');
const outDir = path.join(root, 'out');

function writeDoc(slug, meta, md) {
  const dir = path.join(docsDir, slug);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'index.md'), md);
  fs.writeFileSync(path.join(dir, 'screenshots', '01-shot.png'), 'fake-png-bytes');
}

writeDoc(
  'alpha-feature',
  {
    title: 'Alpha Feature',
    slug: 'alpha-feature',
    status: 'published',
    createdAt: '2026-07-01T00:00:00Z',
    publish: { publishedAt: '2026-07-20T10:00:00Z' },
  },
  '# Alpha Feature\n\n1. Do the thing.\n\n   ![the thing](screenshots/01-shot.png)\n'
);
writeDoc(
  'beta-feature',
  { title: 'Beta Feature', slug: 'beta-feature', status: 'draft', createdAt: '2026-07-22T00:00:00Z' },
  '# Beta Feature\n\nStill cooking.\n'
);
// Malformed: a directory with no meta.json must be skipped, not crash the build.
fs.mkdirSync(path.join(docsDir, 'not-a-doc'));

const report = buildSite({ docsDir, outDir, siteTitle: 'storeseo docs' });

assert.strictEqual(report.built.length, 2, 'two docs built');
assert.deepStrictEqual(
  report.skipped,
  [{ dir: 'not-a-doc', reason: 'no meta.json' }],
  'malformed dir skipped with a reason'
);

const index = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
assert.ok(index.includes('<a href="alpha-feature/index.html">Alpha Feature</a>'), 'index links the doc');
assert.ok(index.includes('Beta Feature'), 'index lists the draft too');
assert.strictEqual((index.match(/class="badge"/g) || []).length, 1, 'DRAFT badge on the draft only');
assert.ok(index.includes('<time>2026-07-20</time>'), 'published doc shows publishedAt date');
assert.ok(index.includes('<time>2026-07-22</time>'), 'draft falls back to createdAt');

const alpha = fs.readFileSync(path.join(outDir, 'alpha-feature', 'index.html'), 'utf8');
assert.ok(alpha.includes('<img src="screenshots/01-shot.png"'), 'doc page has a real <img>');
assert.ok(!alpha.includes('[Screenshot:'), 'no placeholder markers on the site');
assert.ok(alpha.includes('<title>Alpha Feature</title>'), 'page title from meta');
assert.ok(alpha.includes('href="../index.html"'), 'back link to the index');
assert.ok(!alpha.includes('class="badge"'), 'no DRAFT badge on the published doc page');

const beta = fs.readFileSync(path.join(outDir, 'beta-feature', 'index.html'), 'utf8');
assert.ok(beta.includes('class="badge"'), 'DRAFT badge on the draft doc page');

assert.ok(fs.existsSync(path.join(outDir, 'alpha-feature', 'screenshots', '01-shot.png')), 'screenshots copied');
assert.ok(fs.existsSync(path.join(outDir, 'style.css')), 'shared stylesheet written');

// --- CLI: a user-supplied --out dir is never deleted, even with zero docs ---
// (the tmp dir the CLI creates itself is; a caller's dir is not ours to remove)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'build-site-home-'));
const cfgDir = path.join(home, '.config', 'shopify-apps-doc-writer');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, 'testapp.json'),
  JSON.stringify({ store: 'x.myshopify.com', appHandle: 'x', capture: { outputDir: path.join(home, 'empty-docs') } })
);
const keepMe = path.join(home, 'precious');
fs.mkdirSync(keepMe);
fs.writeFileSync(path.join(keepMe, 'notes.txt'), 'do not delete me');

const cli = require('child_process').spawnSync(
  process.execPath,
  [path.join(__dirname, 'build-site.js'), '--app', 'testapp', '--out', keepMe],
  { env: { ...process.env, HOME: home }, encoding: 'utf8' }
);

assert.strictEqual(cli.status, 1, 'zero docs exits 1');
assert.ok(fs.existsSync(path.join(keepMe, 'notes.txt')), 'a --out dir the caller owns survives the zero-docs path');

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log('ok — buildSite projects docs/ into a static site with badges and real images');

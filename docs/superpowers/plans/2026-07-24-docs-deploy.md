# `/docs-deploy` Internal Docs Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/docs-deploy` command that renders all `docs/*/` docs to a minimal static site and deploys it to a per-app Cloudflare Pages project for internal team review.

**Architecture:** One deterministic Node script (`scripts/build-site.js`) projects `docs/*/{index.md, meta.json, screenshots/}` into a temp dir of plain HTML using the plugin's existing `md2html.js` (extended with an inline-image mode); one markdown command (`commands/docs-deploy.md`) instructs Claude to build, confirm with the user (external-write gate), then deploy via `npx wrangler pages deploy`. Spec: `docs/superpowers/specs/2026-07-24-docs-site-deploy-design.md`.

**Tech Stack:** Node ≥ 20 (CommonJS, `'use strict'`), plain-`assert` self-check tests, wrangler via `npx` (never a package dependency).

## Global Constraints

- **No new npm dependencies.** wrangler runs via `npx`; everything else is Node stdlib.
- **Google Docs publish path unchanged:** `mdToHtml(md, slug)` with no options must behave byte-identically to today (placeholder markers, `<html><body>` wrapper).
- **`docs/*/` is read-only** to this feature; `meta.json` is never written.
- **Config is per-user, never committed.** New optional key: `deploy.pagesProject` (default `<appKey>-docs`).
- **The deploy confirmation gate is non-skippable and never auto-approved** — same philosophy as gate #3 in `commands/write-docs.md`.
- Scripts emit a human report to **stderr** and machine-readable JSON to **stdout** (same contract as `scripts/update-check.js`).
- Tests are plain `assert` scripts run with `node <file>`; no test framework.
- Match existing style: `'use strict'`, `const` fns, minimal comments (only non-obvious constraints).

---

### Task 1: `md2html.js` inline-image and wrap options

**Files:**
- Modify: `scripts/lib/md2html.js`
- Test: `scripts/lib/md2html.test.js` (append cases)

**Interfaces:**
- Consumes: existing `mdToHtml(md, slug)`.
- Produces: `mdToHtml(md, slug, opts)` where `opts = { images?: 'placeholder'|'inline', wrap?: boolean }`, defaults `{ images: 'placeholder', wrap: true }`. `images: 'inline'` renders screenshot lines as `<figure><img src="screenshots/<file>" alt="<caption>"><figcaption><caption></figcaption></figure>`. `wrap: false` returns the joined blocks without the `<html><body>` wrapper. Task 2 calls `mdToHtml(md, slug, { images: 'inline', wrap: false })`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `scripts/lib/md2html.test.js` (before the final `console.log` line):

```js
// --- Site mode: real inline images, no document wrapper -------------------

const site = mdToHtml(MD, 'my-feature', { images: 'inline', wrap: false });

assert.ok(!site.startsWith('<html>'), 'wrap:false omits the <html><body> wrapper');
assert.ok(!site.includes('[Screenshot:'), 'inline mode emits no placeholder markers');
assert.ok(
  site.includes(
    '<figure><img src="screenshots/01-navigate.png" alt="a caption"><figcaption>a caption</figcaption></figure>'
  ),
  'inline mode emits a real <img> with figcaption'
);
// The numbering trap must hold in inline mode too.
assert.strictEqual((site.match(/<ol>/g) || []).length, 1, 'inline image must not split the ordered list');

// A standalone image is a bare <figure>, not nested inside <p>.
const bare = mdToHtml('![cap](screenshots/02-x.png)', 'x', { images: 'inline' });
assert.ok(bare.includes('<figure><img src="screenshots/02-x.png" alt="cap">'), 'standalone inline image');
assert.ok(!bare.includes('<p><figure>'), 'figure must not be wrapped in <p>');

// Quotes in captions must not break the alt attribute.
const quoted = mdToHtml('!["hi"](screenshots/03-x.png)', 'x', { images: 'inline' });
assert.ok(quoted.includes('alt="&quot;hi&quot;"'), 'quotes escaped in alt');

// Defaults unchanged: no third argument behaves exactly as before.
assert.strictEqual(mdToHtml(MD, 'my-feature'), html, 'default call unchanged by the new options');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/md2html.test.js`
Expected: FAIL — first new assertion throws (`wrap:false omits the <html><body> wrapper`), because the third argument is ignored today.

- [ ] **Step 3: Implement the options**

In `scripts/lib/md2html.js`:

3a. After the `inline` helper (line ~21), add:

```js
const attr = (s) => esc(s).replace(/"/g, '&quot;');
```

3b. Change the function signature and JSDoc:

```js
/**
 * @param {string} md      doc markdown (docs/<slug>/index.md)
 * @param {string} slug    feature slug, used in the screenshot placeholder path
 * @param {object} [opts]  { images: 'placeholder'|'inline', wrap: boolean }
 *                         'inline' emits real <img> tags (docs-site build);
 *                         default 'placeholder' is the Google Docs degraded path.
 * @returns {string}       HTML (wrapped in <html><body> unless wrap:false)
 */
function mdToHtml(md, slug, opts = {}) {
  const inlineImages = opts.images === 'inline';
```

3c. Replace the `if (img) { ... }` block body with:

```js
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
```

3d. Replace the final return:

```js
  closeList();
  const body = out.join('\n');
  return opts.wrap === false ? body : `<html><body>${body}</body></html>`;
```

3e. Update the file's top comment: change the last paragraph to note both modes, e.g. append: `In 'inline' image mode (docs-site build) screenshots become real <figure>/<img> elements instead.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/lib/md2html.test.js`
Expected: PASS — prints `ok — mdToHtml keeps numbering intact and converts the template subset`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/md2html.js scripts/lib/md2html.test.js
git commit -m "feat(md2html): inline-image and wrap options for the docs-site build"
```

---

### Task 2: `build-site.js` — site builder core

**Files:**
- Create: `scripts/build-site.js`
- Test: `scripts/build-site.test.js`

**Interfaces:**
- Consumes: `mdToHtml(md, slug, { images: 'inline', wrap: false })` from Task 1; `parseArgs`, `resolveAppKey`, `loadConfig` from `scripts/lib/config.js` (existing).
- Produces: `buildSite({ docsDir, outDir, siteTitle })` → `{ outDir, built: [{slug, title, status, date}], skipped: [{dir, reason}] }`, exported via `module.exports = { buildSite }`. CLI (`main`) is added in this same task; Task 3's command parses the CLI's stdout JSON, which additionally carries `pagesProject`.

- [ ] **Step 1: Write the failing test**

Create `scripts/build-site.test.js`:

```js
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

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — buildSite projects docs/ into a static site with badges and real images');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/build-site.test.js`
Expected: FAIL with `Cannot find module './build-site'`

- [ ] **Step 3: Implement `scripts/build-site.js`**

```js
#!/usr/bin/env node
'use strict';

/**
 * build-site.js — static-site projection of docs/*/ for internal review.
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
.badge::before { content: "DRAFT"; }
ul.docs { list-style: none; padding: 0; }
ul.docs li { padding: 0.5rem 0; border-bottom: 1px solid #ddd; }
ul.docs time { color: #666; font-size: 0.85rem; float: right; }
code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
`;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const badge = (status) => (status === 'published' ? '' : ' <span class="badge"></span>');

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

function buildSite({ docsDir, outDir, siteTitle = 'Docs' }) {
  const built = [];
  const skipped = [];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS);

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
  const appKey = resolveAppKey(args.app);
  const config = loadConfig(appKey);
  const docsDir = path.resolve(config.capture.outputDir);
  const outDir = args.out
    ? path.resolve(args.out)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'));

  const report = buildSite({ docsDir, outDir, siteTitle: `${appKey} docs` });
  report.pagesProject = (config.deploy && config.deploy.pagesProject) || `${appKey}-docs`;

  if (report.built.length === 0) {
    console.error(`No docs found in ${docsDir} — nothing to build.`);
    fs.rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }

  const drafts = report.built.filter((d) => d.status !== 'published').length;
  console.error(`Built ${report.built.length} doc(s) (${drafts} draft) → ${outDir}`);
  for (const s of report.skipped) console.error(`  skipped ${s.dir}: ${s.reason}`);
  console.log(JSON.stringify(report));
}

if (require.main === module) main();

module.exports = { buildSite };
```

Note: the DRAFT text lives in CSS (`.badge::before`) so the badge markup stays one empty span; the test asserts on `class="badge"`, which works for both index and doc pages.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/build-site.test.js && node scripts/lib/md2html.test.js`
Expected: both print their `ok — …` line.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site.js scripts/build-site.test.js
git commit -m "feat(build-site): static-site projection of docs/ for internal review"
```

---

### Task 3: `/docs-deploy` command

**Files:**
- Create: `commands/docs-deploy.md`

**Interfaces:**
- Consumes: `node scripts/build-site.js --app <key>` CLI from Task 2 — stdout JSON `{ outDir, built: [{slug,title,status,date}], skipped: [{dir,reason}], pagesProject }`, exit 1 when zero docs.
- Produces: the user-facing `/docs-deploy` command.

- [ ] **Step 1: Write `commands/docs-deploy.md`**

````md
---
description: Build the internal docs site from docs/ and deploy it to Cloudflare Pages
argument-hint: "[--app <key>]"
---

Deploy every doc under `docs/` to the app's internal review site on Cloudflare
Pages. Follow these steps exactly; the confirmation gate is non-skippable.

## 1. Build

Run:

```bash
node scripts/build-site.js --app <key>
```

Parse the JSON printed on stdout: `{ outDir, built, skipped, pagesProject }`.

- Exit 1 means no docs were found — tell the user there is nothing to deploy
  and stop.
- Report what was built: doc count, how many are drafts
  (`status !== "published"`), and any `skipped` dirs with their reasons.

## 2. Confirm (external-write gate — never auto-approved)

Deploying publishes to a URL anyone with the link can view. Show the exact
summary and require an explicit yes:

> Deploy N docs (M drafts) to Cloudflare Pages project `<pagesProject>` →
> https://<pagesProject>.pages.dev. Proceed?

If the user declines: `rm -rf <outDir>` and stop. Nothing was deployed.

## 3. Deploy

```bash
npx wrangler pages deploy <outDir> --project-name <pagesProject> --commit-dirty=true
```

First-run fallbacks:

- **Not authenticated** (wrangler reports it needs login): tell the user to
  run `! npx wrangler login` themselves (interactive OAuth — the plugin never
  touches Cloudflare tokens), then retry the deploy command.
- **Project does not exist**: create it, then retry the deploy. This is part
  of the deploy the user already confirmed — no second gate.

  ```bash
  npx wrangler pages project create <pagesProject> --production-branch main
  ```

- Any other failure: show wrangler's error verbatim and stop. Nothing local
  changed.

## 4. Wrap up

- Print the deployment URL from wrangler's output.
- Delete the build dir: `rm -rf <outDir>`.
- Remind the user drafts are visible on the site with a DRAFT badge.

## Notes

- The site is a projection: canonical content stays `docs/<slug>/index.md`.
  `meta.json` is not modified by this command — per-doc `publish` fields keep
  their existing meaning (Google Docs / MCP target).
- Project name comes from per-user config `deploy.pagesProject`, defaulting to
  `<appKey>-docs`. To change it, edit
  `~/.config/shopify-apps-doc-writer/<app-key>.json`.
````

- [ ] **Step 2: Verify the build half end-to-end (no deploy)**

If a real per-user config exists (dogfooding setup), run:

```bash
node scripts/build-site.js --app storeseo --out /tmp/docs-site-smoke
```

Expected: stderr `Built N doc(s) (M draft) → /tmp/docs-site-smoke`, stdout JSON with `pagesProject`. Open `/tmp/docs-site-smoke/index.html` in a browser and eyeball it, then `rm -rf /tmp/docs-site-smoke`. If no config/docs exist in this environment, skip — the fixture test in Task 2 covers the build; the wrangler half is verified by the user's first real `/docs-deploy` run.

- [ ] **Step 3: Commit**

```bash
git add commands/docs-deploy.md
git commit -m "feat(docs-deploy): /docs-deploy command — build + gated Pages deploy"
```

---

### Task 4: Documentation updates

**Files:**
- Modify: `README.md` (How-it-works block ~line 10, Layout block ~line 66)
- Modify: `CLAUDE.md` (Commands section)

**Interfaces:**
- Consumes: command/script names from Tasks 2–3. No code.

- [ ] **Step 1: Update `README.md`**

In the "How it works" fenced block, after the `/update-docs` line, add:

```
/docs-deploy           build internal docs site → confirm → Cloudflare Pages URL
```

In the "Layout" fenced block, change the `commands/` line to:

```
commands/                            /docs-setup · /write-docs · /update-docs · /docs-deploy
```

and after the `scripts/update-check.js` line add:

```
scripts/build-site.js                docs/ → static site for /docs-deploy (Cloudflare Pages)
```

In the "v2 backlog" paragraph, remove `docs-site publish targets` from the list (it now exists).

- [ ] **Step 2: Update `CLAUDE.md`**

In the first commands fenced block, after the `capture.js` line, add:

```bash
node scripts/build-site.js --app <key> [--out <dir>]   # docs/ → static site; deployed by /docs-deploy via npx wrangler
```

In the self-check block, add:

```bash
node scripts/build-site.test.js     # site projection (badges, inline images, skip handling)
```

- [ ] **Step 3: Run all self-checks**

Run: `node scripts/lib/md2html.test.js && node scripts/build-site.test.js && node scripts/lib/shopify.test.js`
Expected: three `ok — …` lines.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document /docs-deploy and build-site.js"
```

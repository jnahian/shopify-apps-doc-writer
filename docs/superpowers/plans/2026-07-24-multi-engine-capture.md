# Multi-Engine Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `capture.js` run under any Playwright engine (`chromium`/`firefox`/`webkit`) plus branded channels (`chrome`/`msedge`), selected via CLI > manifest > config > default `chrome`, with auto-install for downloadable engines.

**Architecture:** A pure resolver function in `capture.js` maps a browser name to a Playwright engine + optional channel and applies the precedence chain. The launch block uses the resolved spec; on launch failure it auto-installs downloadable engines (`npx playwright install <name>`) and retries once, or prints a vendor-install message for system browsers. Auth is untouched — login stays real-Chrome-over-CDP; the engine-portable `storageState` is injected into whichever engine captures.

**Tech Stack:** Node ≥ 20, `playwright` npm package (no new dependencies), plain-`assert` self-check tests.

**Spec:** `docs/superpowers/specs/2026-07-24-multi-engine-capture-design.md`

## Global Constraints

- Valid browser names, exactly: `chrome` (default) | `msedge` | `chromium` | `firefox` | `webkit`.
- Precedence, exactly: `--browser` CLI flag > `manifest.browser` > `config.capture.browser` > `'chrome'`.
- Exit codes are a documented contract: `10` auth expired, `20` selector timeout, `1` everything else. Do not add or change codes.
- `setup-auth.js` is NOT modified — login stays real-Chrome-over-CDP, verification shot stays `channel:'chrome'`.
- No new npm dependencies.
- Read-only guarantee (`DESTRUCTIVE_PATTERN`) and selector policy: untouched.
- Tests are plain-`assert` scripts run with `node`, no test framework.

---

### Task 1: Browser resolver (pure function + tests)

**Files:**
- Modify: `scripts/capture.js` (add `BROWSERS` map + `resolveBrowser` near `resolveOutDir` at line ~206; extend `module.exports` at line 328)
- Test: `scripts/capture.test.js`

**Interfaces:**
- Consumes: nothing new — `args` from `parseArgs` (`scripts/lib/config.js`), parsed `manifest`, loaded `config`.
- Produces: `resolveBrowser(args, manifest, config)` → `{ name: string, engine: 'chromium'|'firefox'|'webkit', channel?: 'chrome'|'msedge' }`. Throws `Error` with a message listing valid names on an unknown name. Task 2 calls this in `main()`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/capture.test.js` (note: line 8 currently destructures only `resolveOutDir` — change it to also pull `resolveBrowser`):

```js
const { resolveOutDir, resolveBrowser } = require('./capture');
```

and at the end of the file:

```js
// resolveBrowser: precedence CLI > manifest > config > default 'chrome'.
assert.deepStrictEqual(
  resolveBrowser({}, {}, {}),
  { name: 'chrome', engine: 'chromium', channel: 'chrome' },
  'default is chrome'
);
assert.deepStrictEqual(
  resolveBrowser({}, {}, { capture: { browser: 'webkit' } }),
  { name: 'webkit', engine: 'webkit' },
  'config beats default'
);
assert.deepStrictEqual(
  resolveBrowser({}, { browser: 'firefox' }, { capture: { browser: 'webkit' } }),
  { name: 'firefox', engine: 'firefox' },
  'manifest beats config'
);
assert.deepStrictEqual(
  resolveBrowser({ browser: 'msedge' }, { browser: 'firefox' }, { capture: { browser: 'webkit' } }),
  { name: 'msedge', engine: 'chromium', channel: 'msedge' },
  'CLI beats manifest'
);
assert.deepStrictEqual(
  resolveBrowser({ browser: 'chromium' }, {}, {}),
  { name: 'chromium', engine: 'chromium' },
  'bare chromium has no channel'
);
assert.throws(
  () => resolveBrowser({ browser: 'safari' }, {}, {}),
  /Unknown browser "safari".*chrome, msedge, chromium, firefox, webkit/s,
  'unknown name throws listing valid names'
);

console.log('ok — resolveBrowser precedence and validation');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/capture.test.js`
Expected: FAIL — `TypeError: resolveBrowser is not a function`

- [ ] **Step 3: Write the implementation**

In `scripts/capture.js`, directly above `resolveOutDir` (line ~206):

```js
const BROWSERS = {
  chrome: { engine: 'chromium', channel: 'chrome' },
  msedge: { engine: 'chromium', channel: 'msedge' },
  chromium: { engine: 'chromium' },
  firefox: { engine: 'firefox' },
  webkit: { engine: 'webkit' },
};

/** Precedence: --browser CLI > manifest.browser > config.capture.browser > 'chrome'. */
function resolveBrowser(args, manifest, config) {
  const name =
    args.browser || manifest.browser || (config.capture && config.capture.browser) || 'chrome';
  const spec = BROWSERS[name];
  if (!spec) {
    throw new Error(
      `Unknown browser "${name}". Valid values: ${Object.keys(BROWSERS).join(', ')}`
    );
  }
  return { name, ...spec };
}
```

And change the last line of the file:

```js
module.exports = { resolveOutDir, resolveBrowser };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/capture.test.js`
Expected: PASS — both `ok —` lines print, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/capture.js scripts/capture.test.js
git commit -m "feat(capture): browser resolver with CLI > manifest > config > default precedence"
```

---

### Task 2: Launch with resolved engine + auto-install; config default fix

**Files:**
- Modify: `scripts/capture.js` (launch block, lines 251–289; add `spawnSync` import at line ~22; usage line at line ~215)
- Modify: `scripts/lib/config.js:15` (`browser: 'chromium'` → `browser: 'chrome'`)

**Interfaces:**
- Consumes: `resolveBrowser(args, manifest, config)` from Task 1 (exact shape: `{ name, engine, channel? }`).
- Produces: no new exports. Behavior: `node scripts/capture.js --manifest <m> --app <k> [--browser <name>]` launches the resolved engine; missing `chromium`/`firefox`/`webkit` auto-installs then retries once.

- [ ] **Step 1: Add the `--browser` flag to the usage string**

`scripts/capture.js` line ~215, replace:

```js
    console.error(
      'Usage: node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--out-dir <dir>] [--headed]'
    );
```

with:

```js
    console.error(
      'Usage: node scripts/capture.js --manifest docs/<slug>/manifest.json --app <key> [--only <shot-id>] [--out-dir <dir>] [--browser chrome|msedge|chromium|firefox|webkit] [--headed]'
    );
```

Also update the header comment's Usage line (line 8) the same way.

- [ ] **Step 2: Add the child_process import**

At line ~22, after `const path = require('path');`:

```js
const { spawnSync } = require('child_process');
```

- [ ] **Step 3: Replace the launch block**

In `main()`, replace lines 251–276 (from `let chromium;` through the closing `}` of the `Could not launch Google Chrome` catch) with:

```js
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.error('Playwright is not installed. From the plugin root run:\n  npm install');
    process.exit(1);
  }

  let spec;
  try {
    spec = resolveBrowser(args, manifest, config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Capture loads an already-authenticated session, so the login-page
  // automation detection that forces CDP in setup-auth doesn't apply here —
  // any engine works against the saved storageState (chrome validated
  // 2026-07-24; storageState is engine-portable JSON).
  const engine = playwright[spec.engine];
  const launchOpts = {
    headless: args.headed ? false : config.capture.headless !== false,
  };
  if (spec.channel) launchOpts.channel = spec.channel;

  let browser;
  try {
    browser = await engine.launch(launchOpts);
  } catch (err) {
    if (spec.channel) {
      // System browsers can't be auto-installed.
      const vendorUrl =
        spec.name === 'msedge'
          ? 'https://www.microsoft.com/edge/'
          : 'https://www.google.com/chrome/';
      console.error(
        `Could not launch ${spec.name}: ${err.message}\n` +
          `Capture uses your installed browser — get it from ${vendorUrl}`
      );
      process.exit(1);
    }
    console.error(`${spec.name} is not installed — running: npx playwright install ${spec.name}`);
    const install = spawnSync('npx', ['playwright', 'install', spec.name], { stdio: 'inherit' });
    if (install.status !== 0) {
      console.error(`playwright install ${spec.name} failed (exit ${install.status}).`);
      process.exit(1);
    }
    try {
      browser = await engine.launch(launchOpts);
    } catch (err2) {
      console.error(`Could not launch ${spec.name} after install: ${err2.message}`);
      process.exit(1);
    }
  }
```

- [ ] **Step 4: Include the browser in the run banner**

Replace the `console.log` at lines ~286–289:

```js
  console.log(
    `Capturing ${shots.length} shot(s) for "${manifest.feature}" ` +
      `(${config.store}, ${spec.name}, viewport ${viewport.width}x${viewport.height})`
  );
```

- [ ] **Step 5: Fix the dead config default**

`scripts/lib/config.js` line 15, replace:

```js
    browser: 'chromium',
```

with:

```js
    browser: 'chrome',
```

- [ ] **Step 6: Run all self-checks**

Run:

```bash
node scripts/capture.test.js
node scripts/lib/shopify.test.js
node scripts/lib/md2html.test.js
node scripts/update-check.test.js
```

Expected: all print `ok` lines, exit 0.

- [ ] **Step 7: Smoke-check the error path (no live auth needed)**

Run: `node scripts/capture.js --manifest /nonexistent.json --browser safari`
Expected: `Manifest not found: /nonexistent.json` (manifest check runs first — that's fine; it proves the flag parses without crashing).

Run: `node -e "const {resolveBrowser}=require('./scripts/capture'); try { resolveBrowser({browser:'safari'},{},{}) } catch(e) { console.log(e.message) }"`
Expected: `Unknown browser "safari". Valid values: chrome, msedge, chromium, firefox, webkit`

- [ ] **Step 8: Commit**

```bash
git add scripts/capture.js scripts/lib/config.js
git commit -m "feat(capture): launch resolved engine with auto-install for chromium/firefox/webkit"
```

---

### Task 3: Documentation consistency updates

**Files:**
- Modify: `skills/shopify-apps-doc-writer/references/manifest-schema.md` (top-level shape, lines 7–21)
- Modify: `skills/shopify-apps-doc-writer/SKILL.md:57`
- Modify: `SPEC.md:334`
- Modify: `commands/docs-setup.md:21`

**Interfaces:**
- Consumes: the browser names and precedence from Task 1 (must match exactly: `chrome`, `msedge`, `chromium`, `firefox`, `webkit`).
- Produces: nothing code-facing — keeps the repo's documented contracts in sync (a stated coupling rule in CLAUDE.md).

- [ ] **Step 1: Add `browser` to the manifest schema**

In `skills/shopify-apps-doc-writer/references/manifest-schema.md`, replace the top-level example (lines 7–14):

```json
{
  "app": "storeseo",
  "feature": "ai-brand-visibility",
  "viewport": { "width": 1440, "height": 900 },
  "browser": "chrome",
  "shots": [ … ]
}
```

and add a row to the field table after the `viewport` row (line 20):

```markdown
| `browser` | no | Pins the rendering engine for this manifest so re-capture reproduces the doc's original look: `chrome` (default) \| `msedge` \| `chromium` \| `firefox` \| `webkit`. Precedence: `--browser` CLI flag > manifest > config `capture.browser` > `chrome`. |
```

- [ ] **Step 2: Update the stale install hint in SKILL.md**

`skills/shopify-apps-doc-writer/SKILL.md` line 57, replace:

```markdown
- If Playwright's browser is missing, the script prints the `npx playwright install chromium` hint — relay it.
```

with:

```markdown
- If the browser is missing: `chromium`/`firefox`/`webkit` auto-install on first use (one-time download — the script handles it); for `chrome`/`msedge` the script prints a vendor-install link — relay it.
```

- [ ] **Step 3: Update the SPEC dependency note**

`SPEC.md` line 334, replace:

```markdown
- `playwright` (npm package only — no browser download). Login, capture, and verification all drive the **system Google Chrome** (`channel:'chrome'` for capture/verify, CDP for login), so `npx playwright install` is never needed. `npm install` auto-runs on first session via `hooks/ensure-deps.js`.
```

with:

```markdown
- `playwright` (npm package only — no browser download for the default path). Login and verification drive the **system Google Chrome** (CDP for login, `channel:'chrome'` for verify); capture defaults to Chrome too, so `npx playwright install` is never needed out of the box. Non-default engines (`chromium`/`firefox`/`webkit` via config, manifest, or `--browser`) auto-install on first use. `npm install` auto-runs on first session via `hooks/ensure-deps.js`.
```

- [ ] **Step 4: Fix the config skeleton in docs-setup**

`commands/docs-setup.md` line 21, replace `browser \`chromium\`` with `browser \`chrome\`` (the rest of the line unchanged).

- [ ] **Step 5: Commit**

```bash
git add skills/shopify-apps-doc-writer/references/manifest-schema.md skills/shopify-apps-doc-writer/SKILL.md SPEC.md commands/docs-setup.md
git commit -m "docs: multi-engine capture — manifest browser field, install hints, config default"
```

---

### Task 4: Live validation — firefox and webkit against a real admin

Session-portability is the one real risk: a Chrome-minted `storageState` might be rejected by Shopify in another engine. This task needs a live authenticated session and an existing manifest, so it runs on the maintainer's machine — it is a validation gate, not a code change. If no live setup is available, report that and leave this task unchecked for the user.

**Files:** none modified.

**Interfaces:**
- Consumes: the full Task 1–2 behavior via the CLI.
- Produces: a pass/fail verdict on cross-engine session portability, reported to the user.

- [ ] **Step 1: Pick an existing doc manifest**

Run: `ls docs/*/manifest.json`
Use the first result as `<MANIFEST>` below. If none exists, ask the user for one — do not fabricate a manifest.

- [ ] **Step 2: Firefox run**

Run: `node scripts/capture.js --manifest <MANIFEST> --browser firefox --only <first-shot-id>`
(first run auto-installs firefox — expect a download)
Expected: exit 0 and a saved PNG. Exit 10 means Shopify rejected the Chrome session in Firefox — report this as a spec-risk finding, not a bug in the implementation.

- [ ] **Step 3: WebKit run**

Run: `node scripts/capture.js --manifest <MANIFEST> --browser webkit --only <first-shot-id>`
Expected: same as Step 2.

- [ ] **Step 4: Restore any overwritten screenshots**

The runs above overwrite the doc's real (Chrome-rendered) screenshot. Restore it:

```bash
git checkout -- docs/
git status   # expect: clean
```

- [ ] **Step 5: Report the verdict**

Report to the user: which engines produced a screenshot, whether either hit exit 10, and (if both passed) that cross-engine session portability is validated. No commit — this task changes nothing.

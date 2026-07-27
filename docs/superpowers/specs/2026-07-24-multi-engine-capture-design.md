# Multi-Engine Capture — Design

**Status:** approved (2026-07-24)
**Subsystem:** `scripts/capture.js` (launch path), `scripts/lib/config.js` (default), manifest schema
**Depends on:** existing auth flow (`setup-auth.js`) — unchanged

## Goal

Let capture run under any Playwright engine — `chromium`, `firefox`, `webkit` —
plus the branded channels `chrome` and `msedge` for render-faithful shots.
Use cases (from brainstorm): a per-app config default ("this app's docs look
like Safari") and a per-run `--browser` override for spot-checks. Explicitly
**not** multi-engine-in-one-run side-by-side capture — that's cross-browser QA,
a different feature.

## Decisions (from brainstorm)

- **A+B, one code path**: config default + CLI override, same resolver.
- **Login stays real-Chrome-over-CDP.** The CDP indirection in `setup-auth.js`
  is Chrome-specific and Shopify rejects Playwright-launched browsers at login
  regardless of engine. The exported `storageState` is engine-portable JSON and
  is injected into whichever engine captures. The verification shot in
  `setup-auth.js` stays on `channel:'chrome'`.
- **Auto-install on first use** (not fail-with-instructions): missing
  `chromium`/`firefox`/`webkit` triggers `npx playwright install <name>` and a
  retry. `chrome`/`msedge` are system browsers — can't be auto-installed, keep
  the "install it from the vendor" error (Edge gets its own URL).
- **Manifest can pin the browser.** The manifest is the reproducibility
  contract; a webkit doc must stay a webkit doc on re-capture. Optional
  top-level `"browser"`, same pattern as `viewport`.

## Design

### 1. Values & precedence

`browser` ∈ `chrome` (default) | `msedge` | `chromium` | `firefox` | `webkit`.

Resolution: `--browser` CLI flag > `manifest.browser` > `config.capture.browser`
> `'chrome'`. Unknown value → exit 1 listing valid names.

Side fix: `DEFAULTS.capture.browser` in `config.js` currently says
`'chromium'` but nothing reads it and actual behavior is Chrome — the default
becomes `'chrome'`, and `commands/docs-setup.md`'s config-skeleton line
updates to match.

### 2. Launch mapping (in `capture.js`)

| name | launch |
|---|---|
| `chrome` / `msedge` | `chromium.launch({ channel: name })` |
| `chromium` / `firefox` / `webkit` | `playwright[name].launch()` |

Implemented as a small map + a pure resolver function (name → engine +
launch options) so precedence and validation are unit-testable. All inline in
`capture.js` — `setup-auth.js` is Chrome-forever, so a shared lib module would
have one consumer.

### 3. Auto-install

On launch failure for `chromium`/`firefox`/`webkit`: run
`npx playwright install <name>` via `spawnSync` with inherited stdio (download
progress visible), retry the launch once, then fail with the retry's error if
it still won't start. For `chrome`/`msedge`, keep the current vendor-install
error message.

### 4. Auth (unchanged)

If Shopify rejects a Chrome-minted session in another engine, the existing
`AUTH_EXPIRED` → exit 10 path already catches it and routes to
`/docs-setup auth`. **Known risk to validate during implementation:** one real
firefox capture and one real webkit capture against a live admin.

### 5. Manifest schema

`references/manifest-schema.md` gains optional top-level `"browser"` (same
enum), documented like `viewport`: pins rendering so re-capture reproduces the
doc's original engine. Omitted → config/default applies.

### 6. Doc/consistency updates

- SKILL.md line ~57: stale `npx playwright install chromium` hint → reflect
  auto-install behavior.
- SPEC.md line ~334: "no browser download ever" → "none needed for the default
  Chrome path; firefox/webkit auto-install on first use".
- `commands/docs-setup.md` config skeleton: `browser chromium` → `chrome`.
- Exit codes 10/20, selector policy, read-only guarantee: untouched.

## Testing

- `capture.test.js`: assert resolver precedence (CLI > manifest > config >
  default) and rejection of bad names.
- Auto-install path verified manually (shell-out, not worth mocking).
- Validation runs: one firefox + one webkit capture against a live admin
  (session-portability risk above).

## Out of scope (v2 candidates)

- Multi-engine side-by-side capture in one run.
- Per-shot browser overrides.
- Firefox/WebKit login flows.

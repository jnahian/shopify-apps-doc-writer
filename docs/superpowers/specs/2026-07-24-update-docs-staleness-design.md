# `/update-docs` Staleness Detection — Design

**Status:** approved (2026-07-24)
**Subsystem:** v2 backlog item — `/update-docs` staleness detection & re-publish
**Depends on:** existing `scripts/capture.js`, `meta.json` contract (SPEC §8), publish procedure (SPEC §9, `references/publish-targets.md`)

## Goal

Turn the stubbed `/update-docs <feature-slug>` command into a working command that detects what drifted in an already-published doc since it was last published, re-shoots screenshots deterministically, and re-publishes through the existing gate — updating the published doc in place where the target supports it.

## Background

`/write-docs` produces `docs/<slug>/{index.md, manifest.json, meta.json, screenshots/NN-*.png}` and can publish it (e.g. to Google Docs), recording `publish.url` and `publish.publishedHash` in `meta.json`. Today, keeping a published doc fresh is a manual three-step path (re-run `capture.js`, edit copy, re-publish). The new capability `/update-docs` adds is **drift detection** — telling the user *what* went stale — then orchestrating the existing re-shoot and re-publish pieces around it.

Re-shoot and re-publish already exist; only detection is new. Detection must be deterministic (a script), consistent with the repo's split: capture/verification is deterministic scripts, discovery is adaptive Claude.

## Design

### 1. Scope & trigger

`/update-docs <feature-slug>` operates on **one already-published doc**.

- If `docs/<slug>/` does not exist → error, nothing to update.
- If `meta.json` has no `publish.url` (never published) → stop with a clear message: nothing to compare against; publish it first via the normal publish gate. `/update-docs` is for keeping *published* docs fresh.
- No scan-all / multi-doc mode (deferred). The existing manual `capture.js --only <shot-id>` path in the current stub remains valid for one-off re-shoots.

### 2. Two drift axes (deterministic detection)

Detection compares the current local state against the state recorded at last publish. Two independent axes:

- **Copy drift:** `sha256(index.md)` vs `meta.publish.publishedHash`. Different → the doc's prose was edited since it was published.
- **Screenshot drift:** re-shoot the manifest into a **temp directory**, then `sha256`-compare each freshly captured PNG against its committed counterpart in `docs/<slug>/screenshots/`. Any byte difference → that shot changed.

Sensitivity is **byte-level** ("changed" / "unchanged"), not perceptual. A shot that renders visually identical but differs by a pixel counts as changed; perceptual similarity scoring is explicitly out of scope. This matches the deterministic-capture guarantee: `capture.js` already waits on `waitFor` selectors to avoid skeleton-loader noise, so re-shoots of an unchanged UI are expected to be byte-stable.

Detection is **git-independent**: it never reads git state and never mutates committed screenshots before the user approves. "Revert on decline" is simply deleting the temp directory.

### 3. Components (units of change)

Three units, each independently testable.

#### 3a. `scripts/capture.js` — add `--out-dir <dir>`

- New optional flag `--out-dir <dir>`. When set, screenshots are written there instead of `docs/<slug>/screenshots/`.
- Default (flag omitted) = today's behavior exactly: derive the screenshots dir from the manifest's doc location.
- Everything else (selector resolution, `waitFor` validation, `DESTRUCTIVE_PATTERN` refusal, exit codes 10/20) is unchanged.
- This preserves the hard invariant that `capture.js` is the **only** thing that produces screenshots: `update-check.js` shoots by shelling out to `capture.js`, never by driving a browser itself.

#### 3b. `scripts/update-check.js` — new

Deterministic drift detector. Responsibilities:

1. Resolve `docs/<slug>/` (from a `--doc <dir>` or `--manifest <path>` argument), read `meta.json`.
2. Guard: if not published (no `publish.url`), print a "not published" status and exit `0` — the command layer decides messaging.
3. Shell out: `node scripts/capture.js --manifest <doc>/manifest.json --app <key> --out-dir <tmp>` where `<tmp>` is a fresh temp dir (OS temp or `<doc>/.update-tmp/`).
   - If `capture.js` exits `10` (auth) or `20` (selector timeout) → propagate that same exit code. Exit `20` means the UI changed structurally enough that a selector no longer resolves; the manifest itself needs fixing (consistent with the documented contract), and the command surfaces that.
4. Copy drift: compute `sha256(index.md)`, compare to `meta.publish.publishedHash`.
5. Screenshot drift: for each committed screenshot, `sha256`-compare against the same-named file in `<tmp>`. Classify each as `changed` / `unchanged`. A shot present in the manifest but missing from one side is reported as `changed` (added/removed).
6. Emit a **human-readable report** to stderr (or plain stdout section) AND a **machine-readable JSON** block the command layer parses. JSON shape:

```json
{
  "slug": "ai-brand-visibility",
  "published": true,
  "url": "https://docs.google.com/...",
  "tmpDir": "/tmp/update-xyz",
  "copy": { "changed": false, "currentHash": "…", "publishedHash": "…" },
  "screenshots": {
    "changedCount": 2,
    "total": 7,
    "shots": [
      { "file": "02-dashboard.png", "changed": true },
      { "file": "05-settings.png", "changed": true }
    ]
  },
  "anyDrift": true
}
```

7. Exit `0` on a successful check (drift or no drift — the report is data, not a failure); `10`/`20` propagated from capture; non-zero on its own hard errors (missing doc, unreadable meta).

Hashing uses Node's stdlib `crypto` — no new dependency, no new lib file.

#### 3c. `commands/update-docs.md` — replace the stub

Orchestration prose (Claude follows it; it is not code):

1. Run `update-check.js` for the given slug/app.
2. Parse the JSON report.
3. If `published` is false → tell the user it isn't published yet; stop.
4. If `anyDrift` is false → "This doc is up to date since its last publish — nothing to do." Delete `tmpDir`. Stop.
5. If drift → present the human report (copy changed?; N of M screenshots changed, listed by filename).
6. **Local promotion confirm:** ask before overwriting committed screenshots with the staged ones. Decline → delete `tmpDir`, stop (nothing changed). Approve → move the changed files from `tmpDir` into `docs/<slug>/screenshots/`, delete `tmpDir`.
7. **Gate 3 (external re-publish):** show the exact summary of external writes — e.g. "Update existing Google Doc `<url>`: replace 2 images, body unchanged." Require explicit yes (non-skippable, never auto-approved).
8. Re-publish by reusing the target's publish procedure, targeting the recorded `url`:
   - Update the doc **in place** where the MCP target supports it (Google Docs does — replace body/images).
   - If the target cannot update in place → create a new doc, rewrite `meta.publish.url`, and tell the user the link changed.
9. On success, update `meta.json`: `publish.publishedHash` = new `contentHash` (`sha256(index.md)`), `publish.publishedAt` = now, `publish.url` if it changed. `status` stays `published`.

### 4. Data flow

```
/update-docs <slug>
      │
      ▼
update-check.js ──shells out──▶ capture.js --out-dir <tmp>   (deterministic re-shoot)
      │                                    │
      │◀── PNGs in <tmp> ──────────────────┘
      │
      ├─ sha256(index.md)  vs  meta.publishedHash        → copy drift
      ├─ sha256(<tmp>/NN)  vs  sha256(committed/NN)       → per-shot drift
      │
      ▼
   JSON report ──▶ command layer (Claude)
                        │
             anyDrift? ─┼─ no ──▶ "up to date"; rm tmp; stop
                        │
                       yes
                        │
                 report + promotion confirm
                        │ approve
                        ▼
              move changed PNGs tmp → screenshots/
                        │
                     Gate 3 (external write summary + explicit yes)
                        │ yes
                        ▼
             reuse publish procedure → update in place (or new doc)
                        │
                        ▼
             update meta.json (publishedHash, publishedAt, url?)
```

### 5. Gates & invariants preserved

- **Gate 3** (exact summary before any external write) reused verbatim for re-publish; non-skippable.
- Screenshot promotion adds a **local** confirmation step (it overwrites committed files), distinct from gate 3.
- **Read-only capture**, **selector policy**, and the **`DESTRUCTIVE_PATTERN`** refusal all inherit unchanged, because `/update-docs` drives all capture through `capture.js`. `/update-docs` never sets `"mutation": true`.
- **Exit-code contract** (10 = auth expired → `/docs-setup auth`; 20 = selector timeout → UI changed, fix manifest) is propagated by `update-check.js`, keeping the documented numbers meaningful.

### 6. Testing / verification

- `scripts/update-check.test.js` — plain-`assert` self-check (matching `shopify.test.js` / `md2html.test.js` style), covering:
  - copy-drift hash comparison (equal hash → unchanged; edited file → changed),
  - screenshot classification (identical bytes → unchanged; differing bytes → changed; missing file on one side → changed),
  - JSON report shape and `anyDrift` aggregation.
- One real end-to-end run of `/update-docs` against an existing published doc's manifest, verifying: no-drift path reports "up to date"; a deliberately edited `index.md` is detected as copy drift; the gate-3 summary is exact.

### 7. Out of scope (deferred)

- Perceptual / pixel-similarity scoring (byte-level only).
- Multi-doc / scan-all staleness sweep.
- Auto-fixing a manifest when `capture.js` exits `20` (report and stop; fixing the manifest is a human/`/write-docs` task).
- Annotation re-application (separate v2 subsystem).
- Non-`meta.json` publish targets or publish-history/versioning of old docs.

## Affected files

- Create: `scripts/update-check.js`
- Create: `scripts/update-check.test.js`
- Modify: `scripts/capture.js` (add `--out-dir`)
- Rewrite: `commands/update-docs.md` (stub → real orchestration)
- Update (docs consistency): `SPEC.md` (move `/update-docs` from non-goal/v2 to shipped), `skills/shopify-apps-doc-writer/SKILL.md` and `CLAUDE.md` if they describe `/update-docs` as coming soon.

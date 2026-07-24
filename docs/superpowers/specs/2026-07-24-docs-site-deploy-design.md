# `/docs-deploy` — Internal Docs Site on Cloudflare Pages — Design

**Status:** approved (2026-07-24)
**Subsystem:** new command — static site build + Cloudflare Pages deploy
**Depends on:** output contract (SPEC §8), `scripts/lib/md2html.js`, per-user config (SPEC §4)

## Goal

Give every doc a shareable URL for internal team review. `/docs-deploy` builds a
minimal static site from all of `docs/*/` and deploys it to a per-app Cloudflare
Pages project (`<appKey>-docs.pages.dev`). At gate #2, reviewers get a link
instead of a markdown file.

## Decisions (from brainstorm)

- **Audience: internal/team.** Not a public help center. Polish, SEO, custom
  domain, search are non-goals.
- **Per-app site.** Each app repo's `docs/` builds to its own Pages project.
  Multi-app support is just repeating setup; no aggregation.
- **Public URL is acceptable.** Unlisted `*.pages.dev`, no Cloudflare Access.
- **Drafts deploy too**, marked with a visible DRAFT badge (from `meta.status`).
  The deployed site *is* the review vehicle — this supersedes the Cloudflare
  Tunnel preview idea.
- **No framework.** The site is rendered by extending the plugin's existing
  `md2html.js`, not VitePress/Starlight. The canonical artifact stays
  `docs/*/index.md`; the site is a projection of it, same as every other
  publish target. If this ever becomes a public help center, migrating to
  Starlight is straightforward because only the projection changes.

## Design

### 1. Architecture

One new command + one new script, following the repo's split: the markdown
command file instructs Claude, the Node script does the deterministic work.

```
/docs-deploy
    │
    ▼
scripts/build-site.js --app <key> --out <tmpdir>     (deterministic build)
    │   reads docs/*/{index.md, meta.json, screenshots/}
    ▼
<tmpdir>/{index.html, style.css, <slug>/index.html, <slug>/screenshots/*.png}
    │
gate: confirm external write ("Deploy N docs (M drafts) to <project> → <url>?")
    │
    ▼
npx wrangler pages deploy <tmpdir> --project-name <project>
    │
    ▼
print the deployed URL; delete <tmpdir>
```

Nothing site-related is committed to the app repo. Build output is temporary
and discarded after deploy.

### 2. Components (units of change)

**`scripts/lib/md2html.js` — image mode (edit).**
`mdToHtml` gains an options argument enabling real image output: a screenshot
line renders as `<figure><img src="screenshots/NN-x.png" alt="…"><figcaption>…
</figcaption></figure>` instead of the Google-Docs placeholder text. Default
behavior unchanged — the Google Docs publish path is untouched.

**`scripts/build-site.js` (new).**
Args: `--app <key> [--out <dir>]` (default: a fresh temp dir; prints the path).

- Resolve config via the existing `lib/config.js` (`resolveAppKey`,
  `outputDir`).
- Walk `<outputDir>/*/`: a doc dir must have `meta.json` and `index.md`;
  dirs missing either are skipped with a printed warning, never a crash.
- Per doc: render `index.md` → `<slug>/index.html` wrapped in a minimal HTML
  shell (title from `meta.title`, link to shared `style.css`, DRAFT badge when
  `meta.status !== "published"`), and copy `screenshots/` verbatim.
- Root `index.html`: list of all docs — title (linked), status badge, and
  `meta.json` date (`publish.publishedAt` if present, else `createdAt`).
- One static `style.css` (embedded as a string in the script — no asset dir).
- Exit `0` with ≥1 doc built; exit `1` with a clear message if zero docs found.

**`commands/docs-deploy.md` (new).**
Instructs Claude to:

1. Run `build-site.js`; report what was built (doc count, drafts, skipped dirs).
2. **Confirmation gate (non-skippable):** deploying is an external write. Show
   exactly what will happen — "Deploy 4 docs (1 draft) to Pages project
   `storeseo-docs` → https://storeseo-docs.pages.dev. Proceed?" Require an
   explicit yes; never auto-approve. Same philosophy as gate #3.
3. On yes: `npx wrangler pages deploy <dir> --project-name <project>`; print
   the URL wrangler reports; delete the temp dir.
4. First-run paths: if wrangler is unauthenticated, tell the user to run
   `npx wrangler login` themselves (interactive, like `/docs-setup auth`) and
   retry. If the Pages project doesn't exist, create it with
   `npx wrangler pages project create <project>` (this is part of the same
   confirmed deploy — no second gate).

### 3. Configuration

Optional new per-user config key:

```jsonc
"deploy": { "pagesProject": "storeseo-docs" }   // default: "<appKey>-docs"
```

Absent config key → default applies; no setup-wizard change required. Wrangler
credentials are wrangler's own global login state — the plugin never touches or
stores Cloudflare tokens.

### 4. Data flow & contracts

- `docs/*/` is **read-only** to this feature. `meta.json` is not written:
  the per-doc `publish` fields keep their existing meaning (Google Docs / MCP
  target). The site deploy records nothing per-doc — the whole site is
  redeployed from local state each time, so there is no per-doc publish state
  to track.
- Screenshots are served by Pages directly from the build output (Pages'
  25 MB/file limit is far above any PNG here). No R2.

### 5. Error handling

- wrangler missing or unauthenticated → stop with the exact command the user
  should run (`npx wrangler login`). Nothing was deployed.
- Build failure names the offending doc/file.
- Deploy failure → surface wrangler's error verbatim. Build output is temp;
  no local state changed on any failure path.

### 6. Testing

Same plain-`assert` pattern as the existing self-checks:

- `scripts/lib/md2html.test.js` — new cases: image mode emits
  `<figure>/<img>/<figcaption>`; default mode still emits placeholders.
- `scripts/build-site.test.js` (new) — builds a fixture docs dir (one
  published doc, one draft, one malformed dir) and asserts: root index lists
  both docs, draft badge present on the draft only, doc page contains real
  `<img>` tags, malformed dir skipped with warning, screenshots copied.
- Deploy is verified by one real `/docs-deploy` run against the StoreSEO docs.

### 7. Docs to update

- `README.md` — add `/docs-deploy` to the command list.
- `CLAUDE.md` — add `build-site.js` to the commands/self-check lists.
- SPEC.md is not amended (it is the v1 spec; this design doc is the record).

## Non-goals (deferred, not designed here)

- OG social-card images, `llms.txt`, custom domain, search — public
  help-center concerns; revisit if/when the site goes merchant-facing
  (likely as a Starlight migration).
- Cloudflare Tunnel previews — superseded by deploying drafts.
- R2 asset hosting — Pages serves the PNGs.
- nginx/Hetzner deploy target — Pages chosen as the default; add only if a
  concrete need appears.

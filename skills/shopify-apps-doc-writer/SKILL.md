---
name: shopify-apps-doc-writer
description: Write merchant-facing feature documentation for a Shopify app with real screenshots. Use whenever the user wants to document a feature, write a help article, user guide, how-to, onboarding walkthrough, or knowledge-base entry for the app's merchants, or redo one whose screenshots went stale after a UI change or release — even if they never say "documentation," and even when they only name the audience ("for merchants, not developers") or ask for "real screenshots from the admin." Also the engine behind /write-docs and /update-docs. Not for developer- or marketing-facing writing: API/endpoint references, READMEs, contributor or setup docs, release notes, changelogs, or blog posts.
---

# shopify-apps-doc-writer — Orchestrator

Produce a complete merchant-facing feature doc: prose + real, consistent screenshots, captured deterministically from a shot manifest. Canonical output is **always** local markdown + assets in `docs/<feature-slug>/`; publishing is an optional projection of it.

**The three gates are hard requirements. None may be auto-approved, and publishing never happens in the same breath as drafting.**

| # | When | What the user approves |
|---|------|------------------------|
| 1 | Before capture | The shot manifest: shot list, pages, actions |
| 2 | Before anything leaves local | The full draft doc |
| 3 | Before external publish | Exact summary of writes to the external target |

## 0. Preflight

1. Resolve the app config: `~/.config/shopify-apps-doc-writer/<app-key>.json`. Honor `--app <key>`; with no flag, use the single config if exactly one exists, otherwise ask. **If no config exists, stop** and tell the user to run `/docs-setup` first.
2. **Workspace — isolate the work in a git worktree** (preflight confirmation; separate from the three gates). Derive `<feature-slug>` (kebab-case) first — the branch is named after it. Docs land in the *working directory's* repo, so keep the user's checkout untouched:
   - Not a git repo → work in place, say so once, move on.
   - Already isolated (`git rev-parse --git-dir` ≠ `--git-common-dir` **and** `git rev-parse --show-superproject-working-tree` prints nothing — a non-empty result means a submodule, not a worktree) → stay here, say which branch, move on.
   - `docs/` not tracked here (`git check-ignore -q docs`, or `git ls-files docs/` is empty) → a worktree buys nothing: the output would be untracked files in a throwaway directory. Say so and work in place. (This is the case in the plugin's own repo, where `docs/*` is gitignored.)
   - Otherwise **ask once**, with both defaults filled in: base branch (default the repo's default branch — `git symbolic-ref --short refs/remotes/origin/HEAD` minus the `origin/` prefix, so the worktree bases on the *local* branch, not a possibly stale remote ref; fall back to the current branch if that local branch doesn't exist) and branch/worktree name (default `docs/<feature-slug>`). The user may decline — then work in place.
   - On approval: verify the worktree dir is ignored (`git check-ignore -q .worktrees`; if not, append `.worktrees/` to `.gitignore` and commit that one line), then `git worktree add .worktrees/<branch> -b <branch> <base>`. **Every step below runs with that worktree as the working directory** — including `docs/<slug>/` paths.
3. Read product context if present, per app: `.agents/<app-key>.product-marketing.md` in the repo, else `~/.config/shopify-apps-doc-writer/<app-key>.product-marketing.md`. (A legacy un-keyed `.agents/product-marketing.md` from a single-app setup is an acceptable fallback — offer to rename it to the app-keyed name.) If missing, warn once ("docs will lack shared positioning/tone grounding — `/docs-setup context` fixes this") and proceed.
4. If ambiguous, ask (one round, concrete options): **audience** (merchant-facing vs internal) and **doc type** (new doc vs rewrite of an existing one). Default: merchant-facing, new.
5. If `docs/<slug>/` already exists and this isn't a rewrite, ask before overwriting.

## 1. Discovery

Build a real understanding of the feature before writing a word. Preference order:

1. **ClickUp task/spec** for the feature (via ClickUp MCP if connected) — intent, scope, edge cases.
2. **Code / PR** implementing it — actual behavior, routes, plan gating, `data-testid` coverage.
3. **Interactive browsing** of the live feature (Playwright MCP or claude-in-chrome, using the dev store) — the real UI flow, exact labels, empty/filled states.

Derive the merchant's step-by-step flow **from what was actually observed, not assumptions**. If the sources conflict, the live UI wins. Record which sources were used — this goes in the wrap-up summary.

## 2. Manifest authoring — gate 1

Write `docs/<slug>/manifest.json` per `references/manifest-schema.md`. Rules that matter most:

- Shot IDs ordered and zero-padded (`01-…`, `02-…`); one shot per meaningful UI state in the merchant flow, typically opening with a `full-admin` navigation shot (where the feature lives) then `iframe` detail shots.
- **Selector policy:** prefer `data-testid` > aria-label / role > visible text. **Never** hashed Polaris class names — they change every release and silently break re-capture. Missing `data-testid` coverage in the app is a finding to report to the user, not a reason to use fragile selectors.
- `waitFor` is required on every shot (Polaris skeleton loaders photobomb otherwise). Default strategy: network idle **and** selector visible.
- Actions are read-only navigation **only** — `click`/`fill`/`select`/`hover`/`press` to reach a UI state, never to mutate store data. Never set `"mutation": true` on any shot; if a state can only be reached by mutating data, screenshot the state before it and note the limitation to the user.
- **Always** set the manifest's `browser` field to the engine you captured with (`chrome` unless told otherwise). `/docs-check` re-shoots through this manifest without `--browser`, so an omitted field lets a teammate's config pick a different engine and report drift on a UI that never changed.

**Gate 1:** present the manifest for approval — shot count, pages touched, every action listed, and an explicit statement that all actions are read-only. Iterate until the user approves. Do not run capture before approval.

## 3. Capture

Run from the docs repo (the worktree from §0.2 — `capture.js` resolves `--manifest` and the output dir against the *current* directory), invoking the script by absolute path:

```
node <plugin-root>/scripts/capture.js --manifest docs/<slug>/manifest.json --app <key>
```

`<plugin-root>` is this skill's directory two levels up — the one holding `.claude-plugin/`.

- Exit `0`: show the captured screenshots inline for a quick visual sanity check (skeletons? wrong page? personal data visible?). Re-shoot individual shots with `--only <shot-id>` after fixing the manifest.
- Exit `10` (auth expired): tell the user to run `/docs-setup auth`, then retry.
- Exit `20` (selector timeout): the script reports which shot/selector — the UI likely changed; fix the manifest, re-approve the changed shots (gate 1 applies to changes), re-run.
- If the browser is missing: `chromium`/`firefox`/`webkit` auto-install on first use (one-time download — the script handles it); for `chrome`/`msedge` the script prints a vendor-install link — relay it.

## 4. Writing

Follow `references/doc-template.md` for structure. Invoke the vendored skills **explicitly** (never rely on auto-triggering), in this order:

1. `skills/vendored/content-strategy` — structure decisions: section order, what deserves a heading, FAQ selection.
2. `skills/vendored/copywriting` — the draft.
3. `skills/vendored/copy-editing` — polish pass.
4. `skills/vendored/ai-seo` — LLM-citability: headings phrased as questions where natural, self-contained sections, schema-friendly structure.

If a vendored skill directory has no SKILL.md (not yet vendored — see `skills/vendored/VERSIONS.md`), note it once and apply the doc template plus the tone rules below with your own judgment.

Embed screenshots by relative path with their manifest captions: `![<caption>](screenshots/01-navigate.png)`. Numbered steps reference numbered screenshots. Write to `docs/<slug>/index.md`.

**Tone rules (merchant-facing):** write to "you / your store"; no internal jargon, ticket IDs, or codenames; name UI elements exactly as they appear on screen; short sentences, one action per step; state plan availability plainly.

**Screenshot conventions:** consistent viewport (from config, default 1440×900); no personal or real-customer data visible — if a capture shows any, flag it and re-shoot from a cleaner state.

## 5. Draft review — gate 2

Present `index.md` (and the screenshot set) for review. Iterate until approved. **Nothing leaves the repo before approval.** On approval set `status: "approved"` in meta.json.

## 6. Publish (optional) — gate 3

Only if config `publish.target` is not `local` and the user wants to publish. Follow `references/publish-targets.md` for the target-specific procedure.

**Gate 3:** before any external write, show exactly what will be created where — e.g. "1 Google Doc + 8 images into Drive folder X" — and require an explicit yes. Non-skippable. If the target can't ingest images, say so at the gate: text will publish with `[Screenshot: …]` placeholder markers (degraded, never broken).

## 7. Wrap-up

1. Write/refresh `docs/<slug>/meta.json`: title, slug, app, audience, status (`draft` | `approved` | `published`), createdAt, `contentHash` (sha256 hex of the raw index.md bytes — `shasum -a 256 index.md`), and on publish: target, url, publishedAt, `publishedHash`.
2. Summarize: the worktree path and branch if one was created (the user can't guess either), absolute output paths, shot count, discovery sources used, publish URL if any, and any findings (e.g. missing `data-testid` coverage). The doc is uncommitted on that branch — say so, and leave committing and merging to the user.

## Output contract

Every run produces, regardless of publish target:

```
docs/<feature-slug>/
├── index.md            # the doc — screenshots referenced by relative path
├── manifest.json       # shot manifest (reproducibility)
├── meta.json           # status, hashes, publish record
└── screenshots/
    ├── 01-….png
    └── 02-….png
```

Re-running the manifest after a UI change regenerates every screenshot deterministically — that's the reproducibility contract. Never bypass `capture.js` with ad-hoc browser screenshots in the final doc.

# 0.3 — Vendor the writing skills: verify + close out

**Date:** 2026-08-06
**Status:** approved

## Context — the 0.3 premise was stale

SPEC §13 scoped 0.3 as "unfinished v1 work: the writing phase currently runs
on the doc-template fallback." Exploration showed that is false:

- The five skills (product-marketing, copywriting, copy-editing, ai-seo,
  content-strategy) were vendored, de-emphasized, and committed on 2026-07-23
  (`42eaebf`) and **shipped to installed users in 0.2.0**.
- Upstream has moved since the pin (`c21a984` → `7868cb9`), but the diff
  restricted to the five vendored skills is **empty** — all upstream changes
  are in other skills (pricing, attribution). A re-pin is a content no-op.
- The de-emphasis prefix is present in all five descriptions, and
  `vendor-skills.sh` re-applies it idempotently.

Two real gaps did surface:

1. **Vendored skills are not registered skills.** They live at
   `skills/vendored/<name>/SKILL.md`, one level too deep for plugin skill
   discovery — confirmed live in a session with the plugin installed. So
   auto-triggering is structurally impossible (the de-emphasis is
   defense-in-depth), and the orchestrator's "invoke the vendored skills
   explicitly" can only mean *read each SKILL.md and follow it*. SKILL.md
   never says so.
2. **SKILL.md §4 uses bare relative paths** (`skills/vendored/content-strategy`)
   while runtime cwd is the docs-repo worktree, not the plugin root. §3
   defines `<plugin-root>` for scripts; §4 doesn't use it, so the paths don't
   resolve literally.

So 0.3 becomes: **verify + close out** — run the specced verification, fix
what it found, correct the stale docs, release.

## Scope

### Re-pin

Run `./scripts/vendor-skills.sh` (pins upstream HEAD `7868cb9`). Expected:
only `VERSIONS.md`'s Commit/Date lines change. This doubles as a live test of
the script's idempotency. **Guard:** if `git diff` shows anything beyond
VERSIONS.md, stop and review — upstream restructured or the de-emphasis
regressed.

### Verification checklist

- [x] No auto-trigger possible: vendored skills absent from the registered
      skill index (confirmed live; see Context).
- [x] De-emphasis prefix present in all five descriptions.
- [x] Path audit: every `skills/vendored/*` reference in SKILL.md,
      `commands/*.md`, and `references/*` points at an existing file.
- [x] Followability: writing-phase instructions work for a fresh reader in a
      docs-repo worktree (the two known gaps above, plus anything else the
      pass turns up).

Audit note: one extra stale passage beyond the known gaps — CLAUDE.md's
cheat-sheet comment claimed the de-emphasis must be re-applied manually
after a re-pin (the script does it idempotently); fixed with the CLAUDE.md
corrections.

### Fixes

- **SKILL.md §4**: prefix the four skill paths with `<plugin-root>/`; state
  the mechanism (reference files, not registered skills — read each SKILL.md
  and follow it); reword the fallback's "(not yet vendored…)" parenthetical —
  keep the graceful fallback for robustness, drop the stale reason.
- **CLAUDE.md**: replace the "skills are not vendored yet" paragraph with
  current reality (vendored, pinned, shipped; fallback kept for robustness).
- **SPEC.md §13 0.3**: rewrite to what 0.3 actually is (verification +
  closeout), including the reconciliation that `/write-docs` invokes four
  skills in the writing phase and `product-marketing` is wired through
  `/docs-setup` — "all five in /write-docs" was never the design.
- **VERSIONS.md**: Commit/Date updated by the script.

### Release

Yes — **0.3.0**. The SKILL.md edits are runtime behavior for installed users
(markdown is this plugin's code), so per the release rule: bump
`.claude-plugin/plugin.json` **and** `package.json` to 0.3.0, add a
CHANGELOG entry, release via the `release` skill after merge.

## Out of scope

- Any change to the vendored skill content itself (upstream is unchanged).
- Empirical auto-trigger probes or a live end-to-end `/write-docs` run —
  non-registration already answers the trigger question conclusively
  (decided during brainstorm: static + followability depth).
- The description-triggering optimizer pass (SPEC §12 item 7) — separate
  item, unblocked but not bundled.

## Testing / error handling

No JS changes → TDD exempt (markdown-only). `npm test` + `npm run typecheck`
run before commit as a regression guard. The vendor-script diff guard above
is the only failure mode with a decision branch.

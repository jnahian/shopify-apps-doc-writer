# 0.3 Vendor Writing Skills — Verify + Close Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out roadmap item 0.3 — re-pin the vendored writing skills, finish the verification the SPEC promised, fix the followability gaps in the runtime instructions, correct stale docs, and ship 0.3.0.

**Architecture:** No new code. The vendored skills already shipped in 0.2.0; this is a script run (`vendor-skills.sh`, expected content no-op), markdown edits to two runtime instruction files (`skills/shopify-apps-doc-writer/SKILL.md`, `commands/docs-setup.md`) and two repo docs (`CLAUDE.md`, `SPEC.md`), then the standard release flow.

**Tech Stack:** bash (vendor script), markdown, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md`

## Global Constraints

- Markdown changes are TDD-exempt (CLAUDE.md rule); still run `npm test` and `npm run typecheck` before each commit as a regression guard.
- Surgical diffs: touch only the passages shown in each task; no reformatting of adjacent text.
- Work on branch `docs/spec-0.3-vendor-writing-skills` (already holds the spec commit). All commands run from the repo root.
- Release rule: user-visible change ⇒ bump `.claude-plugin/plugin.json` **and** `package.json` to the same semver + `CHANGELOG.md` entry. Version for this release: **0.3.0** (user-approved; roadmap names each item's release).
- Git commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Re-pin the vendored skills

**Files:**
- Modify (via script): `skills/vendored/VERSIONS.md` (Commit/Date lines only)

**Interfaces:**
- Produces: `VERSIONS.md` pinned to upstream HEAD `7868cb9251fad80a73d26e488a5ad5f6c4a9f335`, date `2026-08-06`. Task 7's CHANGELOG entry cites this sha.

- [ ] **Step 1: Run the vendor script (no sha argument → pins upstream HEAD)**

```bash
./scripts/vendor-skills.sh
```

Expected output (sha must be `7868cb9251fad80a73d26e488a5ad5f6c4a9f335`; if upstream moved again, note the new sha and carry it through Task 7):

```
Cloning https://github.com/coreyhaines31/marketingskills …
  vendored product-marketing
  vendored copywriting
  vendored copy-editing
  vendored ai-seo
  vendored content-strategy
  de-emphasized all vendored SKILL.md descriptions
Done. Pinned 7868cb9251fad80a73d26e488a5ad5f6c4a9f335 (2026-08-06) in skills/vendored/VERSIONS.md.
```

- [ ] **Step 2: Verify the diff guard — only VERSIONS.md may change**

```bash
git status --short
git diff skills/vendored/VERSIONS.md
```

Expected: `git status --short` lists exactly one modified file, `skills/vendored/VERSIONS.md`. Its diff changes exactly two lines: `- Commit: c21a984a56da10fb6085e6334f6f60929220a4da` → `- Commit: 7868cb9251fad80a73d26e488a5ad5f6c4a9f335` and `- Date: 2026-07-23` → `- Date: 2026-08-06`.

**STOP CONDITION:** If any other file changed, do not commit. Upstream restructured one of the five skills or the de-emphasis regressed — run `git diff` on the changed files, report the findings, and wait for a human decision. (This also empirically tests the script's idempotency claim.)

- [ ] **Step 3: Regression guard and commit**

```bash
npm test && npm run typecheck
git add skills/vendored/VERSIONS.md
git commit -m "chore(skills): re-pin vendored skills to upstream 7868cb9

Content no-op — the five vendored skills are unchanged upstream since
c21a984; all upstream movement is in other skills. Confirms the vendor
script's idempotency (only VERSIONS.md's pin lines changed).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: all test suites pass, typecheck emits no errors, commit succeeds.

---

### Task 2: Path audit (verification only — no file changes)

**Files:** none modified. Findings feed Tasks 3–5; the spec checklist is flipped in Task 6.

**Interfaces:**
- Produces: confirmation that every `skills/vendored/*` reference in the repo (outside `skills/vendored/` itself) points at an existing file/dir. Known-stale passages are fixed by Tasks 3–5, not here.

- [ ] **Step 1: Enumerate every reference**

```bash
grep -rn "vendored" --include="*.md" CLAUDE.md SPEC.md commands/ skills/shopify-apps-doc-writer/
```

Expected hits (12, as of the spec commit): `CLAUDE.md:15,18,36`; `commands/docs-setup.md:44`; `skills/shopify-apps-doc-writer/SKILL.md:71,73,74,75,76,78`; `SPEC.md:41,79,107,170,235,381`. Any *new* hit not in this list: verify its path the same way as Step 2 and, if stale, add it to the matching fix task.

- [ ] **Step 2: Verify each referenced path exists**

```bash
ls skills/vendored/content-strategy/SKILL.md skills/vendored/copywriting/SKILL.md \
   skills/vendored/copy-editing/SKILL.md skills/vendored/ai-seo/SKILL.md \
   skills/vendored/product-marketing/SKILL.md skills/vendored/VERSIONS.md
```

Expected: all six paths listed, no `No such file` errors.

- [ ] **Step 3: Record the audit result**

No commit. State in the task report: paths resolve repo-relatively; the runtime problem is cwd (docs-repo worktree), fixed in Task 3. Confirm the three known-stale passages (`CLAUDE.md:17-18`, `CLAUDE.md:36`, `SKILL.md:78` parenthetical) and flag any additional stale text found.

---

### Task 3: Fix the runtime instructions (SKILL.md §4 + docs-setup.md)

This is the user-visible behavior change of the release: at runtime cwd is the docs-repo worktree, so §4's bare `skills/vendored/...` paths don't resolve, and neither file states that vendored skills are read as files (they are not registered skills — one directory too deep for plugin skill discovery, so they have no Skill-tool name and can never auto-trigger).

**Files:**
- Modify: `skills/shopify-apps-doc-writer/SKILL.md:71-78`
- Modify: `commands/docs-setup.md:38-44`

**Interfaces:**
- Consumes: `<plugin-root>` is already defined at `skills/shopify-apps-doc-writer/SKILL.md:61` ("this skill's directory two levels up — the one holding `.claude-plugin/`"); §4 comes after it. `commands/docs-setup.md` has no such definition, so its fix defines the path inline.
- Produces: the exact §4 wording Task 7's CHANGELOG entry describes.

- [ ] **Step 1: Replace SKILL.md §4's skill-invocation block**

Old (exact, `skills/shopify-apps-doc-writer/SKILL.md:71-78`):

```markdown
Follow `references/doc-template.md` for structure. Invoke the vendored skills **explicitly** (never rely on auto-triggering), in this order:

1. `skills/vendored/content-strategy` — structure decisions: section order, what deserves a heading, FAQ selection.
2. `skills/vendored/copywriting` — the draft.
3. `skills/vendored/copy-editing` — polish pass.
4. `skills/vendored/ai-seo` — LLM-citability: headings phrased as questions where natural, self-contained sections, schema-friendly structure.

If a vendored skill directory has no SKILL.md (not yet vendored — see `skills/vendored/VERSIONS.md`), note it once and apply the doc template plus the tone rules below with your own judgment.
```

New:

```markdown
Follow `references/doc-template.md` for structure. The vendored writing skills are **reference files, not registered skills** — they have no Skill-tool name and never auto-trigger. Apply each one by reading its SKILL.md and following it, in this order:

1. `<plugin-root>/skills/vendored/content-strategy/SKILL.md` — structure decisions: section order, what deserves a heading, FAQ selection.
2. `<plugin-root>/skills/vendored/copywriting/SKILL.md` — the draft.
3. `<plugin-root>/skills/vendored/copy-editing/SKILL.md` — polish pass.
4. `<plugin-root>/skills/vendored/ai-seo/SKILL.md` — LLM-citability: headings phrased as questions where natural, self-contained sections, schema-friendly structure.

If a vendored SKILL.md is missing (broken install — see `<plugin-root>/skills/vendored/VERSIONS.md`), note it once and apply the doc template plus the tone rules below with your own judgment.
```

- [ ] **Step 2: Point docs-setup.md's product-context phase at the actual file**

Old (exact, `commands/docs-setup.md:38`):

```markdown
1. Offer to generate `product-marketing.md` — the foundation doc that the writing skills read before drafting anything (positioning, audience, tone, key terms).
```

New:

```markdown
1. Offer to generate `product-marketing.md` — the foundation doc that the writing skills read before drafting anything (positioning, audience, tone, key terms). To draft it, read and follow `<plugin-root>/skills/vendored/product-marketing/SKILL.md`, where `<plugin-root>` is the plugin directory holding `.claude-plugin/` — it is a reference file, not a registered skill.
```

Old (exact, `commands/docs-setup.md:44`):

```markdown
   The vendored `product-marketing` skill drafts to the un-keyed `.agents/product-marketing.md`; rename its output to the app-keyed path above when you save.
```

New:

```markdown
   The vendored `product-marketing` skill file drafts to the un-keyed `.agents/product-marketing.md`; rename its output to the app-keyed path above when you save.
```

- [ ] **Step 3: Verify the edits**

```bash
grep -n "vendored" skills/shopify-apps-doc-writer/SKILL.md commands/docs-setup.md
```

Expected: every `skills/vendored/` path in both files is prefixed with `<plugin-root>/` and ends in `/SKILL.md` or `/VERSIONS.md`; the phrases "reference files, not registered skills" (SKILL.md) and "reference file, not a registered skill" (docs-setup.md) are present; the string "not yet vendored" no longer appears.

- [ ] **Step 4: Regression guard and commit**

```bash
npm test && npm run typecheck
git add skills/shopify-apps-doc-writer/SKILL.md commands/docs-setup.md
git commit -m "fix(skill): plugin-root-qualify vendored-skill paths, state the read mechanism

Runtime cwd is the docs-repo worktree, so §4's bare skills/vendored/...
paths never resolved literally. Also states what \"invoke\" means: the
vendored skills are unregistered reference files — read each SKILL.md
and follow it. They cannot auto-trigger (not in the skill index); the
description de-emphasis is defense-in-depth.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: tests pass, typecheck clean, commit succeeds.

---

### Task 4: Correct CLAUDE.md's stale vendoring claims

**Files:**
- Modify: `CLAUDE.md:15-18` (command cheat-sheet comment) and `CLAUDE.md:36` (vendored-state paragraph)

**Interfaces:**
- Consumes: reality established by Tasks 1–3 (skills vendored + pinned, script idempotent, not registered).

- [ ] **Step 1: Fix the cheat-sheet comment (the script re-applies the de-emphasis itself)**

Old (exact, `CLAUDE.md:15-18`):

```
./scripts/vendor-skills.sh [sha]   # MAINTENANCE ONLY: re-pin skills/vendored/ to newer upstream.
                                   # The 5 skills are committed and ship with the plugin — this is
                                   # not an install step, and it OVERWRITES the description
                                   # de-emphasis (re-apply it afterward, see vendored/VERSIONS.md).
```

New:

```
./scripts/vendor-skills.sh [sha]   # MAINTENANCE ONLY: re-pin skills/vendored/ to newer upstream.
                                   # The 5 skills are committed and ship with the plugin — this is
                                   # not an install step. The script re-applies the description
                                   # de-emphasis itself (idempotent; see vendored/VERSIONS.md).
```

- [ ] **Step 2: Replace the stale "not vendored yet" paragraph**

Old (exact, `CLAUDE.md:36`):

```markdown
`skills/vendored/` currently holds only `VERSIONS.md` — the skills are not vendored yet. SKILL.md handles this gracefully (falls back to the doc template), so don't assume those directories exist.
```

New:

```markdown
`skills/vendored/` holds the five writing skills, pinned in its `VERSIONS.md`; they shipped with the plugin since 0.2.0. They are deliberately **not** registered skills — one directory too deep for plugin skill discovery — so they can never auto-trigger; the orchestrator reads each `SKILL.md` directly by `<plugin-root>`-qualified path. SKILL.md still degrades gracefully (doc-template fallback) if one is missing from a broken install.
```

- [ ] **Step 3: Regression guard and commit**

```bash
npm test && npm run typecheck
git add CLAUDE.md
git commit -m "docs(claude): correct stale vendoring claims

The skills have been vendored and shipping since 0.2.0, and
vendor-skills.sh re-applies the de-emphasis itself — no manual step.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: tests pass, typecheck clean, commit succeeds.

---

### Task 5: Rewrite SPEC.md §13's 0.3 entry to its actual scope

**Files:**
- Modify: `SPEC.md:377-382`

**Interfaces:**
- Consumes: the design doc path `docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md` (committed in this branch's first commit).

- [ ] **Step 1: Replace the 0.3 section**

Old (exact, `SPEC.md:377-382`):

```markdown
### 0.3 — Vendor the writing skills
Unfinished v1 work that is also a quality item: the writing phase currently
runs on the doc-template fallback. Run `scripts/vendor-skills.sh` pinned to
current upstream, re-apply the description de-emphasis (see
`skills/vendored/VERSIONS.md`), verify `/write-docs` invokes all five skills
explicitly and that none trigger on unrelated prompts.
```

New:

```markdown
### 0.3 — Vendor the writing skills: verify + close out
Re-scoped 2026-08-06: the original premise was stale — the five skills were
vendored, de-emphasized, and shipped in 0.2.0 (see
`docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md`). Actual
scope: re-pin to current upstream (content no-op), verify the wiring — the
vendored skills are unregistered reference files one directory too deep for
skill discovery, so they *cannot* auto-trigger, and the writing phase reads
four of them while `product-marketing` is wired through `/docs-setup` ("all
five in /write-docs" was never the design) — and fix the followability gaps:
`<plugin-root>`-qualified paths and an explicit read-and-follow mechanism in
SKILL.md §4.
```

- [ ] **Step 2: Regression guard and commit**

```bash
npm test && npm run typecheck
git add SPEC.md
git commit -m "docs(spec): rewrite §13 0.3 to its actual scope (verify + close out)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: tests pass, typecheck clean, commit succeeds.

---

### Task 6: Close out the spec checklist and open the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md` (the two open checkboxes)

- [ ] **Step 1: Flip the two open verification checkboxes**

In `docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md`, change:

```markdown
- [ ] Path audit: every `skills/vendored/*` reference in SKILL.md,
      `commands/*.md`, and `references/*` points at an existing file.
- [ ] Followability: writing-phase instructions work for a fresh reader in a
      docs-repo worktree (the two known gaps above, plus anything else the
      pass turns up).
```

to:

```markdown
- [x] Path audit: every `skills/vendored/*` reference in SKILL.md,
      `commands/*.md`, and `references/*` points at an existing file.
- [x] Followability: writing-phase instructions work for a fresh reader in a
      docs-repo worktree (the two known gaps above, plus anything else the
      pass turns up).
```

If Task 2 or the fixes surfaced anything beyond the known gaps, append a one-line note under the checklist saying what and where it was fixed.

- [ ] **Step 2: Commit and push**

```bash
npm test && npm run typecheck
git add docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md
git commit -m "docs(spec): check off completed 0.3 verification items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin docs/spec-0.3-vendor-writing-skills
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "0.3: verify + close out the skill vendoring" --body "## Summary
- Re-pins skills/vendored/ to upstream 7868cb9 — content no-op for the five skills; confirms vendor-skills.sh idempotency
- Fixes the writing-phase followability gaps: \`<plugin-root>\`-qualified vendored-skill paths and an explicit read-the-SKILL.md mechanism in SKILL.md §4 and /docs-setup phase 3
- Corrects stale docs: CLAUDE.md (\"not vendored yet\", \"re-apply de-emphasis manually\") and SPEC §13's 0.3 entry
- Records the verification: vendored skills are unregistered (one dir too deep for discovery) so they cannot auto-trigger; de-emphasis is defense-in-depth

Spec: docs/superpowers/specs/2026-08-06-vendor-writing-skills-design.md
No version bump here — the 0.3.0 bump PR follows via /release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL printed. **Stop here for human review/merge before Task 7.**

---

### Task 7: Release 0.3.0

Runs only after Task 6's PR merges to `main`. Use the repo's `/release` skill (`.claude/skills/release/SKILL.md`) — it is the source of truth for mechanics. Summary of what it will do, with the content it needs:

- [ ] **Step 1: Phase 1 — bump PR** (branch `chore/release-0.3.0` off fresh `main`; edit exactly three files)

`.claude-plugin/plugin.json` and `package.json`: `"version": "0.2.0"` → `"version": "0.3.0"`.

`CHANGELOG.md` — insert above the `## [0.2.0]` section:

```markdown
## [0.3.0] - 2026-08-06

### Changed

- The writing phase's vendored-skill instructions now use `<plugin-root>`-qualified
  paths and state the mechanism explicitly (read each skill's SKILL.md and follow
  it — they are reference files, not registered skills), so doc-writing sessions
  no longer try to resolve `skills/vendored/...` against the docs-repo worktree.
  Same fix in `/docs-setup`'s product-context phase.
- Vendored skills re-pinned to upstream `7868cb9` (no content changes to the
  five skills; pin metadata only).

### Fixed

- The session-start dependency install no longer downloads dev-only packages
  (`typescript`, `@types/node`) into your plugin install — `hooks/ensure-deps.js`
  now runs `npm install --omit=dev`, about 30MB lighter. Only `playwright` is
  needed at runtime.
```

(The `hooks/ensure-deps.js` fix is `b948d68`, merged after v0.2.0 was cut and never released — it rides along here.)

Per the release skill: show the user the version + CHANGELOG entry and **wait for approval** (the entry above is pre-approved content, but the gate still runs), then `claude plugin validate .`, commit, push, `gh pr create`.

- [ ] **Step 2: Phase 2 — cut the release after the bump PR merges**

```bash
git checkout main && git pull -q
NOTES=$(mktemp)
awk '/^## \[0\.3\.0\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > "$NOTES"
gh release create v0.3.0 --target main --title "v0.3.0" --notes-file "$NOTES"
git fetch --tags origin
gh release view v0.3.0
```

Expected: release URL printed; `gh release view` shows the 0.3.0 notes. Do **not** `git tag` by hand — `gh release create` makes the tag. Say the release is published, not "live for users" — delivery happens when their installed copy sees the new `plugin.json` version.

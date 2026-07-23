# Vendored from coreyhaines31/marketingskills

- Upstream: https://github.com/coreyhaines31/marketingskills
- Commit: c21a984a56da10fb6085e6334f6f60929220a4da
- Date: 2026-07-23
- Skills: product-marketing, copywriting, copy-editing, ai-seo, content-strategy
- Local modifications: each SKILL.md `description:` is prefixed with "Internal writing aid for shopify-apps-doc-writer; invoked explicitly by its orchestrator, not auto-triggered." Upstream descriptions are broad ("when the user wants to write marketing copy") and would auto-fire on unrelated tasks. Content is otherwise unmodified.

## How to vendor / update

```bash
./scripts/vendor-skills.sh          # pins latest upstream main
./scripts/vendor-skills.sh <sha>    # pins a specific commit
```

The script clones the upstream repo (MIT licensed), copies exactly the five
skills above into this directory, rewrites the Commit/Date lines here, and
**automatically re-applies the description de-emphasis** (below). Do **not**
vendor the full skill set — it pollutes skill triggering. The orchestrator
invokes these five explicitly.

These skills are committed and ship with the plugin — running the script is a
**maintenance step** (re-pinning to newer upstream), not part of install.

The de-emphasis prefixes each `description:` with "Internal writing aid for
shopify-apps-doc-writer; invoked explicitly by its orchestrator, not
auto-triggered." so the broad upstream wording can't auto-fire on unrelated
tasks. The script applies it idempotently, so a re-pin never regresses it — no
manual step required.

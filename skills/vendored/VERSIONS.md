# Vendored from coreyhaines31/marketingskills

- Upstream: https://github.com/coreyhaines31/marketingskills
- Commit: c21a984a56da10fb6085e6334f6f60929220a4da
- Date: 2026-07-23
- Skills: product-marketing, copywriting, copy-editing, ai-seo, content-strategy
- Local modifications: each SKILL.md `description:` is prefixed with "Internal writing aid for shopify-feature-docs; invoked explicitly by its orchestrator, not auto-triggered." Upstream descriptions are broad ("when the user wants to write marketing copy") and would auto-fire on unrelated tasks. Content is otherwise unmodified.

## How to vendor / update

```bash
./scripts/vendor-skills.sh          # pins latest upstream main
./scripts/vendor-skills.sh <sha>    # pins a specific commit
```

The script clones the upstream repo (MIT licensed), copies exactly the five
skills above into this directory, and rewrites the Commit/Date lines here.
Do **not** vendor the full skill set — it pollutes skill triggering. The
orchestrator invokes these five explicitly.

After vendoring, de-emphasize each vendored SKILL.md description if needed so
it doesn't auto-fire on unrelated tasks (e.g. prefix with "Internal writing
aid for shopify-feature-docs; invoked explicitly by its orchestrator.") and
record that change under "Local modifications".

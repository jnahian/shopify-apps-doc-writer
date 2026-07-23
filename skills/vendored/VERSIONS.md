# Vendored from coreyhaines31/marketingskills

- Upstream: https://github.com/coreyhaines31/marketingskills
- Commit: _not yet vendored — run `scripts/vendor-skills.sh`_
- Date: _not yet vendored_
- Skills: product-marketing, copywriting, copy-editing, ai-seo, content-strategy
- Local modifications: (list any, ideally none)

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

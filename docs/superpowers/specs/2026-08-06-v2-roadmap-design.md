# v2 Roadmap — Design

**Date:** 2026-08-06
**Status:** agreed in brainstorm
**Outcome:** SPEC.md §13 rewritten from a flat backlog into an ordered v2 roadmap.

## Context

SPEC.md §13 listed four v2 candidates, written 2026-07-23 — before 0.2.0
shipped `/update-docs`, `/docs-check`, `/docs-deploy`, multi-engine capture,
and worktree isolation. This session re-planned the backlog against what
actually shipped and what hurts today.

**Driver:** the doc-quality ceiling. Docs ship fine but screenshots explain
less than they could (no annotation), and the writing phase still runs on the
doc-template fallback because the writing skills were never vendored.

**Shape:** incremental releases — each item ships alone as 0.3, 0.4, … when
done. No milestone bundling. Matches how 0.2.0 happened.

**Candidate pool:** the four §13 items plus three additions surfaced in this
session — external re-publish diffing (a deferred v1 non-goal), vendoring the
writing skills (unfinished v1 work), and scheduled staleness sweeps.

## Decision

Quality-first queue, cheap win before the big item (chosen over
"annotation-first", which puts the largest riskiest item at the head of the
queue with nearly-free quality work idling behind it, and over
"fortify-first", which over-invests in freshness that 0.2.0 largely solved).

Committed order: **0.3 vendor writing skills → 0.4 annotation pipeline →
0.5 external re-publish diffing → 0.6 scheduled staleness sweeps.**
Deferred, uncommitted: BetterDocs/docs-site MCP target, multi-locale capture,
demo-data seeding.

Per-item scope boundaries, constraints, and deferral reasons are recorded in
SPEC.md §13, which is the living document; this design doc records why.

## Out of scope for this session

No implementation, no version bump, no CHANGELOG entry — the SPEC.md edit is
docs-only and ships nothing to installed users. Each committed item gets its
own brainstorm → spec → plan cycle when its turn comes.

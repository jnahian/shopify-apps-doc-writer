#!/usr/bin/env bash
# Vendor the five marketing skills from coreyhaines31/marketingskills (MIT)
# into skills/vendored/, pinning the commit in VERSIONS.md.
#
# Usage: ./scripts/vendor-skills.sh [commit-sha]   (default: upstream main)
set -euo pipefail

UPSTREAM="https://github.com/coreyhaines31/marketingskills"
SKILLS=(product-marketing copywriting copy-editing ai-seo content-strategy)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$PLUGIN_ROOT/skills/vendored"
PIN="${1:-}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Cloning $UPSTREAM …"
git clone --quiet "$UPSTREAM" "$tmp/upstream"
if [[ -n "$PIN" ]]; then
  git -C "$tmp/upstream" checkout --quiet "$PIN"
fi
sha="$(git -C "$tmp/upstream" rev-parse HEAD)"

for skill in "${SKILLS[@]}"; do
  # Upstream layout may nest skills under skills/ or keep them top-level.
  src=""
  for candidate in "$tmp/upstream/skills/$skill" "$tmp/upstream/$skill"; do
    [[ -d "$candidate" ]] && src="$candidate" && break
  done
  if [[ -z "$src" ]]; then
    echo "ERROR: skill '$skill' not found in upstream — check the repo layout." >&2
    exit 1
  fi
  rm -rf "$DEST/$skill"
  cp -R "$src" "$DEST/$skill"
  echo "  vendored $skill"
done

# De-emphasize each description so the broad upstream wording ("when the user
# wants to write marketing copy") can't auto-fire on unrelated tasks. The
# orchestrator invokes these explicitly, so they must NOT trigger on their own.
# Applied here (not left as a manual reminder) so a re-pin never regresses it.
PREFIX="Internal writing aid for shopify-apps-doc-writer; invoked explicitly by its orchestrator, not auto-triggered. "
for skill in "${SKILLS[@]}"; do
  node -e '
    const fs = require("fs"), p = process.argv[1], prefix = process.argv[2];
    let s = fs.readFileSync(p, "utf8");
    if (s.includes(prefix)) process.exit(0);              // already de-emphasized
    const out = s.replace(/^description:\s*("?)/m, (m, q) => `description: ${q}${prefix}`);
    if (out === s) { console.error(`WARN: no description line in ${p}`); process.exit(0); }
    fs.writeFileSync(p, out);
  ' "$DEST/$skill/SKILL.md" "$PREFIX"
done
echo "  de-emphasized all vendored SKILL.md descriptions"

today="$(date +%Y-%m-%d)"
sed -i.bak \
  -e "s|^- Commit: .*|- Commit: $sha|" \
  -e "s|^- Date: .*|- Date: $today|" \
  "$DEST/VERSIONS.md"
rm -f "$DEST/VERSIONS.md.bak"

echo "Done. Pinned $sha ($today) in skills/vendored/VERSIONS.md."

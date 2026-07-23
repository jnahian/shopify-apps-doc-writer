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

today="$(date +%Y-%m-%d)"
sed -i.bak \
  -e "s|^- Commit: .*|- Commit: $sha|" \
  -e "s|^- Date: .*|- Date: $today|" \
  "$DEST/VERSIONS.md"
rm -f "$DEST/VERSIONS.md.bak"

echo "Done. Pinned $sha ($today) in skills/vendored/VERSIONS.md."
echo "Review the vendored SKILL.md descriptions and de-emphasize them if they could auto-fire on unrelated tasks."

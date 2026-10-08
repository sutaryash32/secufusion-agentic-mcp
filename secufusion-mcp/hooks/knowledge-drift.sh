#!/usr/bin/env bash
# Silent unless drift detected.
# Checks if SecuFusion knowledge layer is stale.

ROOT="${1:-.}"
SPEC_FILE="$ROOT/.secufusion-project-spec.json"
DOCS_DIR="$ROOT/docs"
CLAUDE_MD="$ROOT/CLAUDE.md"

# No knowledge layer yet → silent
if [ ! -f "$SPEC_FILE" ] && [ ! -d "$DOCS_DIR" ]; then
  exit 0
fi

# Check git — if no git, skip silently
if ! git -C "$ROOT" rev-parse --git-dir \
     > /dev/null 2>&1; then
  exit 0
fi

# Find when knowledge was last updated
LAST_SPEC=$(git -C "$ROOT" log -1 \
  --format="%H" -- \
  ".secufusion-project-spec.json" \
  "docs/" "CLAUDE.md" 2>/dev/null)

if [ -z "$LAST_SPEC" ]; then
  exit 0
fi

# Count source files changed since last doc update
CHANGED=$(git -C "$ROOT" diff \
  --name-only "$LAST_SPEC"..HEAD \
  -- "src/" "*/src/" \
     "pom.xml" "*/pom.xml" \
     "application*.yml" \
     "*/application*.yml" \
  2>/dev/null | wc -l | tr -d ' ')

if [ "$CHANGED" -gt 10 ]; then
  echo "⚠️  SecuFusion knowledge layer may be stale."
  echo "   $CHANGED source file(s) changed since"
  echo "   last /sfn:refresh."
  echo "   Run /sfn:doctor to check,"
  echo "   /sfn:refresh to update."
fi

exit 0

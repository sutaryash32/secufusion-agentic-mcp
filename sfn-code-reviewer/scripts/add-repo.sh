#!/usr/bin/env bash
# Onboards one repo to the CI review: writes azure-pipelines-sfn-review.yml into it and, if the repo is
# not in config/repos.yml yet, adds a stub block here (stack detected) for you to complete.
# Writes files only — never commits, pushes or creates pipelines.
#
#   scripts/add-repo.sh <repo-path> [--key <repoKey>] [--fail-on blocker|major|none]
#                       [--on-review-error warn|fail] [--ref v0.6.0] [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="" KEY="" FAIL_ON="blocker" ON_ERR="warn" REF="" FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    --on-review-error) ON_ERR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) REPO="$1"; shift ;;
  esac
done
[[ -n "$REPO" ]] || { echo "usage: add-repo.sh <repo-path> [--key K] [--fail-on S] [--on-review-error E] [--ref vX] [--force]" >&2; exit 2; }
REPO="$(cd "$REPO" && git rev-parse --show-toplevel)"
KEY="${KEY:-$(basename "$REPO")}"
REF="${REF:-v$(node -p "require('$ROOT/package.json').version")}"
OUTFILE="$REPO/azure-pipelines-sfn-review.yml"

if [[ -f "$OUTFILE" && $FORCE -eq 0 ]]; then echo "$OUTFILE exists — use --force to overwrite" >&2; exit 2; fi
cat > "$OUTFILE" <<YML
# sfn-code-reviewer — AI review on pull requests into develop.
# Add as a Build Validation policy: Repos → Branches → develop → Branch policies → Build validation.
# Start it as Optional (shadow mode); make it Required once its findings are trusted.
trigger: none
pr: none

resources:
  repositories:
    - repository: reviewer
      type: git
      name: SFCloud-MSSP/sfn-code-reviewer
      ref: refs/tags/${REF}

extends:
  template: ci/azure/sfn-review.yml@reviewer
  parameters:
    repoKey: ${KEY}
    failOn: ${FAIL_ON}
    onReviewError: ${ON_ERR}
    # engine: openai         # needs OPENAI_API_KEY or AZURE_OPENAI_API_KEY in the variable group
    # crossVerify: true      # needs both providers' keys
    # liveDb: true           # SFN_REVIEW_DB_URL (read-only role) in the variable group
    # osv: true              # sends changed dependency names+versions to api.osv.dev
YML
echo "wrote $OUTFILE (repoKey $KEY, ref $REF, failOn $FAIL_ON, onReviewError $ON_ERR)"

if grep -qE "^  ${KEY}:" "$ROOT/config/repos.yml"; then
  echo "$KEY is already in config/repos.yml"
else
  if [[ -f "$REPO/pom.xml" ]]; then STACK=java-spring
  elif [[ -f "$REPO/package.json" ]] && grep -qE '"(vite|react)"' "$REPO/package.json"; then STACK=react-vite
  else STACK=unknown; fi
  # Insert before the riskRules section so it lands inside `repos:`.
  BLOCK="  ${KEY}:\n    stack: ${STACK}\n    # TODO(add-repo): fill in — see docs/adding-a-repo.md\n    # package: com.secufusion.<x>\n    # migrations: src/main/resources/db/migration\n    # test: mvn -q test\n    # apiPrefix: /api/<x>\n    # kafka: { produces: [], consumes: [] }\n"
  node -e "
    const fs=require('fs');const f='$ROOT/config/repos.yml';const s=fs.readFileSync(f,'utf8');
    const i=s.indexOf('\n# Deterministic risk scoring');
    if(i<0){console.error('could not find riskRules section');process.exit(1)}
    fs.writeFileSync(f, s.slice(0,i)+'\n'+\"$BLOCK\".replace(/\\\\n/g,'\n').replace(/\n$/,'')+s.slice(i));"
  (cd "$ROOT" && node scripts/build-anthropic.mjs >/dev/null)
  echo "added a $STACK stub for $KEY to config/repos.yml (complete the TODOs) and rebuilt the plugin"
fi

cat <<NEXT

Next (not done by this script):
  1. Review and commit $(basename "$OUTFILE") in $KEY; commit config/repos.yml here if it changed.
  2. Create a pipeline from it (Pipelines → New → Azure Repos Git → $KEY → Existing YAML).
  3. Add it as an Optional build-validation policy on develop.
  4. Make sure the build service can read the other sfn repos and the variable group (docs/ci-setup.md).
NEXT

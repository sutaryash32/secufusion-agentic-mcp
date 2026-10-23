#!/usr/bin/env bash
# Installs (or removes) a git pre-push hook that reviews what you're about to push and blocks the
# push on CONFIRMED findings at/above a threshold (default: blocker). Local only.
#
#   scripts/install-hook.sh <repo> [--quick] [--level quick|standard|deep] [--fail-on blocker|major] [--force]
#
# --quick: deterministic checks only (no model, ~1 s, free) — migrations, @PreAuthorize, secrets,
#          deploy-order across repos. Without it the hook runs the model review (minutes, costs).
#   scripts/install-hook.sh <repo> --uninstall
#
# Bypass once:  SFN_SKIP_REVIEW=1 git push    (or git push --no-verify)
# A broken review (no model access, timeout) never blocks a push — it warns.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="" LEVEL="quick" FAIL_ON="blocker" FORCE=0 UNINSTALL=0 QUICK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --level) LEVEL="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --quick) QUICK=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) REPO="$1"; shift ;;
  esac
done
[[ -n "$REPO" ]] || { echo "usage: install-hook.sh <repo> [--level L] [--fail-on S] [--force] | --uninstall" >&2; exit 2; }
REPO="$(cd "$REPO" && git rev-parse --show-toplevel)"
HOOKS="$(cd "$REPO" && git rev-parse --git-path hooks)"
[[ "$HOOKS" = /* ]] || HOOKS="$REPO/$HOOKS"
HOOK="$HOOKS/pre-push"
PREV="$HOOKS/pre-push.sfn-prev"
MARK="# sfn-code-reviewer pre-push hook"

if [[ $UNINSTALL -eq 1 ]]; then
  if [[ -f "$HOOK" ]] && grep -q "$MARK" "$HOOK"; then
    rm "$HOOK"
    [[ -f "$PREV" ]] && mv "$PREV" "$HOOK"
    echo "removed sfn pre-push hook from $REPO"
  else
    echo "no sfn pre-push hook in $REPO"
  fi
  exit 0
fi

if [[ -n "$(cd "$REPO" && git config core.hooksPath || true)" && $FORCE -eq 0 ]]; then
  echo "core.hooksPath is set ($(cd "$REPO" && git config core.hooksPath)) — hooks are managed by another tool. Re-run with --force to install there anyway." >&2
  exit 2
fi
mkdir -p "$HOOKS"
if [[ -f "$HOOK" ]] && ! grep -q "$MARK" "$HOOK"; then
  mv "$HOOK" "$PREV"
  echo "existing pre-push hook kept as $(basename "$PREV") and chained (runs first)"
fi

cat > "$HOOK" <<HOOK
#!/usr/bin/env bash
$MARK — remove with: $ROOT/scripts/install-hook.sh "$REPO" --uninstall
[[ -n "\${SFN_SKIP_REVIEW:-}" ]] && exit 0
input="\$(cat)"
HOOKS_DIR="\$(dirname "\$0")"
if [[ -x "\$HOOKS_DIR/pre-push.sfn-prev" ]]; then
  printf '%s\n' "\$input" | "\$HOOKS_DIR/pre-push.sfn-prev" "\$@" || exit \$?
fi
ZERO=0000000000000000000000000000000000000000
TOP="\$(git rev-parse --show-toplevel)"
mkdir -p "\$TOP/.sfn-review"
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -z "\$local_sha" || "\$local_sha" == "\$ZERO" ]] && continue          # branch deletion
  args=(--repo "\$TOP" --head "\$local_sha" --level "${LEVEL}" --out "\$TOP/.sfn-review/pre-push")
  if [[ "\$remote_sha" != "\$ZERO" ]] && git cat-file -e "\$remote_sha" 2>/dev/null; then args+=(--base "\$remote_sha"); fi
  if [[ "${QUICK}" == "1" ]]; then
    qargs=(--repo "\$TOP" --head "\$local_sha" --fail-on "${FAIL_ON}")
    if [[ "\$remote_sha" != "\$ZERO" ]] && git cat-file -e "\$remote_sha" 2>/dev/null; then qargs+=(--base "\$remote_sha"); fi
    node "$ROOT/scripts/quick-check.mjs" "\${qargs[@]}" || status=1
    continue
  fi
  echo "[sfn-review] reviewing \${local_ref#refs/heads/} before push (level ${LEVEL}; skip with SFN_SKIP_REVIEW=1)…" >&2
  if ! bash "$ROOT/scripts/run-review.sh" "\${args[@]}" >/dev/null 2>"\$TOP/.sfn-review/pre-push.log"; then
    echo "[sfn-review] review could not run — push allowed. See .sfn-review/pre-push.log" >&2
    continue
  fi
  node "$ROOT/scripts/gate.mjs" --in "\$TOP/.sfn-review/pre-push/review-result.json" --fail-on "${FAIL_ON}" --on-review-error warn >&2 || status=1
done <<< "\$input"
if [[ \$status -ne 0 ]]; then
  echo "[sfn-review] push blocked: confirmed ${FAIL_ON}+ finding(s). Report: .sfn-review/pre-push/report.html · fix with /sfn:fix · bypass: SFN_SKIP_REVIEW=1 git push" >&2
fi
exit \$status
HOOK
chmod +x "$HOOK"
echo "installed sfn pre-push hook in $REPO ($([[ $QUICK -eq 1 ]] && echo 'quick deterministic check' || echo "model review, level $LEVEL"), blocks on confirmed $FAIL_ON+)"

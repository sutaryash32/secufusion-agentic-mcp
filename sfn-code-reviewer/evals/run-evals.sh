#!/usr/bin/env bash
# Runs the reviewer against known cases and scores it. Calls the model — run on demand, not on every
# commit. Use it before releasing any change to prompts/, rules/ or config/.
#
#   evals/run-evals.sh [--engine anthropic|openai] [--case <name>] [--level <level>]
#
# Each case in evals/cases/<name>/:
#   case.json  repoKey, description, expect { mustFind[], mustNotFind[], verdictIn[] }
#   base/      the repo before (committed on `develop`)
#   head/      files that change (copied over base, committed on `feature`)
#   delete.txt optional: paths removed in head
#   estate/<repo>/  optional sibling repos (for cross-repo cases)
# Or a HISTORY case (from evals/learn-from-fix.mjs): case.json with "type": "history", repoKey, base,
#   head, estate — reviewed from your local clones as of that date (skipped when SFN_SKIP_HISTORY=1,
#   e.g. in CI where the estate isn't cloned).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="" ONLY="" LEVEL="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --case) ONLY="$2"; shift 2 ;;
    --level) LEVEL="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

ENGINE="${ENGINE:-$(node -e "console.log(require('$ROOT/engines/anthropic/skills/review/config/review.json').engine)")}"
WORK="$ROOT/evals/.work"
RESULTS=()
GIT=(git -c user.name=sfn-evals -c user.email=evals@localhost -c commit.gpgsign=false)

for dir in "$ROOT"/evals/cases/*/; do
  name="$(basename "$dir")"
  [[ -n "$ONLY" && "$name" != "$ONLY" ]] && continue
  repoKey="$(node -e "console.log(require('$dir/case.json').repoKey)")"
  if [[ "$(node -e "console.log(require('$dir/case.json').type||'')")" == "history" ]]; then
    # Real change from git history: worktrees at that date, reviewed as-is, then removed.
    if [[ -n "${SFN_SKIP_HISTORY:-}" ]]; then echo "[evals] $name: history case skipped (SFN_SKIP_HISTORY)" >&2; continue; fi
    estate="$WORK/$name"
    info="$(node "$ROOT/evals/history-case.mjs" prepare "$dir" "$estate")" || { echo "[evals] $name: could not prepare (repos missing?)" >&2; continue; }
    hrepo="$(node -e "console.log(JSON.parse(process.argv[1]).repo)" "$info")"
    hbase="$(node -e "console.log(JSON.parse(process.argv[1]).base)" "$info")"
    hhead="$(node -e "console.log(JSON.parse(process.argv[1]).head)" "$info")"
    echo "=== $name ($repoKey, history ${hbase:0:8}..${hhead:0:8})" >&2
    bash "$ROOT/scripts/run-review.sh" --repo "$hrepo" --repo-key "$repoKey" --base "$hbase" --head "$hhead" \
      --estate-root "$estate" --out "$estate/out" --level "$LEVEL" --engine "$ENGINE" >/dev/null || echo "[evals] $name: review run failed" >&2
    node "$ROOT/evals/history-case.mjs" cleanup "$estate"
    RESULTS+=("$name")
    continue
  fi
  estate="$WORK/$name"
  repo="$estate/$repoKey"
  rm -rf "$estate" && mkdir -p "$repo"

  cp -R "$dir/base/." "$repo/"
  ( cd "$repo" && "${GIT[@]}" init -q -b develop && "${GIT[@]}" add -A && "${GIT[@]}" commit -q -m base \
    && "${GIT[@]}" checkout -q -b feature )
  cp -R "$dir/head/." "$repo/"
  if [[ -f "$dir/delete.txt" ]]; then (cd "$repo" && xargs rm -f < "$dir/delete.txt"); fi
  ( cd "$repo" && "${GIT[@]}" add -A && "${GIT[@]}" commit -q -m change )

  if [[ -d "$dir/estate" ]]; then
    for other in "$dir"/estate/*/; do
      o="$estate/$(basename "$other")"
      mkdir -p "$o" && cp -R "$other/." "$o/"
      ( cd "$o" && "${GIT[@]}" init -q -b develop && "${GIT[@]}" add -A && "${GIT[@]}" commit -q -m estate )
    done
  fi

  echo "=== $name ($repoKey)" >&2
  ARGS=(--repo "$repo" --repo-key "$repoKey" --base develop --head HEAD --estate-root "$estate" --out "$estate/out" --level "$LEVEL")
  ARGS+=(--engine "$ENGINE")
  bash "$ROOT/scripts/run-review.sh" "${ARGS[@]}" >/dev/null || echo "[evals] $name: review run failed" >&2
  RESULTS+=("$name")
done

RC=0
node "$ROOT/evals/score.mjs" --work "$WORK" --cases "$ROOT/evals/cases" --engine "$ENGINE" "${RESULTS[@]}" || RC=$?
# Keep every run's outputs (scope, raw engine output, logs, result) so misses can be diagnosed later.
KEEP="$ROOT/evals/results/runs/$(date -u +%Y%m%dT%H%M%SZ)-$ENGINE"
mkdir -p "$KEEP"
for name in "${RESULTS[@]}"; do [[ -d "$WORK/$name/out" ]] && cp -R "$WORK/$name/out" "$KEEP/$name"; done
echo "outputs kept in $KEEP" >&2
exit $RC

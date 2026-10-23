#!/usr/bin/env bash
# sfn-code-reviewer — single entry point, locally and in CI.
#
#   scripts/run-review.sh [--repo <path>] [--repo-key <key>] [--base <ref>] [--head <ref>]
#                         [--working-tree] [--level auto|quick|standard|deep]
#                         [--pr <id>] [--engine anthropic|openai] [--cross-verify]
#                         [--live-db] [--osv] [--post] [--estate-root <dir>] [--out <dir>] [--ci]
#
#   --pr <id>   review an Azure DevOps PR (az login / AZURE_DEVOPS_PAT); --post then posts the result to it
#   --live-db   read-only schema snapshot from $SFN_REVIEW_DB_URL (overrides integrations.liveDb.enabled)
#   --osv       vulnerability lookup for changed dependencies on api.osv.dev (overrides integrations.osv.enabled)
#   --consensus N  run the engine N times in parallel and keep findings that repeat (config: consensus)
#
# Outputs in <out> (default <repo>/.sfn-review/):
#   scope.json  raw-output.json  review-result.json  report.html  sfn-review.sarif
#   previous-result.json (the prior run's result — used for the "since last review" delta)
#
# Auth (anthropic engine):
#   ANTHROPIC_API_KEY set            -> API key, minimal (--bare) mode. Required in CI.
#   CLAUDE_CODE_USE_FOUNDRY=1 (+Azure creds) / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
#                                    -> that provider, --bare mode.
#   none of the above, not --ci      -> your Claude Code login (no key needed).
#
# Exit: 0 review produced (see the gate for pass/fail) · 2 usage/setup error · 3 review output invalid
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Local settings (see .env.example). Values already set in the environment win; empty lines are ignored.
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [[ -z "$val" || -n "${!key:-}" ]] && continue
    export "$key=$val"
  done < "$ROOT/.env"
fi

BUNDLE="$ROOT/engines/anthropic/skills/review"

REPO="" REPO_KEY="" BASE="" HEAD="HEAD" WORKING_TREE=0 LEVEL="auto" ENGINE="" ESTATE_ROOT="" OUT="" CI_MODE=0 CROSS="" PR="" POST=0 FORCE_DB="" FORCE_OSV="" RUNS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --repo-key) REPO_KEY="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --working-tree) WORKING_TREE=1; shift ;;
    --level) LEVEL="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --estate-root) ESTATE_ROOT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --ci) CI_MODE=1; shift ;;
    --cross-verify) CROSS=1; shift ;;
    --pr) PR="$2"; shift 2 ;;
    --post) POST=1; shift ;;
    --live-db) FORCE_DB=1; shift ;;
    --osv) FORCE_OSV=1; shift ;;
    --consensus) RUNS="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "[sfn-review] unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[sfn-review] $*" >&2; }
cfg() { node -e "const c=require('$BUNDLE/config/review.json');const v=$1;process.stdout.write(String(v??''))"; }

[[ -f "$BUNDLE/config/review.json" ]] || { log "plugin bundle missing — run 'npm run build' in $ROOT"; exit 2; }
REPO="$(cd "${REPO:-$(git rev-parse --show-toplevel)}" && pwd)"
OUT="${OUT:-$REPO/.sfn-review}"
mkdir -p "$OUT"
ENGINE="${ENGINE:-$(cfg c.engine)}"
[[ -z "$CROSS" && "$(cfg "c.verify?.mode")" == "cross" ]] && CROSS=1

# Keep the last result for the "since last review" delta.
PREV_ARGS=()
if [[ -f "$OUT/review-result.json" ]]; then
  mv "$OUT/review-result.json" "$OUT/previous-result.json"
  PREV_ARGS=(--previous "$OUT/previous-result.json")
fi
rm -f "$OUT/raw-output.json" "$OUT"/raw-run-*.json "$OUT"/engine-*.log "$OUT/raw-crossverified.json" "$OUT/review-result.error.json"

# ---------------------------------------------------------------- 1. scope (deterministic)
SCOPE_ARGS=(--repo "$REPO" --head "$HEAD" --level "$LEVEL" --out "$OUT/scope.json")
[[ -n "$REPO_KEY" ]] && SCOPE_ARGS+=(--repo-key "$REPO_KEY")
[[ -n "$BASE" ]] && SCOPE_ARGS+=(--base "$BASE")
[[ -n "$ESTATE_ROOT" ]] && SCOPE_ARGS+=(--estate-root "$ESTATE_ROOT")
[[ $WORKING_TREE -eq 1 ]] && SCOPE_ARGS+=(--working-tree)
[[ -n "$PR" ]] && SCOPE_ARGS+=(--pr "$PR")
node "$ROOT/scripts/collect-scope.mjs" "${SCOPE_ARGS[@]}" >/dev/null

# Optional enrichment (each is a no-op when disabled or unavailable; never fails the review).
SFN_FORCE_LIVEDB="$FORCE_DB" node "$ROOT/scripts/db-snapshot.mjs" --scope "$OUT/scope.json" --out "$OUT/db-schema.json" || true
SFN_FORCE_OSV="$FORCE_OSV" node "$ROOT/scripts/dep-audit.mjs" --scope "$OUT/scope.json" --out "$OUT/dep-audit.json" || true
# Fast deterministic checks (no model): merged into the result by finalize and shown to the specialists.
if node "$ROOT/scripts/quick-check.mjs" --scope "$OUT/scope.json" --out "$OUT/quick-check.json" --quiet; then
  node -e "const f=require('fs');const p='$OUT/scope.json';const s=JSON.parse(f.readFileSync(p,'utf8'));s.quickCheckFile='$OUT/quick-check.json';f.writeFileSync(p,JSON.stringify(s,null,2))"
fi

SKIP="$(node -e "process.stdout.write(String(require('$OUT/scope.json').skip))")"
ENGINE_JSON='{"provider":"none"}'

if [[ "$SKIP" == "true" ]]; then
  node "$ROOT/scripts/finalize.mjs" --scope "$OUT/scope.json" --skipped --out "$OUT/review-result.json" --engine "$ENGINE_JSON" ${PREV_ARGS[@]+"${PREV_ARGS[@]}"}
else
  # -------------------------------------------------------------- 2. engine
  case "$ENGINE" in
    anthropic)
      command -v claude >/dev/null || { log "Claude Code CLI not found (npm i -g @anthropic-ai/claude-code)"; exit 2; }
      HAVE="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
      NEED="$(cfg c.anthropic.minCliVersion)"
      if [[ "$(printf '%s\n%s\n' "$NEED" "$HAVE" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" != "$NEED" ]]; then
        log "Claude Code CLI $HAVE is too old for the configured models (need >= $NEED). Run: claude update"; exit 2
      fi
      CLAUDE_ARGS=()
      if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then AUTH="api-key"; CLAUDE_ARGS+=(--bare)
      elif [[ -n "${CLAUDE_CODE_USE_FOUNDRY:-}" ]]; then AUTH="foundry"; CLAUDE_ARGS+=(--bare)
      elif [[ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ]]; then AUTH="bedrock"; CLAUDE_ARGS+=(--bare)
      elif [[ -n "${CLAUDE_CODE_USE_VERTEX:-}" ]]; then AUTH="vertex"; CLAUDE_ARGS+=(--bare)
      elif [[ $CI_MODE -eq 1 ]]; then
        log "CI needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_FOUNDRY + Azure credentials)."; exit 2
      else AUTH="login"
      fi
      MODEL="$(cfg c.anthropic.models.orchestrator)"
      BUDGET="$(cfg c.limits.maxBudgetUsd)"
      ENGINE_JSON="$(node -e "
        const c=require('$BUNDLE/config/review.json');
        let v='';try{v=require('child_process').execSync('claude --version',{encoding:'utf8'}).trim()}catch{}
        process.stdout.write(JSON.stringify({provider:'anthropic',auth:'$AUTH',cli:v,models:c.anthropic.models}))")"
      [[ "$AUTH" != "login" ]] && CLAUDE_ARGS+=(--max-budget-usd "$BUDGET")
      ESTATE="$(node -e "process.stdout.write(require('$OUT/scope.json').estateRoot)")"

      log "engine=anthropic auth=$AUTH model=$MODEL"
      engine_once() {   # $1 = raw output file, $2 = log file
      ( cd "$REPO" && claude -p "/sfn:review --scope $OUT/scope.json" \
          ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"} \
          --plugin-dir "$ROOT/engines/anthropic" \
          --model "$MODEL" \
          --settings "$ROOT/config/settings.ci.json" \
          --permission-mode dontAsk \
          --tools "Read,Grep,Glob,Bash,Agent,Skill" \
          --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
          --add-dir "$ESTATE" --add-dir "$BUNDLE" --add-dir "$OUT" \
          --json-schema "$(cat "$BUNDLE/schemas/review-result.inlined.json")" \
          --output-format json \
          --no-session-persistence \
          < /dev/null > "$1" 2> "$2" )
      }
      ;;
    openai)
      [[ -n "${OPENAI_API_KEY:-}${AZURE_OPENAI_API_KEY:-}" ]] || { log "OpenAI engine needs OPENAI_API_KEY (or AZURE_OPENAI_API_KEY)."; exit 2; }
      AUTH="$([[ -n "${AZURE_OPENAI_API_KEY:-}" ]] && echo azure-openai || echo api-key)"
      ENGINE_JSON="$(node -e "
        const c=require('$BUNDLE/config/review.json').openai;
        process.stdout.write(JSON.stringify({provider:'openai',auth:'$AUTH',baseUrl:process.env.OPENAI_BASE_URL||c.baseUrl,models:c.models}))")"
      log "engine=openai auth=$AUTH"
      engine_once() { node "$ROOT/engines/openai/runner.mjs" --scope "$OUT/scope.json" --out "$1" 2> "$2"; }
      ;;
    *) log "unknown engine '$ENGINE' (anthropic|openai)"; exit 2 ;;
  esac

  # Consensus: N independent runs (in parallel) for high-risk changes, merged by consensus.mjs.
  if [[ -z "$RUNS" ]]; then
    RUNS="$(node -e "
      const c=require('$BUNDLE/config/review.json').consensus||{};const s=require('$OUT/scope.json');
      process.stdout.write(String(c.enabled && (c.levels||['deep']).includes(s.level) ? (c.runs||2) : 1))")"
  fi
  set +e
  if [[ "$RUNS" -le 1 ]]; then
    engine_once "$OUT/raw-output.json" "$OUT/engine.log"
    RC=$?
    [[ $RC -ne 0 ]] && { log "engine exited with $RC — see $OUT/engine.log"; tail -20 "$OUT/engine.log" >&2 || true; }
  else
    log "consensus: $RUNS parallel runs"
    PIDS=()
    for i in $(seq 1 "$RUNS"); do engine_once "$OUT/raw-run-$i.json" "$OUT/engine-$i.log" & PIDS+=($!); done
    for p in "${PIDS[@]}"; do wait "$p"; done
    node "$ROOT/scripts/consensus.mjs" --scope "$OUT/scope.json" --out "$OUT/raw-output.json" \
      $(for i in $(seq 1 "$RUNS"); do printf '%s ' "$OUT/raw-run-$i.json"; done) 2>> "$OUT/engine.log"
    cat "$OUT"/engine-*.log >> "$OUT/engine.log" 2>/dev/null
    grep -h consensus "$OUT/engine.log" | tail -1 >&2 || true
  fi
  set -e

  # -------------------------------------------------------------- 3. cross-model verify (optional)
  RAW="$OUT/raw-output.json"
  if [[ -n "$CROSS" && -s "$RAW" ]]; then
    VERIFIER="$([[ "$ENGINE" == "anthropic" ]] && echo openai || echo anthropic)"
    CAN=0
    if [[ "$VERIFIER" == "openai" ]]; then
      [[ -n "${OPENAI_API_KEY:-}${AZURE_OPENAI_API_KEY:-}" ]] && CAN=1
    else
      command -v claude >/dev/null && { [[ $CI_MODE -eq 0 || -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_USE_FOUNDRY:-}" ]]; } && CAN=1
    fi
    if [[ $CAN -eq 1 ]]; then
      log "cross-verify with $VERIFIER"
      if node "$ROOT/scripts/cross-verify.mjs" --scope "$OUT/scope.json" --in "$RAW" \
           --out "$OUT/raw-crossverified.json" --verifier "$VERIFIER" 2>> "$OUT/engine.log"; then
        RAW="$OUT/raw-crossverified.json"
      else
        log "cross-verify failed — keeping the single-model result (see engine.log)"
      fi
    else
      log "cross-verify requested but $VERIFIER credentials are not available — single-model result"
    fi
  fi

  # -------------------------------------------------------------- 4. finalize (fails closed)
  node "$ROOT/scripts/finalize.mjs" --scope "$OUT/scope.json" --raw "$RAW" \
    --out "$OUT/review-result.json" --engine "$ENGINE_JSON" ${PREV_ARGS[@]+"${PREV_ARGS[@]}"} || exit 3
fi

# ---------------------------------------------------------------- 5. outputs
# Archive every run for team metrics (scripts/metrics.mjs --in <out>/history).
mkdir -p "$OUT/history"
cp "$OUT/review-result.json" "$OUT/history/$(date -u +%Y%m%dT%H%M%SZ)-$(node -e "process.stdout.write(String(require('$OUT/review-result.json').scope?.headSha??'').slice(0,10))").json"
node "$ROOT/scripts/render-report.mjs" --in "$OUT/review-result.json" --out "$OUT/report.html"
node "$ROOT/scripts/to-sarif.mjs" --in "$OUT/review-result.json" --out "$OUT/sfn-review.sarif"

if [[ $POST -eq 1 ]]; then
  [[ -n "$PR" ]] || { log "--post needs --pr <id>"; exit 2; }
  node "$ROOT/scripts/post-ado-pr.mjs" --in "$OUT/review-result.json"
fi

if [[ $CI_MODE -eq 0 ]]; then
  node "$ROOT/scripts/gate.mjs" --in "$OUT/review-result.json" || true   # advisory locally
  log "open $OUT/report.html"
fi

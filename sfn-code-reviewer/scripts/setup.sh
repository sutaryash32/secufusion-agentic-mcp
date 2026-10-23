#!/usr/bin/env bash
# One-command local setup for sfn-code-reviewer. Safe to re-run; changes nothing it doesn't report.
#
#   scripts/setup.sh [--dry-run] [--skip-plugin]
#
# Checks Node and the Claude Code CLI version, installs deps, verifies the generated plugin, registers
# and installs the `sfn` plugin in Claude Code, creates .env from .env.example if missing, and checks
# the optional pieces (az login, psql). Never writes keys and never edits your shell config.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0 SKIP_PLUGIN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-plugin) SKIP_PLUGIN=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARN=$((WARN + 1)); }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
run()  { if [[ $DRY -eq 1 ]]; then echo "    (dry-run) would run: $*" >&2; else "$@"; fi; }
WARN=0 FAIL=0
vge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$2" ]]; }

echo "sfn-code-reviewer setup ($ROOT)"

echo "1. Node"
if command -v node >/dev/null; then
  NV="$(node -p 'process.versions.node')"
  vge "$NV" 20.0.0 && ok "node $NV" || bad "node $NV — need >= 20"
else bad "node not found — install Node 20+"; fi

echo "2. Claude Code CLI"
NEED="$(grep -E '^\s+minCliVersion:' "$ROOT/config/review.config.yml" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
if command -v claude >/dev/null; then
  HAVE="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if vge "$HAVE" "$NEED"; then ok "claude $HAVE ($(command -v claude))"
  else
    bad "claude $HAVE at $(command -v claude) is older than $NEED"
    [[ -x "$HOME/.local/bin/claude" ]] && echo "    a newer one is at ~/.local/bin/claude — put it first: export PATH=\"\$HOME/.local/bin:\$PATH\" (add to ~/.zshrc)" \
      || echo "    run: claude update   (or 'claude install' for the native installer, no sudo)"
  fi
else bad "claude not found — npm i -g @anthropic-ai/claude-code, or the native installer"; fi

echo "3. Dependencies and plugin build"
if [[ -d "$ROOT/node_modules/js-yaml" ]]; then ok "node_modules present"; else run npm --prefix "$ROOT" ci --no-audit --no-fund >/dev/null && ok "npm ci"; fi
if [[ $DRY -eq 0 ]]; then
  (cd "$ROOT" && node scripts/build-anthropic.mjs --check >/dev/null 2>&1) && ok "generated plugin is up to date" || { warn "plugin out of date — rebuilding"; (cd "$ROOT" && node scripts/build-anthropic.mjs >/dev/null) && ok "rebuilt"; }
fi

echo "4. Claude Code plugin 'sfn'"
if [[ $SKIP_PLUGIN -eq 1 ]]; then warn "skipped (--skip-plugin)"
elif command -v claude >/dev/null; then
  if claude plugin marketplace list 2>/dev/null | grep -q "sfn-code-reviewer"; then ok "marketplace sfn-code-reviewer registered"
  else run claude plugin marketplace add "$ROOT" >/dev/null && ok "marketplace sfn-code-reviewer added"; fi
  if claude plugin list 2>/dev/null | grep -q "sfn@sfn-code-reviewer"; then
    run claude plugin marketplace update sfn-code-reviewer >/dev/null 2>&1; ok "plugin sfn installed (marketplace refreshed)"
  else run claude plugin install sfn@sfn-code-reviewer >/dev/null && ok "plugin sfn installed — use /sfn:review in any sfn repo"; fi
fi

echo "5. Local settings"
if [[ -f "$ROOT/.env" ]]; then ok ".env exists (git-ignored)"
else run cp "$ROOT/.env.example" "$ROOT/.env" && ok ".env created from .env.example — all keys optional; empty = use your Claude login"; fi

echo "6. Optional integrations"
if command -v az >/dev/null && az account show >/dev/null 2>&1; then ok "az login active — PR review by number, posting, Boards, metrics"
else warn "az not logged in — needed for --pr, --post, /sfn:bugs, feedback (or set AZURE_DEVOPS_PAT in .env)"; fi
command -v psql >/dev/null && ok "psql present — --live-db available" || warn "psql not found — only needed for --live-db"

echo
if [[ $FAIL -gt 0 ]]; then echo "Setup incomplete: $FAIL problem(s), $WARN warning(s)."; exit 1; fi
echo "Ready ($WARN warning(s)). Try: cd ../sfn-tenants-api && claude  →  /sfn:review"

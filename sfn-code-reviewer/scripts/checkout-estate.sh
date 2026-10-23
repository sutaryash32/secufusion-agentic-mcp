#!/usr/bin/env bash
# CI only: shallow-clone every repo listed in config/repos.yml (except the one under review) next to
# it, so the contracts specialist can find consumers in other repos. Reads the list at run time —
# adding a service to repos.yml is enough, the pipeline template never changes.
#
#   scripts/checkout-estate.sh <estate-root> <repo-under-review>
#
# Needs SYSTEM_ACCESSTOKEN and SYSTEM_COLLECTIONURI (Azure Pipelines). The build identity needs Read
# on those repos, and "Limit job authorization scope to referenced Azure DevOps repositories" must be
# off for the pipeline (or the repos referenced) — otherwise clones fail and are reported as missing.
# A failed clone never fails the build: the review marks cross-repo checks for that repo as not done.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESTATE_ROOT="$1"
SELF="$2"
REPOS_JSON="$ROOT/engines/anthropic/skills/review/config/repos.json"

: "${SYSTEM_ACCESSTOKEN:?map SYSTEM_ACCESSTOKEN: \$(System.AccessToken) in the step env}"
: "${SYSTEM_COLLECTIONURI:?not running in Azure Pipelines}"

read -r PROJECT BRANCH < <(node -e "const e=require('$REPOS_JSON').estate;console.log(e.adoProject, e.defaultBranch)")
mapfile -t REPOS < <(node -e "Object.keys(require('$REPOS_JSON').repos).forEach(r=>console.log(r))")

mkdir -p "$ESTATE_ROOT"
for repo in "${REPOS[@]}"; do
  [[ "$repo" == "$SELF" ]] && continue
  dest="$ESTATE_ROOT/$repo"
  if [[ -d "$dest/.git" ]]; then echo "[estate] $repo already present"; continue; fi
  url="${SYSTEM_COLLECTIONURI%/}/${PROJECT}/_git/${repo}"
  # SFN_ESTATE_FULL=1: full history + all branches (learn-from-fix / auto-learn need blame and log -L)
  if [[ -n "${SFN_ESTATE_FULL:-}" ]]; then CLONE_ARGS=(--no-single-branch); else CLONE_ARGS=(--depth 1 --single-branch --branch "$BRANCH"); fi
  if git -c http.extraheader="AUTHORIZATION: bearer ${SYSTEM_ACCESSTOKEN}" \
       clone --quiet "${CLONE_ARGS[@]}" "$url" "$dest" 2>/tmp/estate-clone.err; then
    echo "[estate] $repo @ $BRANCH"
  else
    echo "##vso[task.logissue type=warning]sfn-review: could not clone $repo ($(head -1 /tmp/estate-clone.err)); cross-repo checks for it will be skipped."
  fi
done

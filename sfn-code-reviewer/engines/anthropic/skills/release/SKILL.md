---
name: release
description: Release-readiness check for one or more sfn repos — what's in the release (PRs, work items) and what ops must do (migrations in order, new env vars and config, feature flags, dependency upgrades, removed endpoints/topics). Use when the user asks if a release is ready, for release notes, a deployment checklist, or runs /sfn:release.
argument-hint: "[repos...] [--from <tag>] [--to <ref>] [--review]"
---

# Release readiness

1. Repos: the ones the user names (paths or keys like `sfn-iam-api` → `<estate>/sfn-iam-api`), else the
   current repo. For "the platform" / "all APIs", use every API repo in
   `<review-skill-dir>/config/repos.json` that exists next to the current repo.
2. Range: `--from` defaults to each repo's latest tag reachable from `--to`; `--to` defaults to
   `origin/develop`. If the user names a release branch (`release/1.0.11`), pass it as `--to`. Run
   `git fetch --tags --quiet` in each repo first so tags are current.
3. Run (deterministic, read-only):
   ```bash
   node <review-skill-dir>/bin/release-check.mjs --repo <path> [--repo <path> ...] [--from X] [--to Y] \
     --out <current repo>/.sfn-release
   ```
   Add `--review` only if the user asks for a review of the release too — it runs a deep review per repo
   and takes longer.
4. Present: the overall verdict, then per repo the **attention** items first, the ops checklist
   (migrations in order — remind that they're applied manually and the three APIs share one database,
   so check cross-repo ordering when several repos add migrations touching the same tables), env vars
   without defaults, flags on by default, major dependency upgrades, removed endpoints/topics, and the
   PR list. Link `release-readiness.html` (it has tickable checkboxes) and `.md` (paste into the release
   ticket).

`<review-skill-dir>` is the `review` skill folder next to this one.

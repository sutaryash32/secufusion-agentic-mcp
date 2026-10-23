# Risk scoring — how deep the review goes

The score is **deterministic** (computed by `bin/collect-scope.mjs`, no model involved), so the same
change always gets the same depth locally and in CI.

1. Every changed file path is matched against `riskRules` in `config/repos.json`. Each rule that matches
   at least one file adds its `weight` once and turns on its `specialists`.
2. Size bonus from `sizeRisk` (highest tier that applies).
3. Score is capped at 10.

| Score | Level (`--level auto`) | Specialists | Verify | General pass |
|---|---|---|---|---|
| 0–2 | quick | only those turned on by rules (may be none) | no | yes |
| 3–6 | standard | rule-selected + `security` for any code change + `tests` when production code changed | yes | yes |
| 7–10 | deep | every specialist for the repo's stack | yes | yes |

Stack filter: java-spring → db, security, contracts, runtime, tests, deps · react-vite → security,
contracts, webui, tests, deps.

Thresholds live in `config/review.json` → `autoLevel`. An explicit `--level` overrides the auto choice
but never removes a specialist the rules turned on.

A change touching only paths in `skipWhenOnly` (docs, specs, lockfiles) is skipped with `ready`.

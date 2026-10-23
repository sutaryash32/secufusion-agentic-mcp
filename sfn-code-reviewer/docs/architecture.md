# Architecture

## Flow

```
                     ┌──────────────────────────────── deterministic (no model) ─────────────────────┐
 git diff ──► collect-scope.mjs ──► scope.json                                                       │
              risk score, level,    (files, diffCmd, specialists, verify?, estate, missing repos)     │
              specialists           │                                                                │
                                    ▼                                                                │
 ┌──── engine: anthropic (model orchestrates) | openai (code orchestrates) ────┐                                     │
 │ orchestrator (Opus)                                          │                                     │
 │   ├─ review-db ───────┐                                      │                                     │
 │   ├─ review-security ─┼─ in parallel (Sonnet), read-only     │                                     │
 │   ├─ review-contracts ┘                                      │                                     │
 │   ├─ general pass (runtime rules, plain bugs)                │                                     │
 │   ├─ review-verify (Opus) — tries to disprove each finding   │                                     │
 │   └─ merge → verdict → JSON                                  │                                     │
 └──────────────────────────────────────────────────────────────┘                                     │
                                    ▼                                                                │
              finalize.mjs: extract → validate (schema) → stable ids → suppressions → sort           │
                                    ▼                                                                │
     render-report.mjs   to-sarif.mjs   post-ado-pr.mjs   gate.mjs (exit code)                        │
                     └───────────────────────────────────────────────────────────────────────────────┘
```

## Design decisions

| Decision | Why |
|---|---|
| **Scope and risk are computed by a script, not the model** | Same change → same depth, locally and in CI. Reproducible and cheap. |
| **Specialists, not one big prompt** | Each one reads only its rules and goes deep on one failure class; they run in parallel. |
| **Adversarial verify pass** | False blockers erode trust in a CI gate faster than anything else. Only `confirmed` findings can fail a build by default. |
| **Model writes JSON; scripts do everything else** | Posting, gating, ids, suppressions are predictable and testable. The model never sees the ADO token. |
| **Fail closed** | Malformed output → `review failed`, never `pass`. `onReviewError: warn` exists for rollout. |
| **Stable finding ids** (`repo|file|anchor|ruleId`) | Re-runs update PR threads instead of duplicating them; suppressions survive line shifts. |
| **Prompts and rules are provider-neutral** | The Claude plugin is generated from them; the OpenAI engine (phase 2) reads the same files. |
| **Read-only in CI** | `config/settings.ci.json` allows Read/Grep/Glob and read-only git; denies edits, network and env dumps. |
| **Estate cloned from `repos.yml` at run time** | Adding a service never touches the pipeline template. |

## Levels

| Level | When (auto) | Specialists | Verify | General pass |
|---|---|---|---|---|
| quick | risk 0–2 | only rule-selected | no | yes |
| standard | risk 3–6 | rule-selected + security on code | yes | yes |
| deep | risk 7–10 | every specialist for the stack | yes | yes |

Stack filter: java-spring → db, security, contracts, runtime, tests, deps · react-vite → security,
contracts, webui, tests, deps. `tests` joins at standard+ whenever production code changed.

## Phases

| Phase | Scope |
|---|---|
| 1 ✅ | Anthropic engine; db, security, contracts specialists; verify; report; SARIF; ADO PR comments; gate; evals |
| 2 ✅ | OpenAI / Azure OpenAI engine (`engines/openai`, orchestrated in code); `prompts/general.md`; engine comparison in evals |
| 3 ✅ | runtime, webui, tests, deps specialists (stack-aware); deterministic dependency diff; cross-model verify; re-review delta; local `/sfn:fix` |
| 4 ✅ | read-only live DB schema snapshot; OSV vulnerability lookup for changed deps; Azure Boards bugs (preview/confirm, idempotent); review/post an ADO PR by number; fix-history regression hints (HIS-001/002) |
| 5 ✅ | release readiness (`release-check.mjs`, `/sfn:release`, CI template); pre-push hook; team metrics dashboard (local history or CI artifacts); suggested reviewers; blast-radius diagram |

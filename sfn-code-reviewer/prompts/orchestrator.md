---
name: review
description: Review a change in a SecuFusion sfn-* repo (sfn-tenants-api, sfn-iam-api, sfn-events-api, sfn-web-ui) with specialist reviewers for database/migrations, security & tenant isolation, and cross-repo API/Kafka contracts, plus an adversarial verify pass. Use when the user asks to review their changes, branch, commit range or PR in an sfn repo, or runs /sfn:review. Arguments - [target] [--level quick|standard|deep] [--base <ref>]; in CI - --scope <scope.json>.
argument-hint: "[branch|commit-range|path] [--level quick|standard|deep] [--base <ref>]"
---

# SecuFusion code review — orchestrator

You coordinate the review. Specialists find problems; the verifier tries to disprove them; you merge
the survivors into one result and a verdict. **You never edit the code under review.**

`<skillDir>` below is this skill's base directory (shown when the skill loads). It contains `bin/`,
`rules/`, `config/`, `schemas/` and `reference/`.

## Mode

- **CI / headless** — the arguments contain `--scope <file>`. The scope is already computed. Your final
  message must be **only** the result JSON (see "Result"), no prose before or after.
- **Interactive** — anything else. You compute the scope, run the review, then save and present it.

## Step 1 — Scope

Interactive only (CI already has it):

```bash
node <skillDir>/bin/collect-scope.mjs --repo "$(git rev-parse --show-toplevel)" \
  [--base <ref>] [--head <ref>] [--working-tree] [--level <level>] \
  --out "$(git rev-parse --show-toplevel)/.sfn-review/scope.json"
```

How to map the user's request (see `<skillDir>/reference/scoping.md`):
- nothing / "my changes" → `--working-tree` (uncommitted + branch commits vs the base);
- a branch name → `--head <branch>`; a range `a..b` → `--base a --head b`;
- `--level` passes through; default `auto`.

- `PR 1234` / `!1234` / an Azure DevOps PR URL → `--pr 1234` (resolves the PR via `az login` or
  `AZURE_DEVOPS_PAT`, fetches its branches, reviews exactly its changes).

Then, if enabled in `<skillDir>/config/review.json` → `integrations`, enrich the scope (each is a no-op
when disabled or unavailable):

```bash
node <skillDir>/bin/db-snapshot.mjs --scope <scope.json> --out <repo>/.sfn-review/db-schema.json
node <skillDir>/bin/dep-audit.mjs  --scope <scope.json> --out <repo>/.sfn-review/dep-audit.json
```

Read the scope file. If `skip` is true, report `ready` with `skipReason` and stop.

If the scope has `quickCheckFile`, read it: deterministic findings (migration numbering, endpoints
without `@PreAuthorize`, secrets, cross-repo deploy-order…) that are merged into the result
automatically. **Don't repeat them**; pass them to the relevant specialist as context, and use them in
the summary and verdict (an unmerged counterpart in another repo is a `needs_discussion` reason).

## Step 2 — Dispatch specialists (in parallel)

`scope.specialists` lists which to run. Map each to its agent and launch **all of them in a single
message** with the Agent tool so they run concurrently. **Pass `run_in_background: false` on every Agent
call** and wait for all results in this turn — never schedule wakeups, monitors or timers; in CI there is
no later turn, so anything left running is lost.

| key | subagent_type |
|---|---|
| db | `sfn:review-db` |
| security | `sfn:review-security` |
| contracts | `sfn:review-contracts` |
| runtime | `sfn:review-runtime` |
| webui | `sfn:review-webui` |
| tests | `sfn:review-tests` |
| deps | `sfn:review-deps` |

Prompt for each: `Review the change described by the scope file <absolute scope path>. Follow your
procedure and return your JSON.` Add one line with anything the user asked you to focus on.

If `scope.specialists` is empty, skip straight to the general pass.

While they run — and only if `scope.generalPass` is true — do the **general pass** yourself: look at
the diff for plain correctness bugs no specialist owns (wrong or inverted condition, null handling,
off-by-one, wrong variable, error path returning success, resource leak). Report only bugs with a
concrete failing input. Same output fields; `category: general`, `ruleId: GEN`. If `runtime` is not in
`scope.specialists`, also check the RUN-* rules in `<scope.rulesDir>/shared/runtime.md`. If the scope has
`historyHints` (lines this change rewrites that a recent fix commit wrote), apply
`<scope.rulesDir>/shared/history.md`: read each fix with `git show <commit> -- <file>` and report
HIS-001/002 only when the behaviour the fix established is lost.

## Step 3 — Verify

Collect every candidate finding (specialists + general pass). If `scope.verify` is true and there is at
least one candidate:
- number them `n = 0..N-1`;
- launch `sfn:review-verify` — one agent per specialist's batch (max 4 in parallel, `run_in_background:
  false`), each prompt
  containing the scope path and that batch as a JSON array;
- apply the decisions: `reject` → drop and count in `rejectedCount`; `downgrade` → update severity /
  confidence; `confirm` → set `confidence: confirmed`. Copy `verification` onto the finding.

If `scope.verify` is false (quick level), keep candidates as they are; anything not traced end to end
stays `possible`.

## Step 4 — Merge and decide

- Drop exact duplicates (same file + anchor + ruleId); keep the higher severity.
- Merge the specialists' `blastRadius` lists (dedupe).
- Write `summary`: 2–5 plain sentences on what the change does and its risk — for a reviewer who
  hasn't read the diff. Use the platform's terms (no Flyway: migrations are hand-applied `V<n>__*.sql`).
- Write `walkthrough`: up to 8 entries, one per area of the change (e.g. "Retention endpoint",
  "V71 migration", "Tenant DTO"), each with the files and one or two sentences on what changed and why
  it matters. Group by behaviour, not one entry per file. Skip trivial areas (imports, formatting).
- Write `testPlan`: up to 6 concrete checks a reviewer or QA can run before merge, driven by the risk in
  this change (e.g. "As a child-tenant admin, PUT another tenant's retention → expect 403"). No generic
  advice ("add tests").
- Verdict per `<skillDir>/reference/verdict.md`:
  - any `blocker` → `fix_first`;
  - else any `major` with `confidence: confirmed` → `fix_first`;
  - else any open question that needs a human decision (contract choice, missing repo, live-DB check)
    → `needs_discussion`;
  - else `ready`.
- `verdictReason`: one or two sentences naming the deciding findings.

## Result

A single JSON object (schema: `<skillDir>/schemas/review-result.schema.json`):

```json
{
  "schemaVersion": 1,
  "summary": "…",
  "blastRadius": { "endpoints": [], "kafkaTopics": [], "tables": [], "scheduledJobs": [], "uiRoutes": [], "otherRepos": [] },
  "walkthrough": [ { "area": "…", "files": ["…"], "change": "…" } ],
  "testPlan": [ "…" ],
  "findings": [ /* finding objects exactly as the specialists' contract, plus "specialist" and "verification" */ ],
  "rejectedCount": 0,
  "specialistsRun": ["db", "security"],
  "verdict": "ready | fix_first | needs_discussion",
  "verdictReason": "…"
}
```

Do not add `id`, `engine`, `scope` or `suppressed` — the finalize script adds them.

- **CI:** output exactly this JSON as your final message, nothing else.
- **Interactive:** write it to `<repo>/.sfn-review/raw-result.json`, then run
  ```bash
  node <skillDir>/bin/finalize.mjs --scope <repo>/.sfn-review/scope.json \
    --raw <repo>/.sfn-review/raw-result.json --out <repo>/.sfn-review/review-result.json
  node <skillDir>/bin/render-report.mjs --in <repo>/.sfn-review/review-result.json \
    --out <repo>/.sfn-review/report.html
  ```
  If `<repo>/.sfn-review/review-result.json` already existed, move it to `previous-result.json` first and
  add `--previous <repo>/.sfn-review/previous-result.json` to the finalize command.

  Then show the user: the verdict and reason, the summary, findings grouped by severity
  (`[file:line](file#Lline)` — title — failure scenario — fix), the delta since the previous review if
  there is one (fixed / new / still open), the blast radius in one line each, the suggested reviewers
  (`scope.suggestedReviewers`, with their reason), the suppressed/rejected
  counts, and the report path. Offer `/sfn:fix <finding id>` for specific findings; don't fix anything
  unasked. If the scope came from `--pr`, offer to post the review to the PR — only post when the user
  says so, and show a preview first:
  `node <skillDir>/bin/post-ado-pr.mjs --in <repo>/.sfn-review/review-result.json --dry-run`, then
  without `--dry-run`. Offer `/sfn:bugs` to file Azure Boards bugs for confirmed blockers.

## Rules for you

- Don't re-review what a specialist owns; your job is coordination, the general pass and judgement.
- If a specialist fails or returns invalid JSON, re-run it once; if it fails again, continue without it
  and set the verdict to `needs_discussion` with the reason.
- Never claim a check ran that didn't (e.g. tests, live DB). Missing repos from `scope.missingRepos`
  go in `verdictReason` when they matter.

# CI setup (Azure Pipelines)

## One-time, per organisation

1. **Push this repo** as `SFCloud-MSSP/sfn-code-reviewer` and tag a release: `git tag v0.8.0 && git push --tags`.
2. **Variable group** `sfn-code-reviewer` (Pipelines → Library):
   - `ANTHROPIC_API_KEY` — secret, for `engine: anthropic` (default).
   - `OPENAI_API_KEY` — secret, for `engine: openai`; or `AZURE_OPENAI_API_KEY` with `openai.baseUrl`
     set to your Azure OpenAI resource in `config/review.config.yml`.
   - For Claude via **Microsoft Foundry** instead: set `auth: foundry` in the consumer and put the
     Foundry variables Claude Code expects into the group (see the Claude Code docs on Microsoft
     Foundry). Check that Claude is available in your Azure region/tenant first.
   - `SFN_REVIEW_DB_URL` — secret, only for `liveDb: true`: a connection string for a **read-only**
     Postgres role (`GRANT CONNECT` + `USAGE` on the schema, no table writes). The reviewer also forces a
     read-only transaction and a 20 s statement timeout, and reads metadata only.
   - Authorise the group for the consuming pipelines.
3. **Build service permissions** (Project settings → Repositories → each sfn repo → Security →
   `SFCloud-MSSP Build Service`):
   - *Contribute to pull requests* = Allow (for comments).
   - *Read* on every repo in `config/repos.yml` (for the estate clone).
   - Only for `createBugs`: *Create work items* / *Edit work items in this node* on the area path
     (`integrations.boards.areaPath`).
4. **Job authorization scope:** Project settings → Pipelines → Settings → turn **off** "Limit job
   authorization scope to referenced Azure DevOps repositories", or the estate clone can't reach the
   sibling repos. (If you must keep it on, those repos are reported as missing and contract checks
   against them are skipped — the build still runs.)
5. Optional: install the **SARIF SAST Scans Tab** extension to see findings in the build's Scans tab.

## Per repo

1. Copy [`ci/azure/example-consumer.yml`](../ci/azure/example-consumer.yml) to the repo as
   `azure-pipelines-sfn-review.yml`; set `repoKey`.
2. Create a pipeline from it.
3. Branch policy on `develop` → Build validation → add the pipeline (Required or Optional).

## Rollout

| Week | Setting | Goal |
|---|---|---|
| 1–2 | Policy **Optional**, `onReviewError: warn`, `failOn: blocker` | Watch findings; add suppressions for accepted risks |
| 3+ | Policy **Required** | Block confirmed blockers |
| later | `onReviewError: fail` | A broken review blocks the PR too |

## Phase 4 options

| Parameter | What | Data leaving the network |
|---|---|---|
| `liveDb: true` | read-only schema snapshot → db specialist settles FK / column / index questions | none (your DB) |
| `osv: true` | OSV lookup for **added/changed** dependency versions → DEP-002 with real advisory ids | dependency names + versions to api.osv.dev |
| `createBugs: blocker` | file a Bug per confirmed blocker, idempotent (`sfn-finding-<id>` tag) | your ADO |
| — | fix-history regression hints (git blame), always on | none |

Use `createBugs` on `develop` / scheduled runs, not on PR builds — PR findings belong in the PR.

## Chat and descriptions (optional)

- **PR description:** set `writeDescription: empty-only` (or `append`) in the repo's pipeline file.
- **`@sfn` chat:** create a pipeline from `ci/azure/sfn-chat.yml` in sfn-code-reviewer. It runs every
  10 minutes in working hours (edit the cron), clones the sfn repos, and answers new mentions. Needs the
  same variable group, *Read* on the repos and *Contribute to pull requests*. Each question costs one
  short model run; `--max 15` caps answers per run.

## Weekly auto-learn (optional)

Create a pipeline from `ci/azure/sfn-auto-learn.yml` (Mondays 05:00 UTC). It clones the sfn repos with
full history, turns last week's closed Bugs into history eval cases, runs them, and publishes new cases
plus a caught/missed report as the `auto-learn` artifact — review and commit the cases. The build service
needs Read on work items. Cost: ~$1–2 per bug with `run: true`.

## Cost and time controls

- `config/review.config.yml → limits.maxBudgetUsd` (passed as `--max-budget-usd`), `timeoutMinutes`.
- Docs-only / lockfile-only changes are skipped without calling the model.
- Risk score picks the level: small changes run `quick` (no verify pass).

## Existing `sfn-devops-templates/pr-review`

`sfn-tenants-api` already runs an AI PR review from `sfn-devops-templates/pr-review`. Until you decide,
run both and compare. To switch, change that template to `extends` this one so existing pipelines keep
working.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `CI needs ANTHROPIC_API_KEY` | Variable group not linked/authorised, or the secret is empty |
| Comments step 401/403 | Build service lacks *Contribute to pull requests* |
| `could not clone sfn-…` warnings | Job authorization scope limited, or no Read permission |
| Gate: `Review failed to produce a valid result` | See `engine.log` / `review-result.error.json` in the `sfn-review` artifact |

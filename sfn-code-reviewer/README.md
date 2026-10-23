# sfn-code-reviewer

A multi-agent code reviewer for the SecuFusion repos (`sfn-tenants-api`, `sfn-iam-api`,
`sfn-events-api`, `sfn-web-ui`). It knows the platform's real failure modes: migrations nobody runs
automatically, a shared `tenant` table, tenant isolation by convention, Kafka contracts across repos.
It catches those before they ship.

The same review runs **on your machine** (with your Claude Code login, no API key) and **in Azure
Pipelines** (API key, PR comments, build gate).

```
scope (git, deterministic) ─► specialists in parallel ─► adversarial verify ─► [cross-model check] ─► verdict + report
                               db · security · contracts    tries to disprove      other provider          ready / fix_first /
                               runtime · webui · tests      every finding          re-checks (optional)    needs_discussion
                               deps (+ general pass)                                                       + delta since last run
```

## Quick start

```bash
scripts/setup.sh                 # checks Node + Claude CLI, installs deps, installs the `sfn` plugin, creates .env
scripts/add-repo.sh ../sfn-iam-api   # writes the CI pipeline file into a repo (+ repos.yml stub if new)
```

## Use it locally

**In Claude Code** (no key — uses your login):

```bash
# once: register the plugin
claude plugin marketplace add ~/IdeaProjects/secufusion/sfn-code-reviewer
claude plugin install sfn@sfn-code-reviewer
```

Then, inside any sfn repo:

| You type | Reviews |
|---|---|
| `/sfn:review` | your uncommitted changes + branch commits vs `origin/develop` |
| `/sfn:review feature/BUG-1140` | that branch |
| `/sfn:review HEAD~3..HEAD` | a commit range |
| `/sfn:review --level deep` | force the deepest review |
| `/sfn:report` | re-open the last review / regenerate the HTML report |
| `/sfn:fix <id>` / `/sfn:fix blockers` | fix findings test-first (failing test → smallest fix → tests → re-review). Local only, never commits |
| `/sfn:review PR 1491` | review an Azure DevOps PR by number (uses `az login`); offers to post the result to the PR |
| `/sfn:bugs` | file Azure Boards bugs for confirmed blockers — preview, ask, then create; never duplicates |
| `/sfn:release [repos] [--from tag]` | release readiness: PRs and work items in the release, migrations in apply order, new env vars / flags / config, major upgrades, removed endpoints or topics |

Every report also shows a **walkthrough** of the change by area, a **suggested test plan** (concrete
pre-merge checks: who calls what, what to expect), **suggested reviewers** (who wrote the lines the
change rewrites, who changed those files recently — names only) and a **blast-radius diagram**
(touched endpoints, topics, tables, jobs → the other repos they reach). The walkthrough and test plan
also appear in the PR summary comment.

**Pre-push hook** (optional, per repo): reviews what you're about to push and blocks only on confirmed
blockers; a broken review never blocks.

```bash
scripts/install-hook.sh ../sfn-tenants-api [--level quick] [--fail-on blocker]   # --uninstall to remove
SFN_SKIP_REVIEW=1 git push                                                         # skip once
```

**Team metrics** (never attributed to people): every run is archived in `.sfn-review/history/`.

```bash
node scripts/metrics.mjs --in ../sfn-*/.sfn-review/history --out sfn-metrics.html
node scripts/metrics.mjs --ado-definition <pipelineId> --repo ../sfn-tenants-api --days 90   # from CI artifacts
```

Re-running a review shows **fixed / new / still open** since the previous run.

Results land in `<repo>/.sfn-review/` (`review-result.json`, `report.html`). Add `.sfn-review/` to
your global gitignore.

**From the terminal** (same engine, same output as CI):

```bash
npm ci   # once, in this repo
scripts/run-review.sh --repo ../sfn-tenants-api --working-tree
open ../sfn-tenants-api/.sfn-review/report.html
```

Optional keys and settings go in a local `.env` (copy [.env.example](.env.example); it's git-ignored).
Without `ANTHROPIC_API_KEY` it uses your Claude Code login. With the key set, it runs exactly like CI.
Add `--engine openai` (with `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY`) to review with OpenAI models.

```bash
scripts/run-review.sh --repo ../sfn-tenants-api --pr 1491 [--post]        # an ADO PR; --post comments on it
scripts/run-review.sh --repo ../sfn-iam-api --working-tree --live-db --osv # + live schema + OSV audit
node scripts/create-ado-bugs.mjs --in ../sfn-iam-api/.sfn-review/review-result.json --repo ../sfn-iam-api  # preview
```

Every review also gets **fix-history hints**: lines your change rewrites that a recent bug-fix commit
wrote (git blame), so a reviewer checks the fix isn't being undone.

## Fast check (no model, ~1 second)

```bash
node scripts/quick-check.mjs --repo ../sfn-tenants-api [--working-tree] [--fail-on blocker]
scripts/install-hook.sh ../sfn-tenants-api --quick      # pre-push: free, instant
```

Deterministic: migration numbering/edits, entity columns with no migration (checks sibling repos — shared
DB), mutating endpoints without `@PreAuthorize`/allowlist, committed secrets, flags on by default, `lb://`,
hard deletes in events-api, web-ui axios/URL/tenant-id misuse, tests outside `src/__tests__`, and
**cross-repo deploy order**: work for the same item (`feature/1093-…`, `WI 1288`) in another repo that
isn't merged yet. Every full review runs it too and merges its findings.

## Learn from bugs it missed

When a bug slips through, turn its fix into a permanent eval case — the reviewer can never silently
miss it again:

```bash
node evals/learn-from-fix.mjs --repo ../sfn-tenants-api --bug 1288 [--pr 1072] --run
```

**Weekly, automatically:** `ci/azure/sfn-auto-learn.yml` (or `node evals/auto-learn.mjs --days 7 --run`)
turns every Bug closed last week into a case and reports which ones the reviewer would have missed.

It finds the fix (Boards links or "WI 1288" in commit messages), the PR that introduced the problem
(region history; override with `--pr`), writes `evals/cases/history-…` and a rule-drafting note in
`evals/drafts/`, and runs it. If it's missed, sharpen or add a rule (see the draft) and re-run.

## Use it in CI

See [docs/ci-setup.md](docs/ci-setup.md). In short: create the `sfn-code-reviewer` variable group with
`ANTHROPIC_API_KEY`, copy [ci/azure/example-consumer.yml](ci/azure/example-consumer.yml) into the
repo, and add it as a build-validation policy on `develop`.

In each PR the reviewer (plus, optionally, the chat pipeline and description writer):
- posts one inline thread per new finding, plus a summary thread that re-runs update in place;
- resolves its own threads when the finding disappears;
- publishes `report.html` + SARIF as build artifacts;
- fails the build only on **confirmed** findings at or above `failOn` (default: blocker);
- with `writeDescription: empty-only`, fills an **empty PR description** (summary, changes, impact,
  test plan) — never touches text the author wrote;
- with the **chat pipeline** (`ci/azure/sfn-chat.yml`), answers `@sfn` in PR comments: `@sfn why`,
  `@sfn false positive <reason>` (marks the thread won't-fix, feeds precision), `@sfn <question>`
  (read-only answer from the PR's code), `@sfn help`.

## Engines

| Engine | Status | Auth |
|---|---|---|
| `anthropic` | ✅ phase 1 | local: Claude Code login · CI: `ANTHROPIC_API_KEY`, or Claude via Microsoft Foundry (`auth: foundry`) |
| `openai` | ✅ phase 2 — [details](engines/openai/README.md) | `OPENAI_API_KEY`, or Azure OpenAI (`AZURE_OPENAI_API_KEY` + `baseUrl`) — terminal and CI only |

Pick per run (`--engine`) or per pipeline (`engine:` parameter). Rules, prompts, schemas, reports and
the gate are shared, so both engines produce the same output format.

**Consensus mode** (`--consensus N`, or `consensus.enabled` for deep reviews): runs the review N times
in parallel and keeps findings that repeat — or a confirmed blocker/major of a critical rule from any
run. One-off findings are hidden in the report, never posted. Cost × N; use it for high-risk changes.

**Cross-model verification** (`--cross-verify`, pipeline `crossVerify: true`, or `verify.mode: cross`):
after the review, the *other* provider re-checks every finding and may reject or downgrade it — never
raise it. Different models make different mistakes, so this cuts false positives. Needs both
providers' credentials; without them the run continues single-model and says so.

## Layout

| Path | What | Edit? |
|---|---|---|
| `prompts/` | orchestrator, specialists, verify — **provider-neutral source** | yes |
| `rules/` | what the reviewers check (rule IDs, severities, platform facts) | yes |
| `config/` | engine, models, levels, gate, repos, risk scoring | yes |
| `schemas/` | output contract | carefully |
| `scripts/` | deterministic glue: scope, finalize, report, SARIF, PR comments, gate | yes |
| `engines/anthropic/` | Claude Code plugin — **generated** by `npm run build` (except `skills/*/reference`, `skills/report`) | via sources |
| `engines/openai/` | OpenAI engine — hand-written, orchestrates in code | yes |
| `ci/azure/` | pipeline template | yes |
| `evals/` | known-defect cases that gate reviewer changes | yes |

After changing `prompts/`, `rules/`, `config/` or `scripts/`: `npm run build && npm test`, then
`npm run evals` before tagging a release.

## Docs

- [Architecture](docs/architecture.md) — flow, why it's built this way
- [CI setup](docs/ci-setup.md)
- [Adding a rule](docs/adding-a-rule.md)
- [Adding a repo / service](docs/adding-a-repo.md)

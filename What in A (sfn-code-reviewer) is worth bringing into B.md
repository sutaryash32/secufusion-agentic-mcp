# What in A (sfn-code-reviewer) is worth bringing into B

**A** is the sfn-code-reviewer (a coworker's project). **B** is our `secufusion-mcp`.
This document lists what was worth taking from A, what was built in B for it (release 4.15.0), why each piece matters, and exactly how to use it.

Everything below lives inside `secufusion-mcp/`. Nothing in B calls, imports or depends on A's code: the useful ideas were re-implemented in TypeScript inside B, and A's rule files were copied in as data.

---

## 1. The idea in one paragraph

B's `/sfn-review` is a **reasoning** reviewer: it reads the change, forms hypotheses and investigates. A is a **delivery** system: cheap deterministic checks first, a catalog of known rules, a second model that tries to refute findings, and then SARIF, HTML, a CI gate, metrics and evals. They are complementary. The 4.15.0 work gives B A's delivery strengths without giving up B's reasoning.

The order of a review is now:

```
quick check (no model, 1 s)  ->  rule catalog (questions to answer)  ->  reasoning review (/sfn-review)
   ->  adversarial verification  ->  finalize (ids, floors, delta, gate)  ->  SARIF / HTML / metrics
```

---

## 2. Map: what was taken from A, and what B calls it

| From A | In B | Why it was worth it |
|---|---|---|
| Quick check, pre-push check | `run_quick_check`, `sfn-ci pre-push` | Catches mechanical mistakes before a human or a model spends time |
| Rule catalog (DB-/SEC-/CON-/RUN-/DEP-/WEB-/TST-) | `get_rule_catalog`, `rules/` | 81 named questions, with the ones B lacked now added |
| Verified Kafka topic table | stamped in `AGENTS.md` and `rules/shared/contracts.md` | Two tables disagreed; the code decided |
| Adversarial verifier, cross-model verify | `verify_findings` | Removes false positives; a second provider makes it independent |
| Consensus across runs | `merge_review_runs` | Models vary run to run; keep what repeats |
| Severity floors, dated suppressions, noise cap, verdict, delta, gate | `finalize_review_findings` | The same findings always give the same result |
| SARIF export | `findings_to_sarif` | Annotations on changed lines in the pipeline and IDE |
| HTML report | `render_review_report` | One shareable file |
| Suggested reviewers | `suggest_reviewers` | Who actually knows this code |
| Eval corpus, backtest idea | `run_quick_eval`, `load_eval_cases`, `draft_eval_case_from_fix` | Measure the reviewer instead of trusting it |
| Live DB schema snapshot | `snapshot_db_schema`, `lookup_db_schema` | Facts no migration shows (FK ON DELETE, real indexes) |
| OSV dependency audit | `audit_dependencies` | Known vulnerabilities of the exact versions a change adds |
| Release readiness check | `check_release_readiness` | What operations must do for a release |
| Metrics | `get_review_metrics` | Trends: top rules, rejected rate, fixed on re-review |
| Engine abstraction (Anthropic and OpenAI) | `engine.ts`, `get_engine_status`, `SFN_ENGINE` | The review can run in CI and hooks, where no editor model exists |
| Pipeline templates | `ci/azure/*.yml`, `ci/github/sfn-review.yml` | Run it on every pull request |
| Command line | `sfn-ci` | The same checks from a terminal, a git hook or a pipeline |
| DB-002 (applied migration edited) | `check_applied_migrations` (4.14.0) | Already adopted earlier |

**Not brought over** (you did not select them): posting threads to Azure DevOps pull requests and `@sfn` chat, `/sfn:fix` (test-first fixes), `/sfn:bugs` (Azure Boards bug creation), auto-learn from closed bugs.

---

## 3. Two ways to use the tools

**Inside the editor (Claude Code).** `/sfn-review` now calls the tools itself (STEP 1D, PASS 22, STEP 5). You can also ask Claude to call any tool directly, for example: *"run the quick check on this repo against develop"*.

**Outside the editor (terminal, git hook, pipeline).** Use `sfn-ci`. It needs no editor. For anything that needs a model it reads an engine from the environment (section 6).

Every tool takes `workspace_root`: the repository root. Tools marked READ-ONLY write nothing.

---

## 4. The tools, one by one

### 4.1 `run_quick_check` — the mechanical first pass

**Significance.** Most expensive review time is wasted on things a pattern can find: an edited migration, a committed credential, a POST endpoint nobody secured. This finds them with no model, no network, in about a second, so a human reviews logic instead.

**What it checks.** An applied migration edited, renamed or deleted, or a version reused or below the head (any framework); an entity column with no migration; committed credentials; SQL built by concatenation; a mutating endpoint with no `@PreAuthorize`; scope enforcement turned off; flags that default on; a hard delete in sfn-events-api; `NOT NULL` with no default, `CREATE INDEX` without `CONCURRENTLY`, `DROP`; floating or snapshot versions; unpinned Dockerfile bases, piped installs, secret `ARG`s; pipelines that skip tests; tests that cannot fail or that sleep; logging of tokens; web-ui rules (axios outside the shared client, inlined URLs, `currentUser.tenantId`, token storage, raw HTML).

**How to use.**
```
run_quick_check(workspace_root, base?, repo_key?, fail_on?, format?)
```
- `base`: branch to compare with (default: merge-base with origin/develop, origin/main or origin/master).
- `fail_on`: severity at which the gate says FAIL (default `blocker`).
- `format: "json"` returns findings plus the gate result.

**How to read it.** `confirmed` means exact (a reused migration version): treat as fact. `possible` means a pattern lead: read the code and confirm or drop it. **A clean result proves nothing about logic.** Generated folders (`dist`, `node_modules`, `build`, `target`) and `evals/cases` are ignored.

### 4.2 `get_rule_catalog` — the 81 questions

**Significance.** Reviews drift when the rules live in people's heads. The catalog names each rule, its severity and the question it asks, so findings can cite an ID and be traced.

**How to use.**
```
get_rule_catalog(workspace_root?, area?, ids?, severity?, repo?)
```
- `area`: security, database, contracts, runtime, tests, dependencies, web-ui, history.
- `repo`: also returns that repository's notes (layering, delete style, scheduler facts). Bundled notes exist for sfn-events-api, sfn-iam-api, sfn-tenants-api and sfn-web-ui.
- Each rule is shown with how it maps to the report: `blocker` becomes BLOCKER **only when the evidence is FACT**, otherwise WARNING; `major` is WARNING; `minor` and `nit` are NICE TO HAVE. Rules tagged `quick-check` are also run by tool 4.1.

**Adding your own.** Put a markdown file in `.secufusion/rules/` in the repo with rows like `| ZZ-001 | major | the question |`. A row with an existing ID overrides the bundled rule (and is reported). Per-repo notes go in `.secufusion/rules/repos/<repo>.md`.

**A rule is a question, not a verdict.** Cite `file:line`; the evidence rule still applies.

New to B in 4.15.0: DB-008 to DB-011, SEC-004/006/010/016/017/018, CON-006/011, RUN-004/005, DEP-001 to DEP-009, WEB-001 to WEB-011, TST-004 to TST-008.

### 4.3 `verify_findings` — try to prove the finding wrong

**Significance.** The biggest source of reviewer noise is a confident, wrong finding. A verifier whose only job is to refute each finding against the real code removes most of them.

**How to use.**
```
verify_findings(workspace_root, findings[], mode?, judgment?)
```
- `findings`: up to 40, each with `ruleId, severity, confidence, file, line, anchor, title, problem, failureScenario, suggestion`.
- `mode: "same"` (default): the reviewing model checks itself. `mode: "cross"`: a **different** model checks it; it may lower a severity and never raise one, and its reasons are stored separately.
- Each finding gets `confirm`, `downgrade` or `reject`. A finding with no decision is kept but marked unverified and `possible`: silence is not confirmation.

**Where the answer comes from.** In an editor, the client's model. With `SFN_VERIFY_ENGINE` set, that engine answers (use the other provider for a real second opinion). Otherwise the tool returns a "judgment required" request that the calling model answers and sends back as `judgment`. Nothing is stored.

### 4.4 `merge_review_runs` — consensus

**Significance.** The same review run twice can report different majors. Keep what repeats; do not lose a verified catch.

```
merge_review_runs(runs[], min_agree?, missing_repos?, critical_rules?)
```
A finding is kept if at least `min_agree` runs reported it (same file and rule, same anchor or within 15 lines), or if any run reported a **confirmed** major-or-worse for a critical rule (defaults to the severity-floor rules). The rest come back as `seenOnce` and are hidden. Use it with `level: deep` when you can afford two or three runs.

### 4.5 `finalize_review_findings` — make the result deterministic

**Significance.** Without this, the same findings could get different ids, severities and verdicts each time, so "what was fixed since last time?" is unanswerable. It is the center of the delivery layer.

```
finalize_review_findings(workspace_root, findings[], repo_key?, level?, floors?, suppressions?,
                         previous?, gate?, max_minor?, max_nit?, missing_repos?, record?)
```
It does, in order:
1. **Stable ids** from repo + file + anchor + rule (never line numbers or wording). Use a real `anchor` such as `UserService#transfer` or `tenant.company_name`.
2. **Severity floors**: a *confirmed* finding of a critical rule (tenant isolation, authorization, applied migrations, destructive deletes, contract breaks) is never below major. A possible finding is not lifted: a floor never invents evidence.
3. **Suppressions**: read from `.secufusion/suppressions.json` (or passed in). Each must have an `expires` date. One past its date stops applying and is reported; one without a date is ignored.
4. **Sort and noise cap**: every blocker and major stays; extra minors and nits are trimmed.
5. **Verdict**: `fix_first`, `needs_discussion` or `ready`.
6. **Delta** with `previous: "auto"`: fixed, new and still open since the last stored review of this repo.
7. **Gate** with `gate: { fail_on: "blocker" }`: exit code and blocking findings.
8. `record: true` stores the run in `.secufusion/review-runs/` for the next delta and for metrics.

Suppression file example:
```json
{ "suppressions": [ { "ruleId": "SEC-009", "path": "src/legacy/**", "reason": "removal tracked in WI 1400", "owner": "asha", "expires": "2026-12-31" } ] }
```

### 4.6 `findings_to_sarif` — annotations where people look

**Significance.** SARIF is the standard format GitHub code scanning, Azure DevOps (SARIF viewer) and IDEs use to show findings on the changed line. The stable finding id is the fingerprint, so a re-review does not create duplicate alerts.

```
findings_to_sarif(workspace_root, result, out_path?)
```
`result` is the output of tool 4.5. With `out_path` (inside the workspace, for example `.secufusion/review.sarif`) it writes the file; without, it returns the JSON. blocker and major map to error, minor to warning, nit to note. A path outside the workspace is refused.

### 4.7 `render_review_report` — one shareable file

**Significance.** A single HTML file you can attach to a ticket or keep as a pipeline artifact. No external assets; light and dark; works on a phone. Every value is HTML-escaped.

```
render_review_report(workspace_root, out_path, result, reviewers_base?, record?)
```
Includes verdict and reason, severity counts, walkthrough, suggested test plan, findings as cards (problem, fails-when, fix, evidence, verification), what changed since the last review, blast radius, suggested reviewers (if `reviewers_base` is given) and run details. To get the walkthrough, test plan and blast radius, include `walkthrough: [{area, change, files}]`, `testPlan: [..]`, `blastRadius: {tables: [..], endpoints: [..]}` in `result`.

### 4.8 `suggest_reviewers` — who knows this code

**Significance.** The right reviewer is usually whoever wrote the lines being rewritten.

```
suggest_reviewers(workspace_root, base?, max?)
```
Authors of the lines the change rewrites (git blame on the base, weight 2 per line) plus authors of recent commits to the changed files (weight 1 each). The change's own authors and bots are excluded. Names and reasons only; **no email addresses**.

### 4.9 `run_quick_eval`, `load_eval_cases`, `draft_eval_case_from_fix` — measure the reviewer

**Significance.** A reviewer that misses a known bug, or flags a known-clean change, has regressed. Run this after changing rules or the quick check.

- `run_quick_eval(corpus_dir?, format?)` builds each case in the corpus (12 cases under `evals/cases/`) as a real git repository, runs the quick check and scores recall, precision and per-rule hits. Cases that need reasoning (cross-repo contract breaks, tenant leaks, locks) are listed as `needs_model`, not silently passed.
- `load_eval_cases(workspace_root?)` returns the cases as specs for the existing `score_review_run` tool. Use it for the `needs_model` cases: run a real `/sfn-review` on the case, then score its findings.
- `draft_eval_case_from_fix(workspace_root, fix_sha, name?)`: when a bug slips through, give it the commit that fixed it. It finds the commit that introduced the bug and writes `.secufusion/evals/cases/history-<name>/case.json` expecting a major-or-worse finding in the files the fix changed. Tighten it, commit it, and the bug can never slip through again unnoticed.

A case folder has `case.json` (repoKey, description, `quick_check`, and `expect` with `mustFind`, `mustNotFind`, `verdictIn`), `base/` and `head/`.

### 4.10 `snapshot_db_schema` and `lookup_db_schema` — facts only the live database knows

**Significance.** Some answers are in no migration: the foreign keys of join tables nothing creates, `ON DELETE` behaviour (RESTRICT versus CASCADE), the indexes that really exist. Without them, rules DB-004, 005, 006 and 009 end in "ask the author".

```
snapshot_db_schema(workspace_root, url_env, schemas?)   # run once, by someone with DB access
lookup_db_schema(workspace_root, tables[])              # used during review
```
- `url_env` is the **name** of an environment variable holding a read-only connection string, for example `SFN_REVIEW_DB_URL`. The string itself is never accepted as an argument, never stored, and scrubbed from errors. Use a read-only role.
- It reads **metadata only** (tables, columns, FKs with ON DELETE, indexes), never rows, inside a read-only transaction with a 20-second statement timeout. Needs `psql` on the PATH.
- The snapshot is saved to `.secufusion/db-schema.json`. `lookup_db_schema` lists, per table: columns, foreign keys, **which tables reference it** (what a delete runs into) and foreign-key columns with no index.

### 4.11 `audit_dependencies` — what changed, and is it vulnerable

```
audit_dependencies(workspace_root, base?, allow_network?, format?)
```
Always lists dependencies added, removed and re-versioned in `pom.xml` and `package.json` (resolving Maven properties and npm lockfile versions) and flags major upgrades and downgrades. With `allow_network: true` it also asks OSV (osv.dev, no key) about the **exact** versions the change adds or moves.

**Privacy.** The lookup sends package names and versions to osv.dev and nothing else (no code, no repo name). It is off unless you allow it.
**Honesty.** A version that cannot be pinned (managed by a parent, a range) is reported as **not checked, never as clean**. An OSV failure is reported as a failure, never as safe.

### 4.12 `check_release_readiness` — what operations must do

```
check_release_readiness(workspace_root, from?, to?, format?)
```
For a range (default: latest tag to origin/develop): the pull requests and work items included; the migrations to apply, in order; migrations edited, deleted, duplicated or numbered below the head; new configuration and **environment variables with no default** (startup fails without them); new feature flags and whether they default on; dependency changes and major upgrades; endpoints and Kafka topics added or removed. It ends with a checklist for operations. Deterministic (git only); it does not read logic, so also run `/sfn-review` on the range.

### 4.13 `get_review_metrics` — trends, never people

```
get_review_metrics(workspace_root, html_path?, format?)
```
Reads the runs stored by tools 4.5/4.7 (`record: true`): reviews, findings per review, verdict mix, findings per week by severity, top rules and their repos, the share of candidates verification rejected, findings fixed on re-review. Optionally writes an HTML dashboard. Runs carry repos, rules and verdicts, **not authors**.

### 4.14 `get_engine_status` — what is configured

Shows which headless engines are set (primary and verification), their models and whether a key is present. It never prints a key. If both engines are the same provider it warns that the verification is not independent.

---

## 5. `sfn-ci`: the command line

Installed with the package (`bin: sfn-ci`).

| Command | Use |
|---|---|
| `sfn-ci quick-check [--base ref] [--fail-on blocker] [--sarif file] [--json]` | Tool 4.1 from a terminal or pipeline. Exit 1 if the gate fails |
| `sfn-ci pre-push` | For the git hook: blocks only a **confirmed** blocker; fails open on any internal problem |
| `sfn-ci install-hook` / `uninstall-hook` | Writes `.git/hooks/pre-push`. Never overwrites a hook that is not ours (`--force` to replace) |
| `sfn-ci review [--level] [--out-dir]` | Headless review with the configured engine. Writes `review.json`, `review.sarif`, `review.html` |
| `sfn-ci gate --result review.json --fail-on major` | Apply the gate to a stored result |
| `sfn-ci release-check [--from ref] [--to ref]` | Tool 4.12 |
| `sfn-ci dep-audit [--network]` | Tool 4.11 |
| `sfn-ci metrics [--html file]` | Tool 4.13 |
| `sfn-ci reviewers` | Tool 4.8 |

**Exit codes:** 0 pass; 1 the gate failed on findings; **2 the review could not run** (no engine, no key, unusable answer). A pipeline must not read 2 as green.

**The pre-push hook.** Run `sfn-ci install-hook` once per repo. On each push it runs the quick check; a confirmed blocker stops the push and prints why. Bypass once with `SFN_SKIP_PREPUSH=1 git push`. If `sfn-ci` is not installed the push goes through.

**Pipelines.** `ci/azure/sfn-review.yml` (steps template), `ci/azure/release-check.yml`, `ci/github/sfn-review.yml`. Each installs the pinned package, runs the quick gate (no secrets needed), and optionally the headless review (`review: true`, off by default), then publishes SARIF, HTML and JSON. While rolling out, use `onReviewError: warn`.

---

## 6. Engines: running the model outside an editor

Inside Claude Code the client's model answers (sampling). In a hook or pipeline there is none, so set an engine:

| Variable | Meaning |
|---|---|
| `SFN_ENGINE` | `anthropic` or `openai`: the primary engine |
| `SFN_MODEL` | optional model id (defaults: `claude-opus-5-5`, `gpt-5`) |
| `SFN_VERIFY_ENGINE`, `SFN_VERIFY_MODEL` | the engine for verification: **use the other provider** for an independent check |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (or the aliases `SFN_ANTHROPIC_KEY`, `SFN_OPENAI_KEY`) | keys, read from the environment only. The Azure template maps the pipeline secret to the alias |
| `SFN_ANTHROPIC_BASE_URL`, `SFN_OPENAI_BASE_URL` | proxy or test server |

**Nothing is sent to a provider unless you set these on purpose.** When set, the diff and rules are sent to that provider.

---

## 7. How `/sfn-review` uses all of this

- **STEP 1D (mechanical first):** `run_quick_check`; `get_rule_catalog` for the selected areas and the repo; `lookup_db_schema` for delete/cascade/FK/shared-table changes; `audit_dependencies` when manifests changed.
- **PASS 22 (noise filter):** evidence gate (`validate_finding_evidence`), then `verify_findings`.
- **STEP 5 (outputs):** `finalize_review_findings` with `previous: "auto"` and `record: true`; the report's ASSUMPTIONS gains "Since the last review: N fixed, M new, K still open"; then `render_review_report`, `findings_to_sarif`, `suggest_reviewers` on request.

---

## 8. A finding from the comparison: the Kafka tables

A's and B's topic tables disagreed. Checked against every `@KafkaListener` and `send` in the four services, **B's was right and A's is stale**:

| Topic | Produced by | Consumed by |
|---|---|---|
| `device-registration` | sfn-iam-api | sfn-events-api |
| `device-deleted` | sfn-events-api | sfn-iam-api |
| `extension-approval-decided` | sfn-events-api | sfn-tenants-api **and** sfn-policy-api |
| `extension-policy-changed` | sfn-tenants-api **and** sfn-policy-api | sfn-events-api |
| `policy-events` | sfn-tenants-api and sfn-policy-api | **none live** (the `@KafkaListener` in `PolicyKafkaConsumer` is commented out) |
| `quickstart-events` | sfn-events-api (the browser extension is believed to produce too; not visible in backend code) | sfn-events-api |

A omits `sfn-policy-api`, says sfn-tenants-api consumes `policy-events`, and gives `extension-approval-decided` one consumer. Worth telling the owner of A. B's `AGENTS.md` (both copies) and `rules/shared/contracts.md` are stamped "verified 2026-10-23".

---

## 9. Caveats

- The Azure and GitHub YAML have **not been run on a real pipeline**; the CLI and hook were tested locally. The templates install `secufusion-mcp@4.15.0` from npm, so that version must be published first.
- The headless review is less than the interactive one: no product conversation, no Context Sufficiency questions, no tool investigation. Its result says "Headless review". Use it as a gate, and `/sfn-review` in the editor as the real review.
- Quick-check `possible` leads are leads. The quick check is patterns, so it can be wrong in both directions.
- The eval corpus is 12 cases: per-pass numbers are anecdotes until it grows (`draft_eval_case_from_fix` is how it grows).
- The eval fixture for "committed secret" stores `{{S}}` and each build replaces it with a fresh random value, and the tests build their fake credentials at runtime, so no secret-shaped text is stored in the repository (the repo's secret-scan hook stays unchanged).

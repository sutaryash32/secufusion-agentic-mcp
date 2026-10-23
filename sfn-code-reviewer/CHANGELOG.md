# Changelog

## 0.8.0 — 2026-10-22

- **Fast deterministic check** (`scripts/quick-check.mjs`, no model, ~0.5 s): migrations (edited,
  duplicate, below head, malformed), entity columns without a migration (searches sibling repos' migrations
  — shared DB), mutating endpoints without `@PreAuthorize` (scans multi-line annotations; allowlist at head),
  secrets, flags on by default, `lb://`, events-api hard deletes (grouped per file, migrations excluded),
  web-ui axios / inline URLs / `currentUser.tenantId` / tests outside `src/__tests__`. Merged into every
  review (deduped against model findings); `install-hook.sh --quick`. Calibrated on the 16 backtest PRs:
  caught the !1111 V57-below-V58 migration; false positives fixed.
- **Cross-repo deploy-order** (CON-011, `lib/deployorder.mjs`): work-item / feature ids from the branch
  and commits → same id on an unmerged branch in another repo. Finds PR !1381's unmerged events-api
  counterpart in 0.4 s; also an attention item in the release check.
- **Weekly auto-learn** (`evals/auto-learn.mjs`, `ci/azure/sfn-auto-learn.yml`): Boards bugs closed in the
  last N days → history cases (trying every repo that mentions the bug) → caught/missed report. First real
  run: 10 bugs in 14 days → 4 cases.
- WI 1288 case marked a **known gap** (missing change in the master realm, outside the diff); scorer reports
  known gaps as GAP without failing; SEC-017 names the concrete Keycloak admin-client calls; SEC-017/018
  severity floors; eval runner keeps outputs of failing runs.
- Tests: 74.

## 0.7.0 — 2026-10-22

- **Learn from missed bugs** (`evals/learn-from-fix.mjs`): from a fix commit or Boards bug, finds the PR
  that introduced the problem (git log -L region history, so deleted lines count; `--pr` override),
  writes a permanent *history* eval case (reviewed from worktrees at that date) plus a rule-drafting
  note, and runs it. First case: WI 1288 / PR !1072 → new rules **SEC-017** (typed full-document
  write-back of IdP config drops unmodelled fields) and **SEC-018** (IdP flow / required profile changes
  can block sign-in before the app's access check).
- **`@sfn` chat** (`scripts/pr-chat.mjs`, `ci/azure/sfn-chat.yml`): help, why, false positive (sets
  won't-fix, suggests a suppression — no model), and read-only answers from a worktree at the PR's
  source commit; thread text handled as untrusted; each mention answered once.
- **PR description writer** (`scripts/pr-description.mjs`, CI `writeDescription`): fills empty
  descriptions (or appends), updates only its own marked block, preview unless `--confirm`.
- Auto-fix PRs were considered and deliberately left out.
- Tests: 68.

## 0.6.0 — 2026-10-22 (tuning from real-PR backtest)

- **Backtest** on 16 real merged PRs (`evals/backtest.mjs`): caught 3/10 later-fixed PRs after tuning,
  found a likely live cross-tenant gap (network policy getById/update, twice independently) and a
  shared-PC grouping issue on PRs the history labelled "clean".
- **Severity floors** for 15 critical rules (never below major; original rating kept).
- **identity-provider** risk rule (Keycloak/IdP/realm/OIDC/SAML/Entra → security specialist).
- **Consensus mode** (`--consensus N`, config `consensus`): N parallel runs merged by fuzzy matching;
  keeps repeated findings or a confirmed blocker/major of a critical rule; hides one-offs. On !1111
  (3 runs) it kept the 3/3 cross-tenant-test gap and the 2/3 concurrency race that matched the later
  real fix, and hid 10 one-off findings.
- **PR-outcome precision** (`feedback.mjs`) and per-run eval output retention.
- Fixes found by the first real runs: CLI JSON-schema compatibility, stdin, `git -C` denied by the CI
  allowlist (specialists couldn't see the diff), background subagents in headless mode, CON-001/004
  labelling, noise cap.
- **Setup:** `scripts/setup.sh` (Node + CLI version, deps, plugin install via `claude plugin`, .env,
  optional az/psql checks; `--dry-run`) and `scripts/add-repo.sh` (writes the repo's pipeline file
  pinned to the current version; adds a stack-detected `repos.yml` stub; never commits).
- **Walkthrough and test plan:** the review now returns what changed per area and up to 6 concrete
  pre-merge checks; shown in the report and the PR summary (collapsible, test plan as checkboxes).
- Tests: 62.

## 0.5.0 — 2026-10-21 (phase 5)

- **Release readiness:** `release-check.mjs` / `/sfn:release` / `ci/azure/release-check.yml` — per repo
  from the latest tag (or `--from`) to `origin/develop`: PRs and work items, migrations in apply order
  (+ modified, duplicate, out-of-order, malformed), config diffs for `application*.properties|yml`, new env
  vars (flagging ones without defaults), new flags (on-by-default flagged), dependency changes (majors
  flagged), added/removed endpoint mappings and Kafka topic constants; Markdown + HTML checklist;
  optional `--review` deep review per repo.
- **Pre-push hook:** `install-hook.sh` — reviews the pushed range, blocks only on confirmed findings at
  the threshold, chains an existing hook, respects `core.hooksPath`, `SFN_SKIP_REVIEW=1` to skip,
  never blocks when the review can't run; `--uninstall` restores the previous hook.
- **Team metrics:** every run archived to `.sfn-review/history/`; `metrics.mjs` aggregates local history
  or CI `sfn-review` artifacts (ADO builds API) into a dashboard: findings per week by severity, top
  rules, by repo/category, verify reject rate, fixed on re-review. Validated ordinal palette, table view
  for every chart, light/dark. Never keyed to people.
- **Suggested reviewers** from git blame/log (names only), in report and PR summary.
- **Blast-radius diagram** (inline SVG) in the report; deterministic links (Kafka hints, UI→API calls,
  shared `tenant` table).
- Tests: 55.

## 0.4.0 — 2026-10-21 (phase 4)

- **ADO PR by number:** `run-review.sh --pr <id>` / `/sfn:review PR <id>` resolves the PR (az login,
  PAT or pipeline token), fetches its refs, reviews exactly its changes (completed PRs: against the
  target at merge time). `--post` comments on it from a local run.
- **Fix-history regression hints:** `git blame` on the base version of every line the change rewrites;
  lines last written by a fix-like commit become `historyHints`; rules HIS-001/002 in the general pass.
- **Live DB schema (read-only):** `db-snapshot.mjs` via psql with a read-only transaction and timeout,
  metadata only, URL never logged → `dbSchemaFile` for the db specialist. Off by default.
- **OSV audit:** exact versions of added/changed Maven/npm deps (npm via package-lock) checked on
  api.osv.dev → `depAuditFile`; deps specialist reports DEP-002 with real advisory ids. Off by default.
- **Azure Boards bugs:** `create-ado-bugs.mjs` + `/sfn:bugs` — preview by default, `--confirm` to
  create, idempotent via `sfn-finding-<id>` tags, iteration backlog/current/path. CI `createBugs`.
- Shared `scripts/lib/ado-api.mjs`; `post-ado-pr.mjs` works locally and in CI.
- CI template: `liveDb`, `osv`, `createBugs`, `bugIteration`.
- Tests: 49.

## 0.3.0 — 2026-10-21 (phase 3)

- Four new specialists: `review-runtime` (RUN-*), `review-webui` (WEB-001…011), `review-tests`
  (TST-001…008, writes the missing test cases), `review-deps` (DEP-001…009). Specialist choice is now
  stack-aware; `tests` joins at standard+ when production code changed.
- Deterministic dependency diff (`dependencyChanges` in the scope) from `pom.xml` / `package.json` at
  base and head, incl. `${property}` versions, scopes, parent and semver bump.
- Cross-model verification (`--cross-verify`, `crossVerify: true`, `verify.mode: cross`): the other
  provider re-checks findings, may reject/downgrade, never raise; verdict recomputed in code.
- Re-review delta: `previous-result.json` kept per run; result/report/PR summary show fixed / new / still open.
- `/sfn:fix`: local, test-first fixing of selected findings; never commits.
- General pass narrowed to plain correctness bugs (runtime rules moved to the runtime specialist).
- Shared `scripts/lib/verify.mjs` and `verdict.mjs` used by both engines.
- Evals: `scheduled-no-lock`, `webui-tenant-race`. Tests: 39.

## 0.2.0 — 2026-10-21 (phase 2)

- OpenAI engine (`--engine openai`, pipeline `engine: openai`): OpenAI or Azure OpenAI (v1 API),
  orchestrated in code — specialists in parallel, batched verify, deterministic verdict, summary call.
- Read-only tools with confinement enforced in code (real-path root checks, read-only git).
- `prompts/general.md`: the general pass as a provider-neutral prompt.
- `evals/compare-engines.mjs`; eval results are now named by engine.
- Tests: tool confinement, agent loop, client retries, orchestration, and an end-to-end run against a
  local fake API server.
- CLI version preflight (`anthropic.minCliVersion`) and clearer engine-error reporting in `finalize`.

## 0.1.0 — 2026-10-21 (phase 1)

- Anthropic engine as a Claude Code plugin (`/sfn:review`, `/sfn:report`), generated from
  provider-neutral `prompts/`.
- Specialists: `review-db`, `review-security`, `review-contracts`; adversarial `review-verify`;
  orchestrator general pass for runtime rules.
- Rules: DB-001…015, SEC-001…016, CON-001…010, RUN-001…007, plus per-repo rules for the four sfn repos.
- Deterministic scope + risk scoring + auto level; unknown repos fall back to stack defaults.
- `finalize` (schema validation, stable ids, suppressions), HTML report, SARIF, ADO PR comments, gate.
- Azure Pipelines template with run-time estate clone from `repos.yml`.
- Evals: missing-migration, tenant-leak-endpoint, kafka-breaking-change, shared-tenant-table-change,
  clean-change.

---
name: fix
description: Fix findings from the last sfn code review in the current repo, test-first — reproduce each finding with a failing test, make the smallest fix, run the repo's tests, and re-review. Local only; never commits. Use when the user asks to fix an sfn review finding, "fix the blockers", or runs /sfn:fix.
argument-hint: "<finding-id ...> | blockers | majors"
---

# Fix sfn review findings (local, test-first)

You change code here, so the rules are strict. **Never commit, push, or edit anything outside the
current repo.** Work only on the findings the user selected.

## 1. Select

1. Read `<repo>/.sfn-review/review-result.json` (`git rev-parse --show-toplevel`). Missing → tell the
   user to run `/sfn:review` first and stop.
2. If `scope.headSha` ≠ `git rev-parse HEAD` and the working tree changed since, warn that the review
   may be stale and ask whether to re-review first.
3. Resolve the argument:
   - finding ids (12-hex) → those findings;
   - `blockers` → every `blocker`; `majors` → every `blocker` + `major`;
   - nothing → list the findings (id, severity, title, file:line) and ask which to fix. Stop.
4. Skip findings whose `repo` is not this repo (cross-repo fixes need their own change) and say so.

## 2. For each finding, in severity order

State the finding (id, rule, title, failure scenario) in one line, then:

1. **Plan.** Read the cited code and evidence. If the fix needs a contract decision (API shape, data
   model, migration number, status code, scope), **ask the user** and wait — don't guess.
2. **Reproduce first** when the behaviour is testable in this repo:
   - write the smallest test that encodes the failure scenario, matching the repo's test style
     (`src/test/java/...` JUnit 5; sfn-web-ui `src/__tests__/` Vitest);
   - run only that test (Maven: `mvn -q test -Dtest=<Class>#<method>`; web-ui:
     `npx vitest run <file>`) and confirm it **fails for the right reason**.
   - Not testable (migration file, config, Docker/pipeline, needs live DB)? Say why and continue.
3. **Fix** with the smallest change that makes the failure impossible, following the repo's
   `CLAUDE.md` / `docs/PATTERNS.md`. A missing migration means a new `V<next>__*.sql` — check the
   current head on the base branch first (DB-003).
4. **Prove it**: re-run the new test (now green), then the module's tests (`repoConfig.test` from
   `.sfn-review/scope.json`, e.g. `mvn -q test` or `npm run test:run`). Integration tests may need
   Docker — if it's unavailable, say exactly which tests didn't run.
5. Record: finding id → files changed, test added, test result.

Stop and report if a fix starts touching more than ~5 files or another repo — that needs a design
decision, not an automated fix.

## 3. Close

1. Re-run the review on the working tree: `/sfn:review` (it will show fixed / new / still open against
   the previous result).
2. Report per finding: fixed ✅ (test name) · needs decision 💬 (the question) · not fixed ❌ (why).
3. Show `git status --short` and leave committing to the user.

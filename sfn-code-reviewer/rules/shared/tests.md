# Rules — tests

Owner: `tests` specialist. Applies to all repos.

## Platform facts (verified)
- APIs: JUnit 5 + Spring Boot test; integration tests use Testcontainers (`postgres:16-alpine` in
  iam-api's `BaseIntegrationTest`), so they need Docker. `EndpointAuthorizationCoverageTest` exists in
  all three APIs and fails the build on unclassified mutating endpoints.
- sfn-iam-api requires a migration test under `src/test/java/com/secufusion/iam/migration/` for schema
  changes.
- sfn-web-ui: Vitest + Testing Library, tests only under `src/__tests__/`.
- **CI test stages use `continueOnError: true`** in the APIs — a green pipeline does not mean tests
  pass, so missing or broken tests are not caught by CI.

## Rules

| ID | Severity | Rule |
|---|---|---|
| TST-001 | major | New or changed **branching business logic** (status transitions, tenant/permission decisions, deletes, money/limits, retention) with no test that exercises the new branch. Name the exact cases missing. |
| TST-002 | major | A bug fix with no regression test that fails before the fix. |
| TST-003 | major | A new endpoint or Kafka consumer with no test of its **tenant isolation** (a caller from tenant A cannot read/write tenant B). |
| TST-004 | major | A test that cannot fail: no assertion, asserts only on a mock it just stubbed, `assertTrue(true)`, catches the exception it should assert on, or is `@Disabled` without a reason/ticket. |
| TST-005 | minor | A test changed to match new behaviour without the behaviour change being intended (assertion flipped, expected value updated) — call it out so a human confirms. |
| TST-006 | minor | Time/order/randomness dependence: `Thread.sleep`, `LocalDateTime.now()` without a clock, unordered collection compared as ordered, shared static state between tests. |
| TST-007 | minor | Integration behaviour (native SQL, cascades, migrations) only covered by mocked unit tests — the real DB behaviour is untested. |
| TST-008 | minor | sfn-web-ui: new page/component logic with no test in `src/__tests__/`, or tests placed elsewhere (they won't run). |

## Output extra
For TST-001/002/003, put the concrete missing test cases in `suggestion` as a short list
(given / when / then), so they can be written directly.

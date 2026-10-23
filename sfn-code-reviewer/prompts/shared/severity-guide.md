## Severity and confidence

**Severity** — what happens if this ships as is:

| Severity | Meaning | Examples |
|---|---|---|
| `blocker` | Data loss or corruption, a security hole, a cross-tenant leak, an outage, or a contract break a caller hits on the next deploy. | missing migration for a mapped column; endpoint with no tenant guard; Kafka field renamed with a live consumer |
| `major` | A real bug or risk on a plausible path, but limited, recoverable, or needing a specific condition. | unbounded query on a growing table; 30 s UI timeout on a long call; scheduler runs on every replica |
| `minor` | Correct today but fragile, inconsistent with house patterns, or missing a log/test where it matters. | ad hoc try/catch in tenants-api; no tenant id in a new error log |
| `nit` | Style or naming only. Report at most 3 nits per review, and none at `quick` level. | naming |

The rule table's severity is the **default**. Lower it if the code path is unreachable in practice; raise
it only with a concrete reason in `failureScenario`.

**Confidence**:
- `confirmed` — you traced the failing path through the actual code (file:line at each hop in
  `evidence`), or a test/command output proves it.
- `possible` — plausible from the diff but you could not see a piece you'd need (live DB state, a repo
  not checked out, runtime config). Say exactly what's missing in `failureScenario`.

**Be selective with minors.** Report a `minor` only when it would change what the reviewer does before
merging. Prefer 0–2 strong minors over many weak ones; never two findings for the same root cause.
The pipeline keeps at most 5 minors and 3 nits per review (no nits at the quick level) and hides the rest.

**Never** report: things the diff did not touch and does not make worse; restating what the code does;
"consider adding tests" with no specific case; generic best practice with no failure scenario.

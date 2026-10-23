# Adding a rule

1. Pick the file:
   - `rules/shared/<area>.md` — applies to every repo (db-migrations, security-tenancy, contracts,
     runtime, webui, tests, deps);
   - `rules/repos/<repo>.md` — one repo's conventions and pitfalls.
2. Add a row with the next free ID in that table (`DB-016`, `SEC-019`, `CON-011`, `RUN-008`, `WEB-012`, `TST-009`, `DEP-010`):
   `| ID | default severity | rule — what's wrong and why it fails |`. If it relies on a platform fact,
   add the fact (verified, with file paths) under "Platform facts".
3. If a new path pattern should trigger a specialist, add a `riskRules` entry in `config/repos.yml`.
4. Add an eval case under `evals/cases/<name>/` that the rule must catch.
5. `npm run build && npm test && evals/run-evals.sh --case <name>`.
6. Tag a release; consumers pick it up when they bump `ref:`.

**A good rule** names the concrete failure ("the delete fails mid-batch because the FK is RESTRICT"),
not a preference ("prefer X"). If you can't write the failure scenario, it's a lint rule, not a
review rule.

## Accepting a finding (suppression)

Add to `rules/suppressions.yml` — `id` (from the report), or `ruleId` + `path` glob — with `reason`
and `expires`. Expired entries stop applying and are flagged in the run log.

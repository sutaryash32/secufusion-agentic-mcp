# Rules — regressions against past fixes

Area rules for `/sfn-review` PASS 27. Input: `get_fix_history`: fix-like commits whose lines this change removes or rewrites.

| ID | Severity | Rule |
|---|---|---|
| HIS-001 | major | The change removes or rewrites lines a recent bug fix introduced, and the new code no longer does what the fix made it do (the guard, the extra delete, the ordering, the null check is gone or weakened). Read the fix (`git show <commit> -- <file>`) and the new code side by side. Name the fix commit and what it protected against. |
| HIS-002 | minor | The change rewrites a fixed area correctly but drops the fix's test or makes it weaker. |

A hint is **not** a finding by itself: refactors legitimately move fixed code. Report only when the
behaviour the fix established is lost.

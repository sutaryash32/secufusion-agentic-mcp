---
name: report
description: Re-open or re-render the last sfn code review for the current repo (from .sfn-review/review-result.json) — show the findings again, or regenerate report.html. Use when the user asks to see the last sfn review, its report, or a specific finding.
---

# Last sfn review

1. Find `<repo>/.sfn-review/review-result.json` (`git rev-parse --show-toplevel`). If it's missing, say
   no review has run here yet and suggest `/sfn:review`.
2. If the user wants the HTML report, run:
   ```bash
   node <review-skill-dir>/bin/render-report.mjs --in <repo>/.sfn-review/review-result.json --out <repo>/.sfn-review/report.html
   ```
   (`<review-skill-dir>` is the `review` skill folder next to this one: `../review`.)
3. Otherwise summarise from the JSON: verdict + reason, findings by severity as
   `[file:line](file#Lline) — title — fix`, and the scope (`base → head`, risk, level).
4. Warn if `scope.headSha` differs from the current `git rev-parse HEAD` — the review is out of date.

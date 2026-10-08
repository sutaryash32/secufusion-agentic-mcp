---
id: "line-ending-diff-noise"
title: "A 3-line change landed as a 1,100-line diff (CRLF/LF conversion)"
category: lessons-learned
status: accepted
tags: ["line-endings","crlf","lf","diff-quality","review"]
applies_to: ["line ending","crlf","diff"]
source: "Client PR review feedback, relayed by the project owner (2026-10)"
date: 2026-10-08
supersedes: []
---

# A 3-line change landed as a 1,100-line diff

**What happened.** A client reviewing a PR reported: *"You need to be careful with line endings. A three-line change was showing up as a 1100-line change."* The functionality was correct. An unintended CRLF/LF conversion rewrote the whole file, which buried the real change, raised merge-conflict risk and cost reviewer trust. The client fixed it and approved the PR.

**What it taught us.** A correct implementation with a noisy diff is not a fully reviewed change. Review must check diff quality, not only correctness.

**What to do.**
- `/sfn-review` PASS 10 (`check_diff_quality`) measures the committed diff against the real change and explains the gap (line endings, whitespace, reformatting, reordering, encoding, scope).
- Existing style is the expected style: consistent CRLF and consistent LF are both fine. Mixed endings and unexplained churn are the problem.
- If an editor converted a file, restore its original style and reapply only the intended edits (`normalize_line_endings` converts a file back to its own style, with the user's confirmation).

**Common false positive.** With `core.autocrlf=true` the working tree can be CRLF while the repository is LF; that does not change the committed diff and is not a finding.

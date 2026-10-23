---
name: bugs
description: File Azure Boards bugs for findings from the last sfn code review — preview first, create only after the user confirms, never duplicates. Use when the user asks to raise/create/file bugs or work items from sfn review findings, or runs /sfn:bugs.
argument-hint: "[blockers|majors|<finding-id ...>] [--iteration backlog|current|<path>]"
---

# File Azure Boards bugs from sfn findings

Creating work items writes to a board the whole team shares: **always preview, always ask, never
confirm on the user's behalf.**

1. Find `<repo>/.sfn-review/review-result.json`. Missing → suggest `/sfn:review` and stop.
2. Map the argument:
   - nothing / `blockers` → `--min-severity blocker` (confirmed only, the default);
   - `majors` → `--min-severity major`;
   - specific finding ids → explain that the script files by threshold, and use the lowest severity
     among those ids, then point out which extra findings the threshold would include.
3. **Iteration.** A top-level bug needs a sprint decision. Unless the user said, ask: "current sprint or
   backlog?" → `--iteration current` or `--iteration backlog` (or a path they give).
4. Preview (creates nothing):
   ```bash
   node <review-skill-dir>/bin/create-ado-bugs.mjs --in <repo>/.sfn-review/review-result.json \
     --repo <repo> --min-severity <x> --iteration <y>
   ```
   (`<review-skill-dir>` is the `review` skill folder next to this one.) Show the user, in plain
   language: how many bugs, their titles and priorities, area and iteration, and which findings already
   have a bug (they are skipped).
5. Only after the user explicitly says yes, run the same command with `--confirm`. Report each created
   work item id and URL.

Auth comes from `az login` or `AZURE_DEVOPS_PAT`. A 401/403 means the account can't create work items
in that area — say so; don't retry with other settings.

## EXEC-Phase 2 — Execution
(TRIGGER: as you complete ACs, modify files, make decisions, or before ending any session/response)

### MANDATORY — all five MUST be called, not suggested

```
After completing any AC:
  → call manage_task(action: "update_spec",
                     pending_acs: [...remaining],
                     completed_acs: [...done],
                     next_step: "<clear, actionable instruction for resuming>")

After touching any file:
  → call manage_task(action: "log_file_touched",
                     file_path: "<exact path>",
                     change_summary: "<one-line description>")
  — call this for EVERY file modified, not just the "important" ones

After making any architectural decision:
  → call manage_task(action: "log_decision",
                     decision: "<what was decided>",
                     rationale: "<why>")
  — call this for every non-obvious decision, not just big ones

After finding an optimal/efficient solution for a problem:
  — You must dynamically seek the most optimized, core solution for a given problem statement, even if similar problems have been solved before.
  — Optimization applies only within the files and scope the spec authorizes. Do not touch files outside the spec's file list.
  — Once identified (through reasoning, `get_task_history`, or `get_pattern_from_task`), add an architectural reasoning comment ONLY when the implementation is non-obvious or deviates from the simplest approach. Match surrounding comment density otherwise. When added, the comment goes directly into the source where the solution is implemented and explains the architectural reasoning and why this specific optimized approach was chosen.

After writing any test scenario:
  → call manage_task(action: "add_scenario",
                     scenario: "<description>",
                     scenario_type: "unit" | "integration" | "e2e" | "manual")
```

### next_step is a contract — hard rules

`next_step` MUST be:
- A single, self-contained instruction your future self executes without re-reading the spec
- Specific: include file name, method name, or AC number
- Updated after EVERY response — a stale next_step is a violation

`next_step` MUST NOT be:
- Vague: `"Continue implementation"` ← **VIOLATION**
- Generic: `"Review the code"` ← **VIOLATION**
- Empty or missing ← **VIOLATION**

### Hard enforcement

❌ Do NOT end a response without calling `update_spec` if any AC was completed  
❌ Do NOT modify a file without calling `log_file_touched`  
❌ Do NOT make an architectural decision without calling `log_decision`  
❌ Do NOT write a test without calling `add_scenario`  
❌ Do NOT leave a vague or empty `next_step`  

---

### Prove it before you hand off

Reasoning about your own change is part of the job, not a step someone else does later.
- Before you write a guard, a query on tenant-owned data or an ownership change, ask how another path could break the same rule (another role, tenant, retry, scheduled job, import, old data). Read the neighbouring code and copy its way of scoping by tenant.
- After you write it, call `check_tenant_flow` on the files you wrote and fix every HIGH lead in a file the spec authorizes.
- Before you hand off, call `build_claims_ledger` with the acceptance criteria as claims and, for each, the code that implements it and the test that proves it (each with a quote copied from the file). Fix every written-not-built and untested gap, and explain every changed region that no criterion accounts for: link it to a criterion, or remove it.
- Say what you did not check. A handoff that lists only what passed hides what was not examined.

### WORK-ITEM IDENTITY IS METADATA (STRICT RULE)

A ticket reference such as `BUG-1230`, `TASK-1230`, `STORY-1230`, `FEATURE-1230` or `EPIC-1230` is identity, not decoration. It must stay
identical in Azure Boards, task folders, intent files, branch names, commit messages, PR titles and every reference you write.

- **Preserve the type exactly as the user wrote it** (`BUG-1230` stays `BUG-1230`; never `task-1230`, `Task-1230`, `Feature-1230`, `US-1230`).
- **Never replace a known type with a generic default** such as "task", and never derive the type from the classification's `task_type`
  (that describes the kind of work, not the ticket). If the type is uncertain, keep the prefix you were given; do not infer a new one.
- **Pass the reference to every tool exactly as given** (`work_item_id: "BUG-1230"`, not `"1230"`). If the user gave only a number, ask
  which type it is, or keep the bare number; do not guess.
- **Do not free-hand names.** Call `resolve_work_item_ref(work_item, title)` and use its `ref`, `branch_suffix`, `commit_prefix` and
  `pr_title_prefix` verbatim (e.g. branch `…/BUG-1230-tenant-deletion-fails`, commit `BUG-1230: fix tenant deletion status`).
- If a tool reports an `IDENTITY CONFLICT` (the same ticket number registered under a different type), stop and tell the user. Do not
  pick one yourself.

## EXEC-Phase 3 — Course Correction
(TRIGGER: developer corrects you, rejects an approach, or says "don't do that")

### MANDATORY sequence

```
STEP 1: call log_rejected_pattern(
          pattern: "<exact bad pattern or approach>",
          reason: "<why rejected and what the correct alternative is>",
          category: "architecture"|"security"|"database"|"logging"|"api-design"|"testing"|"other",
          file_context: "<file where observed, if applicable>")

STEP 2: acknowledge the correction explicitly in your response
STEP 3: do NOT repeat the rejected pattern — ever
```

### Hard enforcement

❌ Do NOT wait until end of session to log — log rejected patterns immediately  
❌ Do NOT continue with the rejected approach while "noting" the correction  
❌ Do NOT suggest the same pattern again in any future response or session  
❌ Check `.rejected-patterns.json` implicitly before every architectural suggestion — matching a past rejection makes it forbidden  

---

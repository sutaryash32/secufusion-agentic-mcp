# SecuFusion System Prompt & Memory

This file serves as the primary system prompt and state memory for Claude when working within the SecuFusion ecosystem. 

**Rule Zero:** Always check the `<MEMORY>` block below before executing any commands to ensure the project DNA has been loaded.

---

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

## The 4-Command Pipeline

You must strictly execute these commands in the prescribed order by calling the underlying MCP tools or personas.

### 1. `sfn:init`
**Purpose:** Prime the ecosystem for the first time.
**Execution Sequence:**
1. Call the `secufusion-dna-plugin` tools to scan the repository.
2. Generate the architectural map and configuration extracts.
3. Update the `<MEMORY>` block in this file with a summary of the architecture and set `DNA_LOADED = true`.

### 2. `sfn:plan [task_id]`
**Purpose:** Architect the solution based on the loaded DNA and initialize the task workspace.
**Execution Sequence:**
1. Verify `DNA_LOADED == true` in the `<MEMORY>` block. If false, abort and tell the user to run `sfn:init`.
2. Call `manage_task(action: "initialize", work_item_id: [task_id])` to create the dedicated task folder (`.secufusion/tasks/[task_id]`) and track progress.
3. Call `prime_session` to load the DNA state efficiently.
4. Call `classify_task` to categorize the work and lock in architectural boundaries.
5. Route to `planner.md` to generate the strict implementation plan.

### 3. `sfn:review`
**Purpose:** Validate the code against zero-tolerance architectural rules.
**Execution Sequence:**
1. Call the `run_pre_pr_checks_with_reviewer_agent` CLI subprocess (`scripts/sfn-pr-check.ts`).
2. Do not proceed until you receive a `✅ APPROVED` verdict from the Tier 1 mechanical checks.
3. Route to `reviewer.md` for the final PR Handoff.

### 4. `sfn:watch`
**Purpose:** Enable continuous background learning.
**Execution Sequence:**
1. Turn on the background file watcher via the DNA engine to automatically detect and index new patterns as the user codes, keeping `.secufusion/dna.json` fresh.

---

<MEMORY>
{
  "DNA_LOADED": false,
  "LAST_INIT": null,
  "ARCHITECTURE_SUMMARY": "Run sfn:init to generate the architectural summary.",
  "ACTIVE_WORK_ITEM": null
}
</MEMORY>

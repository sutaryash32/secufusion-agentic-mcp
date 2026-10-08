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

## The Command Pipeline: init, spec, code, review

You must strictly execute these commands in the prescribed order by calling the underlying MCP tools or personas.

### 1. `sfn:init`
**Purpose:** Prime the ecosystem for the first time.
**Execution Sequence:**
1. Call the `secufusion-dna-plugin` tools to scan the repository.
2. Generate the architectural map and configuration extracts.
3. Update the `<MEMORY>` block in this file with a summary of the architecture and set `DNA_LOADED = true`.

### 2. `sfn:spec [ticket-ref]`  (replaces `sfn:explore` + `sfn:plan`)
**Purpose:** Think before building. Investigation and design are one engineering thought process, and the deliverable is a complete Implementation Specification.
**Execution Sequence:** follow `commands/sfn-spec.md` exactly. In short:
1. Verify `DNA_LOADED == true` in the `<MEMORY>` block. If false, abort and tell the user to run `sfn:init`.
2. Understand: intent, `philosophy_check`, `spec_create_intent`, `manage_task initialize`, `manage_requirement create`.
3. Investigate the real repository (DNA, source, tests), find the root cause with `file:line` evidence, classify the task.
4. Analyze: UI impact and reference (when affected), and every open decision, asked of the USER with a hard STOP. Never invent a decision.
5. Confirm the requirement, create and validate the plan, then `generate_spec_document`. Yield for approval.
**Never write production code in this phase.**

### 3. `sfn:code [ticket-ref]`
**Purpose:** Build only what was specified.
**Execution Sequence:** follow `commands/sfn-code.md`. `spec_status` must show the plan gate passed and `spec.md` must exist; implement that document with the Coder Persona
(`coder.md`): focused changes, repository conventions preserved (including line endings), no unrelated refactoring, nothing outside the specified files without amending the spec.

### 4. `sfn:review [ticket-ref | service | file]`
**Purpose:** Verify correctness AND change quality. A correct implementation with a noisy diff is not a fully reviewed change.
**Execution Sequence:** follow `commands/sfn-review.md` (PASS 0-10, including PASS 10 diff quality via `check_diff_quality`), then record the verdict with `verify_against_spec`.
That tool refuses `APPROVED` while a HIGH diff-quality finding is unacknowledged by the user. Route to `reviewer.md` for the final PR hand-off.

### Utilities
- `sfn:explore map` / `sfn:explore impact <component>`: architecture map and blast radius (ticket investigation now lives in `sfn:spec`).

### 5. `sfn:watch`
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

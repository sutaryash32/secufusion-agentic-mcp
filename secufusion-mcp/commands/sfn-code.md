---
description: Build only what was specified. Implements the approved Implementation Specification (from /sfn-spec) with the Coder Persona: focused changes, repository conventions preserved, no unrelated refactoring.
argument-hint: <ticket-ref, exactly as written>  e.g. BUG-1230
---

You are executing the **sfn-code** command for the SecuFusion spec-driven SDLC.

Task: **$ARGUMENTS**

**You are now in the IMPLEMENTATION phase.**

## Pre-flight: Specification Check

1. Call `spec_status(work_item_id: "$ARGUMENTS")`. The `plan` gate must be ✅. Read the specification: `.secufusion/tasks/<ref>/spec.md` (written by `generate_spec_document`).
2. If the plan gate has not passed or `spec.md` does not exist, **ABORT** and tell the user:
   > ❌ No approved specification found for `$ARGUMENTS`. Please run `/sfn-spec $ARGUMENTS` first.
   Do not improvise a plan here. Investigation and design belong to `/sfn-spec`.
3. Read `.agents/coder.md` to load the **Coder Persona** — your behaviour for this phase is governed by those instructions.
4. Before writing ANY file, follow **ARTIFACT PLACEMENT AND FILE-CREATION DISCIPLINE** in `.agents/AGENTS.md`: classify it (work-item artifact, project knowledge, or repository file), state the preflight line, never overwrite an MCP-generated file, and log every file with `manage_task` `log_file_touched`.

## Phase 1 — Load Rejected Patterns Memory

Call `get_pattern_from_task(work_item_id: "$ARGUMENTS")` to retrieve any rejected patterns logged for this task. If patterns exist, internalize them as hard constraints — **do not repeat them under any circumstances.**

## Phase 2 — Load Migration Context

**Before writing a single line of code**, read `.secufusion-migrations.json` from the workspace root (or `scripts/` subfolder).

From this file, load for each service involved in this task:
- `current_state.next_suggested` — the correct next migration filename
- `organization.version_gaps` — version numbers that MUST NOT be reused
- `mcp_guardrails.naming_pattern_to_enforce` — the regex all filenames must match
- `content_conventions.comment_style` — how to write the migration header block

If the file is not found: warn the user and continue, but flag any DB changes as requiring manual migration creation before deploy.

## Phase 3 — Implement

Execute the specification step by step (its "Implementation strategy" and "Expected file changes"):

- Follow the specification's file list exactly. Do not create or edit files outside its scope. If a file outside it must change, **stop and ask**: amend the spec first (`/sfn-spec`), then continue.
- **Build only what was specified.** No unrelated refactoring, renames, reordering, reformatting or drive-by cleanups: they enlarge the diff and are flagged by `/sfn-review`.
- **Preserve repository conventions.** Match the surrounding code (indentation, naming, import order, quote style, **line endings**). Never convert a file's line endings or reformat it as a side effect; if your editor changed them, restore them before handing off (`check_diff_quality`, then `normalize_line_endings` only if the user asks).
- On every file that touches multi-tenant data: verify tenant isolation is enforced (row-level WHERE clause, header propagation). If it is not, **stop and flag it** before writing.
- On every new DB query: check for N+1 patterns and missing indexes. Flag before writing.
- On every Kafka publish: verify it is async / non-blocking. Flag synchronous calls.

### Migration awareness during implementation

After writing any of the following:
- New `@Entity` class
- New `@Column` on an existing entity
- Modified `@Column` (type, nullable, length change)
- Removed `@Column` or `@Table`
- New `@Table` or renamed table

**IMMEDIATELY stop and do the following:**

1. Read `.secufusion-migrations.json` (already loaded in Phase 2).
2. Identify which service this file belongs to from its path (e.g. `sfn-events-api/src/...`).
3. Look up `current_state.next_suggested` for that service.
4. Check `organization.version_gaps` — do NOT use any of those version numbers.
5. Warn the developer:

```
⚠️  DB CHANGE DETECTED
File:    {entity file path}
Service: {inferred service name}

A migration script is required before this can be deployed.

Next migration for this service: {next_suggested from .secufusion-migrations.json}
Location: src/main/resources/db/migration/

🔴 IMPORTANT: SecuFusion applies migration scripts MANUALLY.
   Nothing runs automatically on boot.
   You MUST run the script against the target PostgreSQL database
   BEFORE deploying this code.

Shall I draft the migration script now?
Reply YES and I will create a draft following:
  - Naming: {naming_pattern_description from .secufusion-migrations.json}
  - Comment header style: {comment_style from content_conventions}
  - IF NOT EXISTS guards where applicable
  - Index in same file for any new filterable column
  - Constraint naming: {constraint_naming from content_conventions}
```

**If the developer says YES:**
- Draft the migration SQL.
- Show the draft for review — do NOT write the file until the developer approves.
- After approval, log the new file with `manage_task(action: "log_file_touched")`.

After each logical step, call `manage_task(action: "update_spec", work_item_id: "$ARGUMENTS", next_step: "<what was just completed>")` to track progress.

## Phase 4 — Self-Review

Before handing off, perform a fast self-review against the Acceptance Criteria in `spec.md`. For each criterion, confirm it is met with a `file:line` citation.

For every migration script created in this task, verify:
- [ ] Filename matches the naming pattern from `.secufusion-migrations.json`
- [ ] Version number is the correct next (not a gap, not already used)
- [ ] File has a comment header with WHY context
- [ ] IF NOT EXISTS guards used for CREATE TABLE
- [ ] Indexes included in same file for new filterable columns

If any criterion is unmet, fix it now before reporting.

## Phase 5 — Handoff

Call `manage_task(action: "complete", work_item_id: "$ARGUMENTS")` to mark the task as coded.

Report to the user:
- Files created/modified
- ACs met (with file:line)
- Migration scripts created (with manual run reminder)
- Any open risks or deferred items

> 🚀 Implementation complete. Run `/sfn-review $ARGUMENTS` to run the zero-tolerance PR gate checks.

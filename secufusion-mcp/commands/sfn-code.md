---
description: Build only what was specified. Implements the approved Implementation Specification (from /sfn-spec) with the Coder Persona: focused changes, repository conventions preserved, no unrelated refactoring.
argument-hint: <ticket-ref, exactly as written>  e.g. BUG-1230
---

You are executing the **sfn-code** command for the SecuFusion spec-driven SDLC.

Task: **$ARGUMENTS**

**You are now in the IMPLEMENTATION phase.**

**Context first.** Before anything else, run the context sufficiency protocol (Rule 0b in `.agents/AGENTS.md`): inventory what is available (the request, the repository state, the task artifacts, the project knowledge), recover what is missing from the repository, and ask the user only a targeted confirm-or-correct question that is critical, not inferable and blocking. State your context confidence (HIGH, MEDIUM or LOW) and keep confirmed facts, recovered context and assumptions apart in what you produce. Here that means: the approved specification, the current branch, the staged and modified files and the task folder are your inventory; a file outside the spec is a question for the spec, not a guess.

## Pre-flight: Specification Check

1. Call `spec_status(work_item_id: "$ARGUMENTS")`. The `plan` gate must be ✅. Read the specification: `.secufusion/tasks/<ref>/spec.md` (written by `generate_spec_document`).
2. If the plan gate has not passed or `spec.md` does not exist, **ABORT** and tell the user:
   > ❌ No approved specification found for `$ARGUMENTS`. Please run `/sfn-spec $ARGUMENTS` first.
   Do not improvise a plan here. Investigation and design belong to `/sfn-spec`.
3. Read `.agents/coder.md` to load the **Coder Persona** — your behaviour for this phase is governed by those instructions.
4. Before writing ANY file, follow **ARTIFACT PLACEMENT, ONE HOME PER DOCUMENT** in `.agents/AGENTS.md`: decide the document's type and use its single home, search before you create, state the preflight line, never overwrite an MCP-generated file, and log every file with `manage_task` `log_file_touched`.

> **Changes after review are unreviewed changes.** When `/sfn-review` approves, the server records the exact content of every changed file. If you change any file after that verdict (a fix, a polish, a "small" UI tweak), the review is **STALE**: `spec_status` says so and `manage_task action=complete` is refused until `/sfn-review` has reviewed what changed and recorded a fresh verdict. Tell the user when you change code after a review.

## Phase 1 — Load Rejected Patterns Memory

Call `get_pattern_from_task(work_item_id: "$ARGUMENTS")` to retrieve any rejected patterns logged for this task. If patterns exist, internalize them as hard constraints — **do not repeat them under any circumstances.**

Also load `.rejected-patterns.json` for global patterns. Task-level patterns take precedence on conflict.

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
- **Build only what was specified.** No unrelated refactoring, renames, reordering, reformatting or drive-by cleanups: they enlarge the diff and are flagged by `/sfn-review`. Drive-by refactors are forbidden UNLESS the SOLID/DRY pass below (Phase 3A) identifies a violation in a file the spec already authorizes.
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

After each AC is completed, call `manage_task(action: "update_spec", work_item_id: "$ARGUMENTS", completed_acs: [...done], pending_acs: [...remaining], next_step: "<specific instruction for resuming>")` as `.agents/coder.md` requires.

## Phase 3A — Code Quality

Run these four checks after writing each file. They are not optional.
Do not proceed to the next file until all four pass.

**Any language.** The examples below use Java and Spring. Apply the intent in the file's own language: a "class" is a class, struct, module or type; an "interface" is an interface, protocol or trait; "injection" is whatever the stack uses to pass dependencies (constructor arguments, DI container, function parameters). Follow the repository's own idioms: the SOLID and DRY checks are about responsibilities and duplication, not about Java syntax.

### CHECK 1 — SOLID violations

For every new class and every modified method in this file:

- **Single Responsibility:** does this class or method do more than one thing? In SecuFusion context: a service method that validates input, calls a repository, publishes a Kafka event, AND updates audit fields violates SRP. Split into: a validation method, a persistence method, an event method.
- **Open/Closed:** if adding this feature required editing a switch/if-else chain or a method that was already complete, flag it. The extension should have been added via a new implementation, not by modifying existing logic. In SecuFusion context: tenant-type-specific behavior must not be an if/else on tenant type; it should use a strategy or the existing policy dispatch pattern.
- **Liskov Substitution:** if this class extends another, verify that the subclass does not override a method to throw an exception or silently do nothing. In SecuFusion context: any `UserService` subclass or decorator must honor the full `UserService` contract.
- **Interface Segregation:** if a new interface is added, it must not force implementors to provide methods they do not need. In SecuFusion context: do not add methods to `IUserService` that only the transfer flow needs; create a narrower interface.
- **Dependency Inversion:** new classes must depend on abstractions, not on concrete repository or service classes directly. In SecuFusion context: inject `UserRepository` via its interface, not the concrete JPA class.

For each violation found:
- Do not add a review comment. FIX IT in the current file immediately.
- If the fix requires touching a file outside the spec's authorized list, record it as a SUGGESTION in the handoff note; do not touch the file.

### CHECK 2 — DRY / repetition detection

Before writing any new method, utility, or query:
- Call `find_repeated_outcomes` with the method's intent as the query.
- Call `smart_search` for the core logic pattern (e.g. "tenant email domain check").
- Before writing a query or ORM call on tenant-owned data, in any language, read how the neighbouring code scopes by tenant and copy that; afterwards call `check_tenant_flow(workspace_root, files = the files you wrote)` and fix every HIGH lead in an authorized file.
- If an existing method does the same thing: USE IT, do not rewrite it.
- If two or more existing methods do the same thing: extract a shared helper IN THIS FILE if it is authorized; note it in the handoff if not.

After writing, scan the current file for:
- Duplicated null checks that could be a single guard method
- Duplicated tenant ID extraction that could use `tenantContext` directly
- Duplicated repository call sequences that appear more than twice
- Copy-pasted error message strings: extract to a constant

For each duplication found: extract immediately if in an authorized file. Record in the handoff note if extraction requires a file outside the spec.

### CHECK 3 — Code placement

After writing a new method or block, verify its placement:
- New private helper: place immediately below the first method that calls it.
- New public service method: place with other methods of the same category (query methods together, write methods together, guard methods together).
- New constant or static field: place at the top of the class with existing constants.
- New inner class: place at the bottom of the outer class.
- NEVER append to the end of the file unless the file has no existing structure.

In SecuFusion context:
- `UserService`: guard methods (`ensureX`) go near the top after field declarations.
- `GroupService`: membership methods go in the membership section, not at EOF.
- Controllers: endpoint methods go in URL order (GET before POST before PUT before DELETE).
- Repositories: query methods go after the standard `CrudRepository` methods.

If you appended to EOF: move the code to its correct location now.

### CHECK 4 — Formatting

After placing the code correctly, verify:
- Indentation matches the file's existing pattern exactly (tabs vs spaces, indent width). Copy from the nearest neighbor method, not from memory.
- Import statements: new imports go in the existing import block, in the same grouping style (standard lib / third party / internal).
- Method signature style matches neighboring methods (annotation placement, `throws` declaration, parameter line-breaking threshold).
- No trailing whitespace on any line you wrote.
- Call `check_diff_quality` after writing each file. If it flags line endings or whitespace, fix before moving to the next file.
- On new files with no neighbors: follow the first existing file of the same type in the same package as the style reference.

## Phase 4 — Self-Review

Before handing off, perform a fast self-review against the Acceptance Criteria in `spec.md`. For each criterion, confirm it is met with a `file:line` citation.

Do it with the ledger: call `build_claims_ledger` with `claims` = the acceptance criteria, `evidence` = for each one the code that implements it and the test that proves it (each with a quote copied from the file), and `base` = the branch you will merge into. Fix every `WRITTEN_NOT_BUILT` and `UNTESTED` gap, and explain every `BUILT_NOT_WRITTEN` region: either it belongs to a criterion (link it) or it is scope you added (remove it, or ask).

If the repository has a mutation-testing tool configured (PIT, Stryker, Infection, mutmut, go-mutesting, cargo-mutants), run it on the files you changed and call `analyze_mutation_report`. A surviving mutant on a guard you wrote means the guard has no test that would notice it breaking: add the test.

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

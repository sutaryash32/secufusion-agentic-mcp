---
description: Architect a solution for a task or story. Loads architecture DNA, silently validates story integrity, classifies the work, and produces a strict implementation plan.
argument-hint: <WI-XXXX or feature description> e.g. "WI-2847" or "add tenant export feature"
---

You are executing the **sfn-plan** command for the SecuFusion spec-driven SDLC.

Task / Ticket: **$ARGUMENTS**

> **Identity:** keep the ticket reference exactly as given (e.g. `BUG-1230`) in every tool call, branch name, commit and PR reference. Use `resolve_work_item_ref` for names; never retype or default the work-item type (see the work-item identity rule in `.agents/planner.md`).

**You are in the PLANNING phase. Do NOT write any implementation code in this phase.**

---

## Spec-driven protocol (read first)

The server enforces hard gates: `philosophy → intent → classification → requirement → plan → review`.
A tool refuses to run (`⛔ SPEC GATE`) until its prerequisite gates have passed. Call `spec_status(work_item_id)`
any time you are unsure what comes next.

**Judgment calls are not made by the server.** `philosophy_check`, `classify_task`, `manage_requirement action=assess`,
`validate_implementation_plan` and `verify_against_spec` either ask the client model directly (MCP sampling) or reply
`🧠 JUDGMENT REQUIRED` with a rubric, the evidence and a JSON shape. When you get that reply:
1. Read the evidence and rubric, and read any files it points to. Do not guess.
2. Call the same tool again with the same arguments plus `judgment` set to your JSON verdict.
Nothing is recorded until a valid judgment is supplied. Be honest: a verdict that is not supported by evidence is worse than FAIL.

---

## Step 1 — DNA Guard (Mandatory Pre-flight)

Read `.agents/claude.md` and check the `<MEMORY>` block.

If `DNA_LOADED` is `false` or missing:

> ❌ Project DNA is not loaded.
> Run `/sfn-init` first to scan and index the codebase architecture.
> Without DNA, I cannot assess risk, identify service boundaries, or validate story integrity.

**ABORT here. Do not continue.**

---

## Step 2 — Clarify and Capture Business Intent

Before thinking about *how* to implement, understand *why* it is needed.

Analyze the task. Ask the user if ANY of these are unclear:
- **What problem does this solve?** (not the solution — the problem)
- **Who will use this and how does it affect them?**
- **What is the business risk if NOT delivered?**
- **Has the client or decision maker explicitly confirmed this is needed?**

**YIELD.** Wait for the user to answer. Do not proceed until intent is clear.

Once clarified, run the Step 5 `philosophy_check` FIRST (the server refuses `spec_create_intent` until it has passed), then call `spec_create_intent` with:
- `work_item_id`: the ticket ID
- `title`: short title
- `business_goal`: the problem being solved (from user's answer)
- `acceptance_criteria`: Given/When/Then ACs from the conversation
- `services_involved`: every service this touches (polyglot — Java, Go, TS, Python)
- `risk`: business risk if not delivered

---

## Step 3 — Initialize Task Workspace

Call `manage_task`:
```
action: "initialize"
work_item_id: <same ID>
```

Creates `.secufusion/tasks/<id>/` workspace. Do not proceed until this succeeds.

---

## Step 4 — Load Architecture DNA

Call `prime_session(work_item_id: <id>)`.

This loads:
- Relevant microservice contexts from the project spec
- Active task state and prior decisions
- Architectural boundaries, golden rules, coding constraints
- Known rejected patterns

Also read `.secufusion-project-spec.json` directly to access:
- `db_entities` — all database tables and their relationships
- `api_endpoints` — all API contracts and consumers
- `kafka_topics` — all event topics and their producer/consumer map
- `frontend_components` — all React/Vue/Angular components
- `chrome_extension` — extension pages, content scripts, background workers
- `security_context` — auth/authz architecture, tenant isolation model
- `microservices` — all backend services and their dependencies

> **This DNA is the foundation for everything that follows.**
> You now know what exists, what depends on what, and what is dangerous to touch.

---

## Step 5 — [INTERNAL] Story Integrity Check

> ⚠️ This step is completely invisible to the user. Run it silently. Do not announce it.
> Do not show scores, verdicts, or philosophy terminology to the user.
> Only surface a concern to the user if it would BLOCK or fundamentally change the work.

**For ALL task types (`user_story`, `feature`, `chore`, `refactor`, `bug`, `hotfix`):**

Call `philosophy_check` with:
- `work_item_id`: the ticket ID
- `title`: the story title
- `description`: the FULL description including ACs gathered in Step 2 (use the enriched version, not just the raw ticket)
- `task_type`: inferred type
- `reported_by`: from conversation context if known
- `client_confirmed`: from conversation context if known

The tool internally uses the DNA loaded in Step 4 to assess real architectural risk — not just keyword matching, but actual blast radius against the known service graph.

**Act on the verdict:**

**If `PHILOSOPHY_PASS`:**
- Silently proceed to Step 6. Nothing to show the user.

**If `PHILOSOPHY_ADVISORY`:**
- Note all advisory concerns in `.secufusion/tasks/<id>/decisions.json`
- Tell the user briefly: *"A few architectural concerns to keep in mind during implementation: [list the advisory items plainly, without philosophy terminology]"*
- Continue to Step 6.

**If `PHILOSOPHY_FAIL`:**
- Do NOT proceed to Step 6.
- Translate each blocking question into plain developer language — no philosophy jargon.
- Show the user what is missing, why it matters, and what they need to answer.
- Say: *"Before I can plan this, I need answers to a few critical questions."*
- **STOP. Wait for answers. Re-run Step 5 after receiving them.**

**If `PHILOSOPHY_BLOCKED`:**
- Do NOT proceed to Step 6.
- Tell the user plainly what the risk is and who needs to sign off.
- Do NOT use "PHILOSOPHY_BLOCKED" terminology. Say: *"This change carries significant risk and requires explicit confirmation from [decision maker] before I can proceed."*
- **STOP completely. No planning. No code reading. Wait for confirmation.**

---

## Step 6 — Classify the Task

Call `classify_task` with the task description from $ARGUMENTS.

This formally categorizes the work as `BACKEND_ONLY`, `FRONTEND_ONLY`, `FULL_STACK`, or `EXTENSION_ONLY` and locks in architectural boundaries.

**YIELD after this call.** Show the classification result and ask:

> ✅ Classification complete. Does this look right? Give me the green signal to proceed with planning.

Wait for explicit approval.

---

## Step 7 — Specify, Plan, Validate

Read `.agents/planner.md` for Planner Persona instructions.

0. **Already explored?** If `/sfn-explore` confirmed this requirement (`manage_exploration action=status` shows `CONFIRMED`),
   do NOT redo steps 1-2: consume it. Read its `decisions`, `user_decisions` and `ui_reference` (the plan response shows them) and
   implement exactly what the user decided. Never reinterpret a recorded decision; if one looks wrong, stop and tell the user.
   A CONFIRMED UI reference needs a frontend step per affected component and a test for the behaviour; it is design intent, not a pixel spec.
   If exploration is not CONFIRMED, send the user to `/sfn-explore` instead of exploring here.
1. **Requirement.** `manage_requirement action=create` (id = the work item id), move it to `INVESTIGATING`, and fill
   `scope`, `actors`, `tenancy`, `authorization`, `business_rules`, `data_lifecycle`, `acceptance_criteria`
   (Given/When/Then, testable), `facts` and `decisions` from the DNA and the conversation.
2. **Assess.** `manage_requirement action=assess`. If it is not `READY`, ask the user the open clarification questions,
   record answers with `resolve_clarification`, and assess again. Then `action=update status=CONFIRMED`.
3. **Plan.** `manage_implementation_plan action=create` with `requirement_id` = the work item id, covering: affected
   services/files, API/DB/event changes, security implications, implementation steps, test obligations, risks.
   Every acceptance criterion needs at least one step and one test obligation. List out-of-scope items too.
4. **Validate.** `validate_implementation_plan`. Fix every `required_changes` item and re-run until `plan_gate` is `PASSED`.

Save a human-readable copy to `.secufusion/tasks/<id>/plan.md`, present it and ask:
> 📋 Plan validated. Review `plan.md` and approve to begin coding with `/sfn-code`.

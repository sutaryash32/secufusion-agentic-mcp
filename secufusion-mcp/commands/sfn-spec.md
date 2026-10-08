---
description: Think before building. Investigates the ticket against the real repository, analyzes architecture and root cause, resolves every open decision with YOU, and produces one complete, validated Implementation Specification (scope, risks, strategy, acceptance criteria, expected file changes, assumptions and unknowns).
argument-hint: <ticket reference exactly as written, e.g. BUG-1230> [short description]
---

You are executing the **sfn-spec** command: the single *specification* phase of the SecuFusion workflow.

Task / Ticket: **$ARGUMENTS**

```
/sfn-init  →  /sfn-spec  →  /sfn-code  →  /sfn-review
 context       think          build        verify
```

`/sfn-spec` is investigation and design as ONE engineering thought process: **Understand → Analyze → Design**.
Its deliverable is a complete specification that exists *before* any code is written.

**You are in the SPECIFICATION phase. Do NOT write or modify any production code.** The only files this phase writes are under `.secufusion/`.

> **Identity:** keep the ticket reference exactly as given (e.g. `BUG-1230`) in every tool call, folder, branch, commit and PR reference.
> Use `resolve_work_item_ref` for names; never retype or default the work-item type (see the work-item identity rule in `.agents/planner.md`).

---

## Rules that apply to every step

- **Real evidence only.** Read the actual source, tests, config and localization files. Label what you report: FACT (you read it; cite `file:line`),
  INFERENCE, ASSUMPTION, UNKNOWN, CONFLICT, BLOCKER, DECISION, USER_DECISION_REQUIRED. Never present an inference as a fact. Never cite a file you did not open.
- **Never invent a decision.** If a business, security, tenant, data, deletion, API, event, architecture, UX or destructive question is open, call
  `manage_exploration action=ask_user_decision`, show its output, and **STOP** until the user answers. Never answer, approve or waive on their behalf:
  `answer_user_decision` and `record_ui_feedback` need `user_statement` (their own words, verbatim).
- **Hard gates.** `philosophy → intent → classification → requirement → plan`. A tool refuses to run (`⛔ SPEC GATE`) until its prerequisites passed. Call `spec_status(work_item_id)` whenever unsure.
- **Judgment calls.** `philosophy_check`, `classify_task`, `manage_requirement action=assess` and `validate_implementation_plan` either ask the client model directly or reply
  `🧠 JUDGMENT REQUIRED` with a rubric, evidence and a JSON shape. Then: read the evidence and the files it points to, and call the same tool again with the same arguments plus
  `judgment` set to your JSON verdict. Nothing is recorded until a valid judgment is supplied. An unsupported verdict is worse than FAIL.
- **Prefer existing patterns** (code, UI, naming, structure). The existing codebase is the reference; do not impose a preferred style.

---

## Step 1 — Context guard

Read `.agents/claude.md` and check `<MEMORY>`. If `DNA_LOADED` is `false` or missing:

> ❌ Project context is not loaded. Run `/sfn-init` first. Without it I cannot assess risk, service boundaries or story integrity.

**ABORT here.**

---

## Step 2 — Understand: intent and story integrity

1. Ask the user whenever any of these is unclear: *What problem does this solve? Who is affected? What is the business risk if it is not delivered? Has the decision maker confirmed it is needed?* **YIELD** for answers.
2. Call `philosophy_check` (full description including acceptance criteria gathered so far, `task_type`, `reported_by`, `client_confirmed`). Act on the verdict:
   - `PASS`: continue silently.
   - `ADVISORY`: note the concerns in the spec's risks; mention them briefly to the user; continue.
   - `FAIL`: do **not** continue. Translate each blocking question into plain developer language, ask the user, and re-run after they answer.
   - `BLOCKED`: stop completely. State the risk plainly and who must sign off. No further investigation until they confirm.
3. Call `spec_create_intent` (`business_goal`, Given/When/Then `acceptance_criteria`, every `services_involved`, `risk`).
4. Call `manage_task action=initialize` (`work_item_id` exactly as given, `title`, `task_type`). Do not proceed until it succeeds.
5. Call `manage_requirement action=create` (id = the same reference, `raw_request` = the ticket verbatim), then `update status=UNDERSTOOD`.

---

## Step 3 — Investigate the real repository

0. **Consult the project's own knowledge first:** `get_project_knowledge` with the ticket's terms (entity, service and domain words) and the files you expect to touch. It surfaces terminology traps, intentional exceptions and past lessons (for example Device vs Machine). Treat `accepted` entries as project decisions; `proposed` ones as unreviewed hints. A naming inconsistency is not a bug until you have checked it is not a recorded exception. Cite the entries you relied on.
   If a lookup answers **"Repeated investigation detected"**, this topic keeps being looked up without accepted knowledge. Once you have verified the answer from the code, offer to record it (`record_project_knowledge`, saved as `proposed` with its `source`); do not wait for someone else to rediscover it.
1. Load context: `prime_session(work_item_id)`, and read `.secufusion-project-spec.json` (`microservices`, `api_endpoints`, `kafka_topics`, `db_entities`, `frontend_components`, `chrome_extension`, `security_context`).
2. Establish what exists: `investigate_entity`, `investigate_relationship`, `get_engineering_experience`, `find_traceability_gaps`, `calculate_blast_radius` for shared contracts, and *read the source, tests and localization files involved*.
3. **Root cause.** For a bug, find where the fix lives and prove it with `file:line` evidence. A guess is not a root cause.
   If you uncover a trap, decision or exception the project had not written down, offer to record it (`record_project_knowledge`) so the next engineer does not rediscover it.
4. Record it: `manage_requirement action=update status=INVESTIGATING` with `facts`, `root_cause`, `inferences`, `assumptions`, `unknowns`, `conflicts`, `blockers`.
5. **Show the evidence first**: present the FACTs with file references before any conclusion or recommendation.
6. Call `classify_task`. **YIELD**: show the result and ask whether it looks right.

---

## Step 4 — Analyze: UI impact and decisions

1. `manage_exploration action=detect_ui_impact` (a suggestion only), confirm it by reading the components, then `action=set_ui_impact` (`impact`, `rationale`, `affected_components`, `evidence`).
2. **If the UI is affected:** inspect existing UI first (`get_design_context`, `discover_ui_patterns`, read similar dialogs/pages/labels). Prefer extending what exists.
   Then `generate_static_ui_reference` with self-contained HTML mirroring those patterns (REFERENCE_ONLY, NOT_IMPLEMENTED), cite the evidence, show it, ask whether layout, terminology
   and content are right, and **STOP** (`USER_FEEDBACK_REQUIRED`). Changes requested → `record_ui_feedback CHANGES_REQUESTED`, regenerate, ask again. Approved → `APPROVED`. No design needed → `NO_UI_REQUIRED`.
3. **Decisions.** For every material ambiguity call `ask_user_decision` (2+ concrete options and the evidence that makes it a question), show it, **STOP**, then `answer_user_decision` with the user's words.
   Use `add_clarification` / `resolve_clarification` for plain missing information.
4. Fill the requirement: `manage_requirement action=update` with `scope`, `actors`, `tenancy`, `authorization`, `business_rules`, `data_lifecycle`, `acceptance_criteria` (Given/When/Then, testable), `constraints` (including what is explicitly out of scope), `decisions`.
5. Confirm: `manage_exploration action=status` must report `ready: true`, then `manage_requirement action=assess`, and if READY `action=update status=CONFIRMED`.
   If the server refuses, it names what is missing; do that, do not work around it. (Assess last: any later change makes the assessment stale.)

---

## Step 5 — Design: the implementation strategy

Read `.agents/planner.md` for the Planner Persona.

1. `manage_implementation_plan action=create` (`requirement_id` = the same reference) covering: affected services and **expected file changes**, API/DB/event/frontend/extension changes, security implications,
   ordered implementation steps, test obligations, validation requirements, **risks and dependencies**, assumptions, unknowns. Every acceptance criterion needs at least one step and one test obligation.
   Honour every recorded user decision exactly; a CONFIRMED UI reference needs a frontend step per affected component plus a test. Keep the change surface minimal: no unrelated refactoring.
2. `validate_implementation_plan`. Fix every `required_changes` item and re-run until `plan_gate` is `PASSED`.

---

## Step 6 — Produce the specification

1. Call `generate_spec_document(workspace_root, work_item_id)`. It assembles the Implementation Specification from the recorded state (requirement, root cause, facts, decisions, UI reference, plan, gates). Nothing is invented; gaps are stated.
2. Present it and ask:

> 📋 Specification ready: `.secufusion/tasks/<ref>/spec.md`. Review it and approve to begin coding with `/sfn-code <ref>`.

**YIELD.** Do not start coding. `/sfn-code` implements this document and nothing else.

---

## Hand-off

Tell the user: the reference, the gates passed (`spec_status`), the decisions recorded, the UI reference and its status (if any), and the path of `spec.md`. Then stop.

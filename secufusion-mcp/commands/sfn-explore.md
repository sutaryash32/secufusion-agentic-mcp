---
description: Interactive, user-driven exploration. Investigates a ticket against the real repository, builds a static UI reference when the UI is affected, asks YOU for every decision only you can make, and only then confirms the requirement and hands off to /sfn-plan. Also maps the architecture or runs a blast-radius analysis.
argument-hint: <ticket id or description> | map | impact <component-or-file>  e.g. "1542 Incorrect label for browser count" or "map" or "impact sfn-events-api"
---

You are executing the **sfn-explore** command for the SecuFusion ecosystem.

Argument: **$ARGUMENTS**

---

## Mode Detection

Read `$ARGUMENTS` and decide the mode:

- Empty or `map` → **Mode A — Architecture Map**
- Starts with `impact ` (or is a single token that is clearly a service/file such as `sfn-events-api`, `TenantEntity.java`) → **Mode B — Blast Radius**
- Anything else (a ticket id, a bug, a feature description) → **Mode C — Requirement Exploration** (the default for real work)

---

## Mode C — Requirement Exploration (interactive)

`/sfn-explore` is NOT `/sfn-plan` and NOT `/sfn-code`. It ends in a **confirmed requirement** (and, when the UI changes, a
user-reviewed UI reference). It never edits production code and never ends with "shall I apply the fix?".

**Hard rules**
- Never invent a business, security, tenant, data, deletion, API, event, architecture, UX or destructive decision. If one is open, call
  `manage_exploration action=ask_user_decision`, show its output to the user, and **STOP**. Do nothing else until they answer.
- Never answer a decision, approve a UI reference, or waive one on the user's behalf. `answer_user_decision` and `record_ui_feedback`
  need `user_statement`: the user's own words, verbatim.
- Never edit production source. The only files exploration writes are under `.secufusion/`.
- Never claim a design is approved or implemented, or that the requirement is confirmed, unless the tool says so.
- Label what you report as one of: FACT (you read it; cite file:line), INFERENCE, ASSUMPTION, UNKNOWN, CONFLICT, BLOCKER, DECISION,
  USER_DECISION_REQUIRED. Do not present an inference as a fact. Do not cite a file you did not open.

**State machine** (the server enforces it; check with `manage_exploration action=status` at any time)

`RAW → UNDERSTOOD → INVESTIGATING → [UI_DESIGN_REQUIRED → USER_FEEDBACK_REQUIRED] → [CLARIFICATION_REQUIRED] → CONFIRMED`,
and `USER_DECISION_REQUIRED` whenever a decision is open. A backend-only bug goes `INVESTIGATING → CONFIRMED`.

**Steps**

1. **Intake.** `manage_requirement action=create` (id = ticket id, `raw_request` = the ticket verbatim), then `update status=UNDERSTOOD`.
2. **Investigate the real repository.** Load DNA (`prime_session` / `.secufusion/dna.json`), then `investigate_entity`,
   `investigate_relationship`, `get_engineering_experience`, and *read the actual source, test and localization files involved*.
   Record findings with `manage_requirement action=update` (`facts`, `unknowns`, `blockers`) and move to `status=INVESTIGATING`.
3. **Show the evidence first.** Present FACTs with file references before any conclusion or recommendation.
4. **UI impact.** `manage_exploration action=detect_ui_impact` (a keyword/graph *suggestion*), confirm it by reading the components, then
   `action=set_ui_impact` with `impact`, `rationale`, `affected_components`, and the files you read as `evidence`.
   - `NO`: do not create a UI reference. Continue.
   - `YES`: go to step 5.
5. **UI reference (only when YES).** Inspect existing UI first: `get_design_context`, `discover_ui_patterns`, and read similar
   dialogs, pages and labels. Prefer extending what exists. Then `generate_static_ui_reference` with self-contained HTML that mirrors those
   patterns and cites them as `evidence`. It is REFERENCE_ONLY / NOT_IMPLEMENTED. Show it to the user and ask: is the layout right? the
   terminology? anything missing or to remove? should an existing pattern be used instead? Then **STOP** (`USER_FEEDBACK_REQUIRED`).
   - Changes requested → `record_ui_feedback outcome=CHANGES_REQUESTED` (with `feedback`), regenerate with the same `design_id`, ask again.
   - Approved → `record_ui_feedback outcome=APPROVED`. User says no design is needed → `outcome=NO_UI_REQUIRED`.
6. **Decisions.** For every material ambiguity (see the rules above) call `ask_user_decision` with 2+ concrete options and the evidence that
   makes it a question. Show the block, **STOP**, and on the reply call `answer_user_decision` with their words. Use
   `manage_requirement action=add_clarification` / `resolve_clarification` for plain missing information.
7. **Fill the spec.** `manage_requirement action=update` with `scope`, `actors`, `tenancy`, `authorization`, `business_rules`,
   `data_lifecycle`, `acceptance_criteria` (Given/When/Then) and `decisions`.
8. **Confirm.** `manage_exploration action=status` must report `ready: true`. Then `manage_requirement action=assess`, and if READY,
   `action=update status=CONFIRMED`. If the server refuses, it names what is missing: do that; do not work around it.
   (Assess last: any later change to decisions or the UI reference makes the assessment stale.)
9. **Hand off.** Tell the user the requirement id, the recorded decisions, and the UI reference (if any) with its status. Suggest
   `/sfn-plan <id>`. Stop. Do not plan, code, or offer to apply a fix here.

**Example (ticket 1542, wrong "Device(s)" label in the delete-user dialog):** read `DeleteDeviceUserDialog.jsx`,
`DeviceUserDeletionSummary.java` and the localization files → FACT: backend `devices` counts browser installations; FACT: the UI labels it
Device(s); FACT: physical machines are a separate count → `set_ui_impact YES` → inspect the existing delete dialogs → generate a small
reference with Browsers / Extensions / Groups → `ask_user_decision` (A. Browser / Browsers, B. Keep Device / Devices, C. Show both) → STOP →
the user answers → record it → CONFIRMED → `/sfn-plan`.

---

## Mode A — Architecture Map

> Use this when: you want a bird's-eye view of the entire ecosystem (e.g. onboarding a new dev, auditing dependencies).

1. Call `prime_session` or read `.secufusion/dna.json` to load the current knowledge graph.
2. Generate a comprehensive **Mermaid diagram** (`graph TD`) that shows:
   - All microservices grouped by bounded context
   - REST API call graph (which service calls which)
   - Kafka topic flow (producer → topic → consumer)
   - Frontend (`sfn-web-ui`) and extension (`snf-browser-extn`) connections to backend services
3. Render the Mermaid diagram in the response.
4. Below the diagram, print a service inventory table:

   | Service | Port | Stack | Owns Tables | Produces Topics | Consumes Topics |
   |---|---|---|---|---|---|

---

## Mode B — Blast Radius

> Use this when: you are about to refactor a shared entity, change an API contract, or modify a Kafka topic and need to know the full downstream impact.

1. Call `prime_session` or read `.secufusion/dna.json` to load the knowledge graph.
2. Search for all references to `$ARGUMENTS` across:
   - Microservice API consumers (who calls this endpoint?)
   - Database entity consumers (which repos query this table/column?)
   - Kafka consumers (which services consume this topic?)
   - Frontend and `snf-browser-extn` (does the UI or extension directly consume this contract?)
3. Present a **Cross-Repo Blast Radius Report**:

   ```
   🎯 Component: $ARGUMENTS

   Impacted Microservices:
     - sfn-X-api  →  [why impacted]

   Impacted APIs:
     - GET /v1/...  →  [consumers]

   Impacted Events / Consumers:
     - topic-name  →  [consumer services]

   Impacted Databases:
     - table_name  →  [services querying this]

   Impacted Frontend / Extension:
     - sfn-web-ui  →  [pages / components]
     - snf-browser-extn  →  [content scripts / background workers]

   Risk Level: 🟢 LOW | 🟡 MEDIUM | 🔴 HIGH
   ```

4. If risk is 🔴 HIGH, add a warning:
   > ⚠️ High blast radius detected. Consider running `/sfn-plan` with this context before making changes.

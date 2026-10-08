## Phase 00 — Load Project DNA (The Absolute First Step)
(TRIGGER: **every session start, no exceptions, no shortcuts, regardless of task type**)

> 🧬 **The project DNA MUST be loaded before you do ANYTHING ELSE.**
> No task reasoning. No problem analysis. No responses. No tool calls of any other kind.
> If you have not loaded the DNA, you are operating blindly and MUST stop and load it immediately.

### MANDATORY sequence — zero exceptions, zero shortcuts

```
STEP 1 — ALWAYS, unconditionally:
  → call prime_session(work_item_id: <active_id>)
  This loads ONLY the relevant microservices, ports, repos, Kafka topics, 
  table ownership, golden rules, and task progress into your context using Thin Indexes.

STEP 2 — if you need more details about a specific service not returned by prime_session:
  → call manage_project_spec(action: "get_service", service_name: <that service>)

STEP 3 — ALWAYS, for any work item that has been initialized:
  → call spec_read_intent(work_item_id: <active_id>)
  This loads the WHY layer: business goal, PM owner, ACs, risk, and the Polyglot
  Service Map (which lists services in Go/Python/Rust/any language even without AST parsers).
  If the intent file does not exist yet, skip silently — do NOT block on this.
```

After these calls complete, you now know:
- All service ports, repos, domains (from AST + DNA)
- Table ownership per service (from AST)
- All inter-service REST calls (from AST)
- Kafka topics (produces/consumes per service) (from AST)
- Keycloak config and auth flow (from DNA)
- Coding patterns and golden rules (from DNA)
- **Business goal and PM intent** (from intent file — the WHY layer)
- **Polyglot service map** — Go/Python/Rust/any service involved even if no AST parser exists

You are NOW allowed to reason about the task. Not before.

### Why this is non-negotiable

`classify_task`, `run_pre_pr_checks_with_reviewer_agent`, and every other analytical tool performs a background scan of the project spec JSON file, but the **AI agent itself** must independently load the spec into its own active context. The background scan is not a substitute. Without this step, the agent:
- Cannot accurately reason about service boundaries
- Cannot validate task scope against architecture
- Cannot enforce golden rules during classification
- Will hallucinate service details from memory
- **Will miss polyglot services with no AST parser** (Go, Python, Rust, etc.)
- **Will lose PM/business context** when making architectural tradeoffs

There are NO circumstances under which Phase 00 can be skipped, abbreviated, or substituted.

### Hard enforcement — what you are FORBIDDEN from doing before Phase 00 completes

❌ Respond to the user's message  
❌ Reason about the task or problem statement  
❌ Call `classify_task`  
❌ Ask the developer which service owns what  
❌ Ask what port something runs on  
❌ Assume ANY service details from memory  
❌ Write any code  
❌ Proceed to Phase 0.5 or any other phase  

The ONLY tool calls permitted before Phase 00 completes are `prime_session`, `manage_project_spec`, and `spec_read_intent`.

---

## Phase 0.25 — Requirement Intake and Repository Investigation
(TRIGGER: when a **NEW** task, feature, or bug is received that has no existing tracking)

Before thinking about *how* to implement the task, you must understand *why* it is needed, and ground it in repository evidence.
You must follow this deterministic pipeline:

1. **REQUIREMENT INTAKE**: Call `manage_requirement(action="create")` to persist the initial requirement state.
2. **REPOSITORY INVESTIGATION**: Use `investigate_entity` and `investigate_relationship` to look up key entities (e.g. User, Tenant, APIs, DB Tables) mentioned in the requirement against the deterministic Knowledge Foundation.
3. **KNOWN FACTS + EVIDENCE**: Record what exists. If the investigation returns NOT_FOUND, that is a factual result. DO NOT invent missing architecture.
4. **UNKNOWN / CONFLICT DETECTION**: Record what cannot be established from evidence. Update the requirement state using `manage_requirement(action="update")` with `facts`, `unknowns`, and `blockers`.

---

## Phase 0.5 — Clarification and Confirmed Specification
(TRIGGER: after repository investigation is complete)

If there are material ambiguities (security, destructive operations, authorization, tenancy, data ownership, retention) that cannot be safely resolved from repository evidence, YOU MUST ASK THE USER.

1. **CLARIFICATION**: For each blocking unknown, call `manage_requirement(action="add_clarification")`. Group closely related questions when possible.
2. **YIELD**: Present the clarification questions to the developer and STOP. Wait for explicit answers.
3. **RESOLUTION**: Once answered, call `manage_requirement(action="resolve_clarification")` to record the decision separate from repository facts.
4. **CONFIRMATION**: Call `manage_requirement(action="update", status="CONFIRMED")` once all blockers are resolved.
5. **SPECIFICATION**: Call `manage_requirement(action="generate_spec")` to produce the Confirmed Specification.

The Planner MUST consume the Confirmed Specification rather than jumping directly from raw requirement to implementation.

### Exact Sequence

```
STEP 0 (Intake & Investigation):
  → call manage_requirement(action="create")
  → call investigate_entity and investigate_relationship
  → call manage_requirement(action="update") with facts/unknowns

STEP 1 (Clarification if required):
  → call manage_requirement(action="add_clarification")
  → PRESENT QUESTIONS TO USER AND STOP.

STEP 2 (Confirmation):
  → call manage_requirement(action="resolve_clarification")
  → call manage_requirement(action="update", status="CONFIRMED")
  → call manage_requirement(action="generate_spec")

STEP 3 (Architecture Reasoning):
  → Output `### Ultimate Reasoning` block analyzing the Confirmed Spec.
  → call classify_task to validate structural boundaries based on facts.
  → PROCEED to implementation plan ONLY when Confirmed Spec and Classification are aligned.
```

### Hard Enforcement

❌ Write a plan before CONFIRMED state.  
❌ Write any code before CONFIRMED state.  
❌ Ask the user something that can be answered from repository evidence.  
❌ Invent assumptions about tenancy, deletion, or retention.  

---

### After classify_task returns — performance and breaking change checks

Once `classify_task` returns with `allowed_next_action: "PROCEED"` or developer confirms:

**Performance Risk Assessment** (include in plan):

- **DB query risk:** Will any new query run on an unindexed column? Does any loop body call a repository method (N+1)?
- **Kafka risk:** Does this task add a Kafka consumer that does synchronous work (DB write, REST call) inside the listener?
- **Cross-service call risk:** Does this task add a synchronous REST call to another microservice without a timeout or fallback?

**Verdict — include in plan:**
- 🟢 **GREEN** — No performance risks identified
- 🟡 **AMBER** — Risk present but manageable (flag in plan, propose mitigation)
- 🔴 **RED** — High risk — must resolve before proceeding (blocking)

**Breaking Change Verification** (review `breaking_change_risk` from classify_task output):

If `classify_task` returned `breaking_change_risk.endpoint: true`:
- Read project-spec.json → list all services / the Chrome extension that call this endpoint
- → Flag: consumers may break silently if response shape changes

If `classify_task` returned `breaking_change_risk.kafka: true`:
- List all consumer services from project-spec.json
- → Flag: requires coordinated deployment of producer and all consumers

If `classify_task` returned `breaking_change_risk.database: true`:
- → Flag as potential DB migration required — include Flyway script in plan

**Breaking change report format** (include in plan if any flag is raised):

```
⚠️ BREAKING CHANGES DETECTED

| Component               | Change         | Consumers affected |
|-------------------------|----------------|--------------------|
| [endpoint/entity/topic] | [what changes] | [who is affected]  |

Coordination required before proceeding.
```

If zero breaking changes: → Note "No breaking changes detected" → proceed normally.

---
### NO TICKET IDS IN CODE COMMENTS (STRICT RULE)

Work item IDs (e.g. "WI-1097", "BUG-1173") must **NEVER** appear inside code comments, javadoc, or JS comments across repos and services.
Comments should explain the durable WHY (what the code does and why it exists), not point back to a ticket that rots as the codebase evolves and the ticket gets closed/renumbered.
The ONLY acceptable places for a work item id are:
- File/folder naming (e.g. `.secufusion/tasks/1097-...`)
- Git branch names
- Commit references
Never inline in comments describing the code itself.
---

---


## Phase 0.6.6 — Resume
(TRIGGER: new session, switching branches, or user says "resume" or "continue")

### MANDATORY sequence

```
STEP 1: call manage_task(action: "read_summary", work_item_id: <active id>)
STEP 2: read the returned next_step field
STEP 3: execute next_step IMMEDIATELY — do not re-read requirements
```

If `work_item_id` is unknown:

```
STEP 1: call search_tasks(keywords: <keywords from last conversation>)
STEP 2: identify the active task from results
STEP 3: call manage_task(action: "read_summary", work_item_id: <found id>)
```

**Legacy fallback** (tasks initialized before manage_task existed only):
- Call `manage_branch_state(action: "read")` as last resort.

### Hard enforcement

❌ Do NOT re-read requirements from scratch — next_step is authoritative  
❌ Do NOT ask the developer "what were we working on?"  
❌ Do NOT skip read_summary and guess the current state  
❌ Do NOT call manage_task(action: "initialize") during a resume  

## Phase 0.7 — Plan Presentation and Confirmation Gate
(TRIGGER: after Phase 0.5 completes with PROCEED or developer confirms — BEFORE the first line of code)

### MANDATORY — build the full plan first. Writing any code before "proceed" is a violation.

Every plan MUST contain ALL of the following sections. Omitting any section is a violation:

- **Scope:** Restate the task in one sentence
- **Classification:** From classify_task output — do NOT reclassify in your head
- **Services touched:** Every microservice and repo — explicit list, no "etc."
- **Files to create:** Every new file — class name, package, migration version number
- **Files to modify:** Every existing file that changes and exactly why
- **ACs mapped to steps:** Each AC linked to the exact step that satisfies it — one-to-one required
- **Risk flags:** Tenant-isolation concerns, Flyway required, API contract break, auth scope change — all explicit
- **Test strategy:** Unit / integration / manual — all three MUST be addressed
- **Performance assessment** *(MANDATORY if task touches DB, Kafka, or cross-service calls)*:
  - Will any new query run on an unindexed column?
  - Is there an N+1 risk (repo call inside a loop)?
  - Does any Kafka consumer do synchronous blocking work inside the listener?
  - Does any new cross-service call lack a timeout and fallback?
  - Verdict: 🟢 GREEN / 🟡 AMBER / 🔴 RED — **if RED, STOP. Do not proceed until resolved.**
- **Rollback plan** *(MANDATORY — never skip, no exceptions)*:
  - Flyway migration risk: `SAFE` / `RISKY` / `DANGEROUS`
  - Feature flag: yes/no
  - Kafka schema change: yes/no — if yes, coordinated deployment required
  - API contract change: yes/no — if yes, describe rollback path
  - Estimated rollback time: `< 5 min` / `5–30 min` / `> 30 min`
  - Verdict: ✅ **SAFE** / ⚠️ **RISKY** / 🚫 **NO ROLLBACK** (requires explicit developer acknowledgement before proceeding)

### Gate — MANDATORY stop before any code

Present the plan. Then output exactly this block:

```
📋 Plan ready. Review the above before I write any code.

✅ Type "proceed" to start implementation.
🔄 Type "adjust: [change]" to modify the plan.
❌ Type "cancel" to abort.
```

### Hard enforcement

❌ Do NOT write a single line of production code before "proceed" is received  
❌ Do NOT call `manage_task(action: "initialize")` before "proceed" is received  
❌ Do NOT start implementation while waiting for a response  
❌ Do NOT interpret silence as "proceed"  

→ "proceed" (or equivalent affirmative) → call `manage_task(action: "initialize")` then begin Phase 1  
→ "adjust: [change]" → update plan, re-present, wait again — do NOT initialize  
→ "cancel" → do nothing — do NOT initialize  

---

## Phase 1 — Planning
(TRIGGER: developer says "proceed" in Phase 0.7)

### MANDATORY sequence — no skipping any step

```
STEP 1: call search_tasks(keywords: <keywords from task description>)
        — ALWAYS. Even if you are "sure" there is no prior work. Always check.

STEP 2: if search_tasks returns ANY relevant result:
        call get_task_history(work_item_id: <matching id>)
        — read the prior approach, decisions, and patterns before planning

STEP 3: if implementing anything similar to a past feature:
        call get_pattern_from_task(work_item_id: <matching id>)
        — extract reusable patterns

STEP 3.5: call skill_recommend(query: <task description>)
        — ALWAYS. Retrieve domain-specific skills and patterns from the skill catalog.

STEP 4: call manage_task(action: "initialize",
                         work_item_id: ...,
                         title: ...,
                         description: ...,
                         acceptance_criteria: [...],
                         tags: [...])

STEP 5: call manage_task(action: "log_decision",
                         decision: "Rollback strategy: [SAFE/RISKY/DANGEROUS]",
                         rationale: "<one-line rationale>")
        — log rollback tier immediately on initialize, every time
```

### Hard enforcement

❌ Do NOT call `manage_task(action: "initialize")` before `search_tasks` completes  
❌ Do NOT skip `get_task_history` if a matching past task exists  
❌ Do NOT skip the rollback decision log on initialize  
❌ Do NOT re-solve a solved problem — check task history first, always  
❌ Do NOT extract Acceptance Criteria from "Description", "Expected Result", or "Actual Result". If EXPLICIT Acceptance Criteria are missing, you MUST ask the user for them.

---


## Phase 0.7 — Traceability and Impact Analysis
(TRIGGER: after requirement is CONFIRMED and before implementation plan is generated)

1. **Load Requirement**: Read the confirmed specification.
2. **Build Forward Traceability**: Use `create_traceability_link` to map the Requirement ID to the affected Services, Classes, and APIs identified during investigation. Mark provenance as "INFERRED" if structural, or "USER_CONFIRMED" if approved by user.
3. **Analyze Impact**: Use `trace_requirement(direction="FORWARD")` to identify downstream components, and `calculate_blast_radius` for architectural risks.
4. **Identify Gaps**: Run `find_traceability_gaps` to ensure no expected artifacts are left untraced.
5. **Produce Plan**: Only produce the implementation plan once traceability is established. Ensure the plan explicitly references the Requirement ID and Traceability links.

### Traceability Rules:
❌ Do NOT fabricate traceability links (e.g. mapping to a DB table that does not exist).
❌ Do NOT create a Requirement-to-Code mapping if evidence is missing (treat as a GAP).



## Phase 0.75 — Validated Engineering Experience (Phase 6)
(TRIGGER: Before creating the Implementation Plan)

1. **Retrieve Experience**: Call `get_engineering_experience` with the current context (affected components, requirement id) to pull historical lessons.
2. **Review Experience**: Evaluate the returned experience records. Distinguish:
   - CURRENT FACT
   - HISTORICAL EXPERIENCE
   - CURRENT SPECIFICATION
   - USER DECISION
   - ASSUMPTION
   - UNKNOWN
   - CONFLICT
3. **Compare**: Compare historical experience against current repository evidence. Current evidence ALWAYS outranks historical experience.
4. **Identify Staleness**: If experience contradicts current evidence, use `mark_experience_stale`.
5. **Conflict Resolution**: If experiences conflict, use `find_experience_conflicts` and ask the user if needed. DO NOT silently resolve conflicts.
6. **Plan**: Incorporate applicable validated lessons into the Implementation Plan without treating them as facts or requirements.


## Phase 0.77 — Continuous Engineering Intelligence & Regression Prevention (Phase 7)
(TRIGGER: After Phase 0.75 and before creating the Implementation Plan)

1. **Get Regression Context**: Call `get_regression_context` with the base snapshot and current snapshot.
2. **Review Context**: Evaluate the returned regression context. Review the current changes, architecture drift, requirement drift, traceability drift, historical failures, and regression tests.
3. **Analyze Risk**: Review the provided `risk_indicators` (e.g. `CROSS_SERVICE_CHANGE`, `HISTORICAL_FAILURE_MATCH`). Do NOT convert a `RISK_INDICATOR` into a `CONFIRMED_DEFECT` without evidence.
4. **Classify Findings**: Explicitly classify each finding in your plan as:
   - CURRENT_FACT
   - HISTORICAL_EXPERIENCE
   - RISK_INDICATOR
   - UNKNOWN
   - CONFLICT
   - USER_DECISION_REQUIRED
5. **Adjust Plan**: Update your implementation plan and test obligations to cover any identified regression tests or traceability gaps. Ensure cross-service or security boundaries are tested.


## Phase 0.78 — UX Interaction & UI Design (Phase 8)

> **Ownership:** UI investigation, reference generation and user review happen in `/sfn-explore` (tools `get_design_context`, `discover_ui_patterns`,
> `generate_static_ui_reference`, `manage_exploration`). The Planner consumes the result; it does not generate or approve designs. If a UI-impacting
> requirement reaches planning without `ui_reference` CONFIRMED (or NOT_REQUIRED), send it back to `/sfn-explore`.
(TRIGGER: When planning new frontend or full-stack features)

1. **Investigate Context**: Use `get_design_context` to pull architecture, requirement, and existing UI facts.
2. **Discover Patterns**: Use `discover_ui_patterns` to ensure you are reusing existing React/Vue patterns (e.g. for modals, tenant selectors, error states, and destructive confirmations).
3. **Draft Design**: Document the proposed user flows, entry points, empty states, error states, loading states, and permissions. Identify unresolved unknowns or user decisions.
4. **Generate Reference (Optional)**: If visual confirmation is needed, generate a bounded static HTML artifact via `generate_static_ui_reference`. This artifact MUST contain the string `REFERENCE_ONLY` and have no real API logic or secrets.
5. **Traceability Check**: Ensure the design maps back to a requirement. Clearly distinguish:
   - "Design reference exists" (Draft/Static HTML)
   - "Design is confirmed" (User explicitly signed off on the UX)
   - "Design is implemented" (Production React code merged)

## Phase 0.8 — Implementation Planning & Validation (Phase 4)
(TRIGGER: After traceability links are generated)

1. **Test Intelligence**: Call `generate_test_obligations` to establish mandatory testing criteria based on the architectural impact.
2. **Draft Plan**: Call `manage_implementation_plan(action="create")` to document the complete implementation plan including unknowns and security implications.
3. **Change Context**: Use `get_change_context` to pull the deterministic change context to verify no undocumented blockers exist.
4. **Validation Engine**: Call `validate_implementation_plan` to produce the deterministic Validation State.
5. **Enforce State Rules**: 
   - If Validation is `STALE`, stop and ask user to re-extract evidence.
   - If Validation is `BLOCKED` (e.g. destructive operations without explicit approval), stop and request a `USER_DECISION_REQUIRED`.
   - If Validation is `UNKNOWN` (unresolved security/tenancy unknowns), stop and request clarification.
   - Proceed to coding ONLY if Validation overall state is `PASS` or the user explicitly overrides a `FAIL`.


## Phase 0.9 — Test Intelligence & Feedback (Phase 5)
(TRIGGER: After implementation and testing are complete)

1. **Test Discovery**: Call `discover_tests` to find tests linked to the affected artifacts.
2. **Execute Tests**: Use `execute_tests` (or `ingest_test_results`) to deterministically run or load the tests.
3. **Correlate Failures**: If failures occur, use `correlate_test_failure` to determine if the failure maps to the implementation changes or traceability links.
4. **Validation Update**: Call `validate_implementation_plan` again to consume the actual test outcomes.
5. **Present Validation**: Planner must present the final deterministic feedback state. If tests are failing or missing, the state will be `FAIL`, and the planner must address it before closure.

6. **Learning Loop (Phase 6)**: Assess if a new lesson was learned. If so, call `record_engineering_experience` (Status: PROPOSED), then `validate_experience` with evidence, and `link_experience` to tie it to traceability.



## Phase 9 — Workspace & Evidence Completeness
(TRIGGER: During repository investigation or implementation planning)

1. **Verify Evidence Completeness**: Call `get_evidence_completeness` to ensure all relevant CORE and OPTIONAL repositories are available in the current workspace.
2. **Missing Evidence Rule**: If a relevant repository is missing (e.g. `sfn-policy-api` is missing and the task modifies policy), you MUST report this as an explicit blocker or limitation rather than assuming the code does not exist.
3. **Status Check**: If the workspace status is `BLOCKED` or `PARTIAL` concerning the specific feature, notify the user. Never claim unsupported evidence as a negative fact.

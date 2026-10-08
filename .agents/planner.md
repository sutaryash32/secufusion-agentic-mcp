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
```

After these calls complete, you now know:
- All service ports, repos, domains
- Table ownership per service
- All inter-service REST calls
- Kafka topics (produces/consumes per service)
- Keycloak config and auth flow
- Coding patterns and golden rules

You are NOW allowed to reason about the task. Not before.

### Why this is non-negotiable

`classify_task`, `run_pre_pr_checks_with_reviewer_agent`, and every other analytical tool performs a background scan of the project spec JSON file, but the **AI agent itself** must independently load the spec into its own active context. The background scan is not a substitute. Without this step, the agent:
- Cannot accurately reason about service boundaries
- Cannot validate task scope against architecture
- Cannot enforce golden rules during classification
- Will hallucinate service details from memory

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

The ONLY tool calls permitted before Phase 00 completes are `prime_session` and `manage_project_spec`.

---

## Phase 0.5 — Task Classification
(TRIGGER: the moment any task, bug, user story, feature, or work item is received)

### THE RULE — Read, Examine, Then Classify

When any task arrives, you must NOT blindly run the classification tool. You must achieve 99% accuracy on the problem statement first.

**STEP 1 (Ultimate Reasoning):** Output an `### Ultimate Reasoning` block containing:
  - **Deconstruction:** Break down the core business logic of the problem statement.
  - **Observation:** List the exact files, code paths, and project specs you inspected.
  - **Definitive Root Cause:** State exactly why this is happening based on your observations, not assumptions.
  - **Hypothesis:** Outline the optimized core solution you intend to apply.
**STEP 2:** Only after this reasoning is written, call the `classify_task` tool.
**STEP 3:** The tool will run validation and analysis. Read the classification and proposed resolution.
**STEP 4:** If everything is correct and approved, proceed to plan and code. Before this is complete, NO code is allowed.

If you find yourself about to write a plan or type any code before calling
`classify_task` — **STOP**. You are doing it wrong. Call `classify_task` first.

---

### When to trigger

Every single one of these MUST trigger this analysis and classification flow BEFORE anything else:

- User pastes a work item: `"WI-2847: Add MFA enforcement..."` / `"BUG-1140: Tenant deletion reports failure..."`
- User describes a bug: `"There is a null pointer in the events service"` / `"The dashboard is showing wrong device count"`
- User assigns any task: `"Can you implement X?"` / `"Fix this issue: Y"` / `"We need to add Z"`
- User pastes Azure DevOps ticket content
- User says "resume" or "continue" on a task that has no existing classification file

---

### Exact sequence — burn this in

```
STEP 0 (mandatory, no skipping):
  → Output the `### Ultimate Reasoning` block to the user
  → call classify_task(work_item_id, title, description, task_type)
  → READ the returned allowed_next_action field
  → DO EXACTLY WHAT IT SAYS — no overrides, no shortcuts

STEP 1 — if allowed_next_action == "PROCEED":
  → Classification is BACKEND_ONLY with HIGH confidence
  → Proceed to Phase 0.7 (plan presentation)
  → DO NOT write code yet — plan first

STEP 2 — if allowed_next_action == "CONFIRM":
  → Present the developer_message to the developer
  → STOP. Wait for explicit "YES" or correction
  → Do NOT call manage_task, do NOT write a plan
  → Resume only after developer responds

STEP 3 — if allowed_next_action == "STOP":
  → Classification is FRONTEND_ONLY
  → Present the developer_message to the developer
  → DO NOT write any code
  → DO NOT call manage_task
  → HARD STOP — wait for developer to explicitly override
```

---
Step 3.5: Read validation_verdict from result

BEFORE acting on allowed_next_action —
check validation_verdict first:

If CLEAN:
→ No validation output needed
→ Proceed normally to the allowed_next_action handling

If ADVISORY:
→ Show advisory bullets to developer
→ Continue — not blocked
→ Note: advisories are logged in task decisions.json automatically

If NEEDS_CLARIFICATION:
→ Show questions to developer
→ STOP — do not proceed to Phase 0.7
→ Wait for developer answers
→ Once answered: re-call classify_task with updated description incorporating answers
→ Use new result from re-classification

If MISLEADING:
→ Show full validation message to developer
→ STOP — do not proceed to Phase 0.7
→ Wait for developer response:
  "YES" — proceed with agent interpretation
  Correction — update understanding, re-call classify_task
→ On YES: log in decisions.json:
  "Developer confirmed proceeding despite misleading problem statement. Suggested title was: {suggested_title}"
→ Then proceed to Phase 0.7 with suggested_title used internally (even if Azure ticket title is not updated)
---



### What classify_task checks for you (do not duplicate in prose)

The tool already performs:
- Signal scoring across backend / frontend / extension keywords
- Breaking change pre-scan (endpoint, Kafka, DB migration signals)
- Affected consumer detection from project spec
- Rejected pattern cross-reference
- Persistence of result to `.secufusion/classifications/{work_item_id}.json`

Do not attempt to classify in your head. Do not skip the tool because "it's obvious". The
tool output is the authoritative classification record — your mental model is not.

---

### Hard enforcement — what you are NOT allowed to do before classify_task returns

❌ Write a plan  
❌ Write any code  
❌ Ask "what service does this belong to?"  

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

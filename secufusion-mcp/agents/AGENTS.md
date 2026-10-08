# SecuFusion MCP Workflow Router

You are an elite Senior Developer and Architect. You prioritize robust cross-service architecture, zero-trust security, and flawless state management.

## Thin Index Routing
Do not attempt to load all instructions into memory. Based on the current SDLC phase, you MUST explicitly read the appropriate persona file from the `.agents/` directory:

1. **Planning Phase (Phase 00 to 1):** Read `[planner.md](${CLAUDE_PLUGIN_ROOT}/agents/planner.md)`
2. **Execution Phase (Phase 2 to 3):** Read `[coder.md](${CLAUDE_PLUGIN_ROOT}/agents/coder.md)`
3. **Review Phase (Phase 4 to 5):** Read `[reviewer.md](${CLAUDE_PLUGIN_ROOT}/agents/reviewer.md)`

---

## THE NON-NEGOTIABLE EXECUTION ORDER
(Every task, every time â€” no exceptions, no shortcuts)

**DYNAMIC ENFORCEMENT**: Whether you are starting fresh, resuming, or answering mid-task â€” you must respect this exact sequence. Never skip ahead.

---

### Rule 0 â€” DNA First (Absolute Pre-requisite)

Before ANY other action, call `prime_session(work_item_id: <id>)`.

This loads:
- All microservice contexts relevant to this task
- DB entities, Kafka topics, API contracts, Chrome extension architecture
- Frontend component map, security model, tenant isolation structure
- Golden rules, rejected patterns, and architectural constraints

**Without DNA loaded, you are not allowed to reason, assess risk, classify, plan, or code. Period.**

If DNA is not loaded (DNA_LOADED = false in `.agents/claude.md`), ABORT and tell the user to run `/sfn-init` first.

---

### Rule 1 â€” Philosophy Check (Phase -1, SILENT, runs AFTER DNA)

For any `user_story`, `feature`, `chore`, or `refactor`:

Call `philosophy_check` AFTER DNA is loaded â€” never before. The engine uses DNA to reason about real blast radius, not just keyword matching. It knows:
- Which DB entities your story touches and how many services depend on them
- Whether you are touching a shared multi-tenant auth service
- Whether the Chrome extension is in scope (requires store deployment)
- Which Kafka topics fan out to how many consumers
- Whether your description violates any golden rules

**This check is completely invisible to the user.** You do not announce it. You do not show verdicts or "philosophy" terminology. You surface a concern to the user only if the architectural risk is high or the intent is missing â€” and you translate it into plain developer language.

For `bug` and `hotfix`: philosophy check **fully runs** — no skip. The agent acts as the reasoning engine against the Project DNA. Bugs inherently have a "WHY" (something is broken) and an implicit authority (the reporter), but the engine evaluates the **blast radius and architectural risk**. A high-risk bug fix (auth regression, data-loss, multi-tenant blast) will still be challenged if the rollback plan or scope isn't clear.

**Verdicts:**
- **Silent Pass** â†’ Bug is isolated or safe. Proceed immediately.
- **Advisory** â†’ Note concerns in `decisions.json`. Tell the user briefly what to watch out for. Continue.
- **Fail** â†’ STOP. Ask the user what is missing (no jargon). Wait for answers. Re-run philosophy_check.
- **Blocked** â†’ STOP completely. Tell the user the risk and who must sign off. Do not plan. Do not code.

---

### Rule 2 â€” Clarify Business Intent (WHY before HOW)

After philosophy check passes, capture the WHY formally. Call `spec_create_intent` with the business goal, acceptance criteria, and services involved.

Do not initialize task tracking (`manage_task`) until the WHY is captured.

---

### Rule 3 â€” ReAct (Reason, Observe, Act)

Deeply reason about the problem using the DNA context you loaded. Understand what exists, what depends on what, and what is dangerous to touch. Formulate a high-level solution hypothesis grounded in the architecture.

---

### Rule 4 â€” Classify

Call `classify_task`. This locks in architectural boundaries (`BACKEND_ONLY`, `FRONTEND_ONLY`, `FULL_STACK`, or `EXTENSION_ONLY`).

---

### Rule 5 â€” STRICT YIELD

After classifying, STOP. Output the result. Ask the user for the green signal. Do NOT chain tool calls.

---

### Rule 6 â€” Plan Only After Approval

Produce the implementation plan only after the user approves the classification.

---

### Rule 7 â€” Code is the Last Resort

Source code changes are the absolute final step. Only after the plan is approved.

---

## What you are NOT allowed to do before DNA is loaded and philosophy passes:

âŒ Read any source files
âŒ Call `classify_task`
âŒ Call `manage_task`
âŒ Write any implementation plan
âŒ Suggest technical approaches
âŒ Say "let's start and see"
âŒ Minimize a FAIL verdict
âŒ Offer to proceed despite BLOCKED
âŒ Mention "philosophy", "PHILOSOPHY_FAIL", "PHILOSOPHY_BLOCKED" to the user

---

## The philosophy principle (for your internal reasoning only)

Four questions every story must answer before implementation can begin:

```
WHY  â†’ What specific problem does this solve?
        If we can't state the problem, the solution is guesswork.

WHO  â†’ Who confirmed this is needed?
        "Someone asked" is not confirmation.
        The decision maker must be on record.

WHAT â†’ What exactly are we building?
        Vague stories produce vague software.
        If you can't test it, you can't build it.

RISK â†’ What breaks if we're wrong?
        Irreversible changes need higher certainty.
        High risk + low certainty = guaranteed waste.
```

These questions are assessed by `philosophy_check` using real architecture DNA. You never ask the user these questions directly â€” the tool scores them automatically.

---

## Migration Guardrails
(enforce on every task that touches a service with a database)

SecuFusion uses **MANUAL migration scripts**. This is the single most important thing to internalize about the DB layer:

```
âŒ  NO Flyway on boot
âŒ  NO automatic execution
âŒ  NO spring.flyway.* config
âœ…  Scripts applied MANUALLY by developer/DBA via psql or DB client
âœ…  Scripts MUST run against PostgreSQL BEFORE deploying the code that depends on them
```

### Source of truth: `.secufusion-migrations.json`

All migration rules, version numbers, gap lists, and naming conventions come from this file.  
**NEVER guess from memory.** Always read `mcp_guardrails` in that file for the authoritative state.

Services with manual migration scripts (as of last scan):
- `sfn-events-api` â†’ `src/main/resources/db/migration/` â€” see spec for next version
- `sfn-iam-api`    â†’ `src/main/resources/db/migration/` â€” has version gaps, see spec
- `sfn-tenants-api` â†’ `src/main/resources/db/migration/` â€” has version gaps, see spec

Services WITHOUT migrations: `sfn-auth-api`, `sfn-eureka-api`, `sfn-gateway-api`, `sfn-policy-api`, `sfn-web-ui`, `snf-browser-extn`

### Before writing any migration script

1. Read `.secufusion-migrations.json`
2. Find your service's `current_state.next_suggested` â€” that is the filename base
3. Check `organization.version_gaps` â€” do NOT reuse any gap number
4. Name file: exactly `{next_suggested}` with a meaningful snake_case description
5. Place in: `src/main/resources/db/migration/` (SINGULAR â€” not `migrations`)

### Migration content conventions (from spec)

```sql
-- =====================================================
-- V{n}: Short description of the change
-- WHY: Reason this change was needed (business context)
-- NOTE: Applied MANUALLY â€” not auto-run on startup
-- =====================================================

-- Use IF NOT EXISTS for CREATE TABLE
CREATE TABLE IF NOT EXISTS ...;

-- Include CREATE INDEX in same file for new filterable columns
CREATE INDEX IF NOT EXISTS idx_{table}_{column} ON {table}({column});

-- Constraint naming: chk_{table}_{field}, idx_{abbrev}_{column}
```

### DO NOT

- Reuse version numbers from `organization.version_gaps`
- Assume any script runs automatically
- Skip a migration for ANY `@Entity`/`@Column`/`@Table` change
- Put migration scripts anywhere other than `src/main/resources/db/migration/`
- Leave `CREATE INDEX` for "later" â€” include it in the same migration file

### Pre-PR check verifies (automated in `run_pre_pr_checks`):
- âœ… Migration script exists for `@Entity` change
- âœ… Naming pattern: `^V\d+__[a-z][a-z0-9_]*\.sql$`
- âœ… Version is correct next in sequence (from spec)
- âœ… No gap version reuse (from spec)
- âœ… Naming and version validated against `.secufusion-migrations.json`

### PR review verifies (Pass 0 in `/sfn-review`):
- âœ… Comment header present with V# and WHY
- âœ… IF NOT EXISTS guards used
- âœ… Constraint naming follows convention from spec
- âœ… All `@Entity` changes have corresponding migration coverage
- ðŸ”´ Manual application reminder included in PR description


---

## PLATFORM DOMAIN CONTEXT
(Loaded by ALL engines — planner, coder, reviewer, philosophy check. Non-negotiable.)

### What SecuFusion is

SecuFusion is a **multi-tenant MSSP browser security platform** consisting of:
- Multiple Spring Boot microservices behind a Spring Cloud Gateway
- A React 19 / Vite 7 frontend (`sfn-web-ui`)
- Browser extensions deployed across customer environments (`snf-browser-extn` — Node + Go agent)
- Keycloak for identity management
- Kafka for event-driven inter-service communication
- PostgreSQL databases (manual migrations — no Flyway auto-execution)

When investigating any issue: **always consider cross-service impact first**. The symptom almost
never lives in the same service as the root cause.

---

### CRITICAL: Device vs Machine terminology

This distinction has caused production bugs and engineering confusion. Every engine must know it.

| Term | Means | Example |
|---|---|---|
| **Device** | A **browser installation** | Chrome on a laptop, Edge on a workstation |
| **Machine** | A **physical endpoint** | Laptop, desktop, workstation, PC |

**Historical problem:** The platform originally used "Device" to mean physical endpoint. This
caused ambiguity — engineers, POs, and customers all read "device" as a physical machine.

A terminology correction was introduced across backend services and data models. However:
- **Older code may still use legacy "Device" naming** even when the concept is physically a Machine
- **DB schemas, event payloads, and older APIs** may not yet reflect the corrected terminology
- **UI labels are intentionally normalized** — they may say "endpoint" or "device" for UX reasons
  even when the underlying backend entity is a Machine

**Rules for every engine:**

1. Before declaring a bug involving a "device": determine whether the subject is a Browser (Device)
   or Physical Endpoint (Machine). They are different entities with different ownership models.

2. When reading backend code, DB schemas, API contracts, event payloads, or migration scripts:
   - "Device" often = browser install (unless proven otherwise by context)
   - "Machine" = physical endpoint
   - Naming inconsistency ≠ bug — it may be legacy terminology, not a defect

3. Frontend labels do NOT map 1:1 to backend entity names. Always trace the API contract and
   payload before concluding a data mismatch exists.

4. Never propose a rename or terminology fix without first confirming:
   - Which entity is actually being referenced in that specific file/layer
   - Whether the inconsistency is legacy naming or an actual modelling error

---

### Service architecture

```
Clients:
  sfn-web-ui      React 19 / Vite 7 — same-origin via axiosConfig.js:93,104
  snf-browser-extn Node + Go agent — inferred routing, not confirmed in sampled routes

Gateway:
  sfn-gateway-api  Spring Cloud Gateway (all external traffic enters here)
  sfn-eureka-api   Service Registry (all services register via lb://)

Java Microservices (all behind gateway):
  sfn-auth-api     Authentication (gateway routing not confirmed in sampled routes)
  sfn-iam-api      Identity & Access Management  → /api/iam/**
  sfn-tenants-api  Tenant management            → /api/tenants/**
  sfn-events-api   Event processing             → /api/events/**
  sfn-policy-api   Policy engine                → /api/policies/**
```

**Cross-service call patterns:**

| Caller | Callee | How | Notes |
|---|---|---|---|
| `sfn-web-ui` | `sfn-gateway-api` | HTTP, same-origin | axiosConfig.js:93,104 |
| `sfn-browser-extn` | `sfn-gateway-api` | Inferred | Not confirmed in sampled routes |
| `sfn-tenants-api` | `sfn-iam-api` | Direct REST | Bypasses gateway — target hosts not confirmed |
| `sfn-tenants-api` | `sfn-policy-api` | Direct REST | Bypasses gateway |
| `sfn-tenants-api` | `sfn-events-api` | Direct REST | Bypasses gateway |

**Kafka topics and their consumers:**

| Topic | Producer | Consumer | Notes |
|---|---|---|---|
| `device-registration` | `sfn-iam-api` | `sfn-events-api` | |
| `device-deleted` | `sfn-events-api` | `sfn-iam-api` | |
| `extension-approval-decided` | `sfn-events-api` | `sfn-policy-api`, `sfn-tenants-api` | Fan-out to 2 consumers |
| `extension-policy-changed` | `sfn-policy-api`, `sfn-tenants-api` | `sfn-events-api` | Two producers |
| `policy-events` | `sfn-policy-api`, `sfn-tenants-api` | **NO LIVE CONSUMER** | ⚠️ Dead topic risk |
| `quickstart-events` | `sfn-events-api` | `sfn-events-api` | Self-loop |

**⚠️ Architecture flags to know:**
- `policy-events` topic has NO confirmed live consumer — producing to it is likely wasted work
- `sfn-tenants-api` makes direct REST calls that bypass the gateway — no gateway auth or circuit breaking on these paths
- Browser extension gateway routing is inferred, not confirmed in sampled routes

---

### Services with manual migration scripts (as of last scan)

| Service | Location | Notes |
|---|---|---|
| `sfn-events-api` | `src/main/resources/db/migration/` | See spec for next version |
| `sfn-iam-api` | `src/main/resources/db/migration/` | Has version gaps — check spec |
| `sfn-tenants-api` | `src/main/resources/db/migration/` | Has version gaps — check spec |

Services WITHOUT migrations: `sfn-auth-api`, `sfn-eureka-api`, `sfn-gateway-api`, `sfn-policy-api`, `sfn-web-ui`, `snf-browser-extn`

NEVER guess migration version numbers. Always read `.secufusion-migrations.json` first.


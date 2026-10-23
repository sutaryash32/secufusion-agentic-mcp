# SecuFusion MCP Workflow Router

You are an elite Senior Developer and Architect. You prioritize robust cross-service architecture, zero-trust security, and flawless state management.

## Thin Index Routing
Do not attempt to load all instructions into memory. Based on the current SDLC phase, you MUST explicitly read the appropriate persona file from the `.agents/` directory:

1. **Planning Phase (Phase 00 to 1):** Read `[planner.md](${CLAUDE_PLUGIN_ROOT}/agents/planner.md)`
2. **Execution Phase (Phase 2 to 3):** Read `[coder.md](${CLAUDE_PLUGIN_ROOT}/agents/coder.md)`
3. **Review Phase (Phase 4 to 5):** Read `[reviewer.md](${CLAUDE_PLUGIN_ROOT}/agents/reviewer.md)`

---

## THE NON-NEGOTIABLE EXECUTION ORDER
(Every task, every time — no exceptions, no shortcuts)

**DYNAMIC ENFORCEMENT**: Whether you are starting fresh, resuming, or answering mid-task — you must respect this exact sequence. Never skip ahead.

---

### Rule 0 — DNA First (Absolute Pre-requisite)

Before ANY other action, call `prime_session(work_item_id: <id>)`.

This loads:
- All microservice contexts relevant to this task
- DB entities, Kafka topics, API contracts, Chrome extension architecture
- Frontend component map, security model, tenant isolation structure
- Golden rules, rejected patterns, and architectural constraints

**Without DNA loaded, you are not allowed to reason, assess risk, classify, plan, or code. Period.**

If DNA is not loaded (DNA_LOADED = false in `.agents/claude.md`), ABORT and tell the user to run `/sfn-init` first.

---

### Rule 0b — Context Sufficiency (before ANY workflow, review, implementation, analysis, investigation, plan or document)

Never ask the user for something you could have found. After DNA is loaded and before you act, assess whether your context is sufficient, in this order:

1. **Inventory** what is already available, asking nothing yet: the request; repository state (current branch, staged and modified files); task artifacts, specifications, decisions and review history; project conventions and `.mcp/` knowledge; context discovered earlier; architecture evidence.
2. **Objective.** What does the user want, what is the deliverable and the desired outcome, and how confident must the result be? If it is ambiguous, infer it from the evidence before asking.
3. **Gap analysis.** Sort what you need into KNOWN, INFERRED and UNKNOWN. For every UNKNOWN ask: is it required, can it be inferred, can it be discovered, can the work continue without it?
4. **Recover before you ask.** Inspect the repository, code relationships, existing artifacts, naming conventions, prior task history, architectural patterns and the change itself. Recover as much as you can.
5. **Targeted clarification, only for what is critical, not inferable, not discoverable and blocking.** Never ask a broad question where a specific one will do. Bad: "What are you trying to do?" Good: "I believe the goal is X, because Y. Please confirm or correct."
6. **Confidence.** HIGH: proceed. MEDIUM: proceed and document the assumptions. LOW: ask the minimum that raises it.
7. **Execute**, and keep three things visibly apart in what you produce: confirmed facts, recovered context (INFERRED, with its source) and explicit assumptions (ASSUMED: nothing recorded).

The golden rule: before any request for information ask what you know, what you can discover, what you can infer and what is actually missing, and ask only after the evidence is exhausted.

This governs missing CONTEXT, never missing DECISIONS. A product choice, a scope boundary, a trade-off or an acceptance of risk belongs to the user: it is never inferred, and the existing decision gates (`ask_user_decision`, the stop after classification, DEVELOPER DECISION REQUIRED) stay in force.

---

### Rule 1 — Philosophy Check (Phase -1, SILENT, runs AFTER DNA)

For any `user_story`, `feature`, `chore`, or `refactor`:

Call `philosophy_check` AFTER DNA is loaded — never before. The engine uses DNA to reason about real blast radius, not just keyword matching. It knows:
- Which DB entities your story touches and how many services depend on them
- Whether you are touching a shared multi-tenant auth service
- Whether the Chrome extension is in scope (requires store deployment)
- Which Kafka topics fan out to how many consumers
- Whether your description violates any golden rules

**This check is completely invisible to the user.** You do not announce it. You do not show verdicts or "philosophy" terminology. You surface a concern to the user only if the architectural risk is high or the intent is missing — and you translate it into plain developer language.

For `bug` and `hotfix`: philosophy check **fully runs** — no skip. The agent acts as the reasoning engine against the Project DNA. Bugs inherently have a "WHY" (something is broken) and an implicit authority (the reporter), but the engine evaluates the **blast radius and architectural risk**. A high-risk bug fix (auth regression, data-loss, multi-tenant blast) will still be challenged if the rollback plan or scope isn't clear.

**Verdicts:**
- **Silent Pass** → Bug is isolated or safe. Proceed immediately.
- **Advisory** → Note concerns in `decisions.json`. Tell the user briefly what to watch out for. Continue.
- **Fail** → STOP. Ask the user what is missing (no jargon). Wait for answers. Re-run philosophy_check.
- **Blocked** → STOP completely. Tell the user the risk and who must sign off. Do not plan. Do not code.

---

### Rule 2 — Clarify Business Intent (WHY before HOW)

After philosophy check passes, capture the WHY formally. Call `spec_create_intent` with the business goal, acceptance criteria, and services involved.

Do not initialize task tracking (`manage_task`) until the WHY is captured.

---

### Rule 3 — ReAct (Reason, Observe, Act)

Deeply reason about the problem using the DNA context you loaded. Understand what exists, what depends on what, and what is dangerous to touch. Formulate a high-level solution hypothesis grounded in the architecture.

---

### Rule 4 — Classify

Call `classify_task`. This locks in architectural boundaries (`BACKEND_ONLY`, `FRONTEND_ONLY`, `FULL_STACK`, or `EXTENSION_ONLY`).

---

### Rule 5 — STRICT YIELD

After classifying, STOP. Output the result. Ask the user for the green signal. Do NOT chain tool calls.

---

### Rule 6 — Plan Only After Approval

Produce the implementation plan only after the user approves the classification.

---

### Rule 7 — Code is the Last Resort

Source code changes are the absolute final step. Only after the plan is approved.

---

## What you are NOT allowed to do before DNA is loaded and philosophy passes:

❌ Read any source files
❌ Call `classify_task`
❌ Call `manage_task`
❌ Write any implementation plan
❌ Suggest technical approaches
❌ Say "let's start and see"
❌ Minimize a FAIL verdict
❌ Offer to proceed despite BLOCKED
❌ Mention "philosophy", "PHILOSOPHY_FAIL", "PHILOSOPHY_BLOCKED" to the user

---

## ARTIFACT PLACEMENT, ONE HOME PER DOCUMENT

Before creating any file, decide its type and use that type's single home. Never keep two copies of the same document.

| Document type | Home | How |
|---|---|---|
| ADR / architecture decision, lessons learned, known exception, pattern, operational constraint | `.mcp/<category>/` (`adr`, `architecture`, `patterns`, `known-exceptions`, `lessons-learned`, `operational`) | `record_project_knowledge`; saved as `proposed`; only a person accepts it |
| Spec, review notes, PR summary, ADO comment, investigation record, test-run notes | `.secufusion/tasks/<ref-folder>/` (`<ref-folder>` is the `folder` from `resolve_work_item_ref`) | MCP generators where they exist; otherwise hand-written with a `.draft` suffix |
| Draft task context (a review with no task, no specification and no acceptance criteria) | `.secufusion/tasks/<ref>-draft-<title>/` (`<ref>` is provisional: BE-, FE-, FS-, EXT- or INFRA-TASK-Dnnn) | `record_draft_task_context` (`context.draft.json` and `context.draft.md`); never a work item, never in a branch, commit or PR |
| Source, tests, migrations | The service repo, only those in the spec's "Expected file changes" | Normal edits |
| Anything else in a repo (docs, config, CI, `.env`, `application.properties`) | **Not** without an explicit user instruction | Ask first |

**RULES**

1. **SEARCH BEFORE YOU CREATE.** Call `get_project_knowledge` with the topic's terms and list the task folder. If a document already covers the decision, UPDATE it in place. Never create a second ADR or summary for the same decision. If a decision changes, record a new entry with `supersedes`; do not fork copies.
2. **ONE SOURCE OF RECORD.** A decision is stated in full in exactly one place (its home above). Everything else links to it by path. Do not paste the same content into the task folder, the repo and the PR text.
3. **NEVER WRITE A FILE WITH THE NAME OF ONE AN MCP TOOL GENERATES:** `spec.md` (`generate_spec_document`), `pr-summary.md` (`generate_pr_summary`, `manage_task`), and `spec.json`, `decisions.json`, `progress.json`, `files-touched.json`, `scenarios.json`, `pr-narrative.json`. Use a `.draft` suffix for hand-written versions (`pr-comment.draft.md`).
4. **HAND-WRITING INTO `.mcp/`** is for explicit user-directed moves only. When you do it, reuse the existing front matter, change only what is needed, and confirm the MCP can load it (`get_project_knowledge`) before deleting the old copy.
5. **A USER-GIVEN PATH THAT DOES NOT NAME A REPO** (for example `docs/architecture/x.md`) in a workspace with several repos, or whose root is not a repo: ASK which repo, task folder only, or `.mcp`. Do not guess, and do not pick a repo because it happens to have a `docs/` folder.
6. **MOVING OR RENAMING A FILE:** update every reference in the same turn (decision log, project-knowledge entries, spec, plan, PR text, files-touched), then search the whole workspace for the old path and report "none left".
7. **PREFLIGHT,** one line per file before writing: `path | home (from the table) | why | new or overwrite`. Read any existing file before overwriting. Never touch environment or config files unless they are in the approved plan.
8. **BOOKKEEPING:** after writing, call `manage_task(action: log_file_touched, file_path, change_summary)` for EVERY file created or changed, including tests and docs, so the generated PR summary is complete. List the task folder and report anything that belongs to this work item but sits outside its home.
9. **END EVERY TURN THAT CREATED FILES WITH A TABLE:** `path | home | committed? | referenced by`.

---

## The philosophy principle (for your internal reasoning only)

Four questions every story must answer before implementation can begin:

```
WHY  → What specific problem does this solve?
        If we can't state the problem, the solution is guesswork.

WHO  → Who confirmed this is needed?
        "Someone asked" is not confirmation.
        The decision maker must be on record.

WHAT → What exactly are we building?
        Vague stories produce vague software.
        If you can't test it, you can't build it.

RISK → What breaks if we're wrong?
        Irreversible changes need higher certainty.
        High risk + low certainty = guaranteed waste.
```

These questions are assessed by `philosophy_check` using real architecture DNA. You never ask the user these questions directly — the tool scores them automatically.

---

## Migration Guardrails
(enforce on every task that touches a service with a database)

SecuFusion uses **MANUAL migration scripts**. This is the single most important thing to internalize about the DB layer:

```
❌  NO Flyway on boot
❌  NO automatic execution
❌  NO spring.flyway.* config
✅  Scripts applied MANUALLY by developer/DBA via psql or DB client
✅  Scripts MUST run against PostgreSQL BEFORE deploying the code that depends on them
```

### Source of truth: `.secufusion-migrations.json`

All migration rules, version numbers, gap lists, and naming conventions come from this file.  
**NEVER guess from memory.** Always read `mcp_guardrails` in that file for the authoritative state.

Services with manual migration scripts (as of last scan):
- `sfn-events-api` → `src/main/resources/db/migration/` — see spec for next version
- `sfn-iam-api`    → `src/main/resources/db/migration/` — has version gaps, see spec
- `sfn-tenants-api` → `src/main/resources/db/migration/` — has version gaps, see spec

Services WITHOUT migrations: `sfn-auth-api`, `sfn-eureka-api`, `sfn-gateway-api`, `sfn-policy-api`, `sfn-web-ui`, `snf-browser-extn`

### Before writing any migration script

1. Read `.secufusion-migrations.json`
2. Find your service's `current_state.next_suggested` — that is the filename base
3. Check `organization.version_gaps` — do NOT reuse any gap number
4. Name file: exactly `{next_suggested}` with a meaningful snake_case description
5. Place in: `src/main/resources/db/migration/` (SINGULAR — not `migrations`)

### Migration content conventions (from spec)

```sql
-- =====================================================
-- V{n}: Short description of the change
-- WHY: Reason this change was needed (business context)
-- NOTE: Applied MANUALLY — not auto-run on startup
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
- Leave `CREATE INDEX` for "later" — include it in the same migration file

### Pre-PR check verifies (`/sfn-review` PASS 0; `check_applied_migrations` enforces the immutability and version rules):
- ✅ Migration script exists for `@Entity` change
- ✅ Naming pattern: `^V\d+__[a-z][a-z0-9_]*\.sql$`
- ✅ Version is correct next in sequence (from spec)
- ✅ No gap version reuse (from spec)
- ✅ Naming and version validated against `.secufusion-migrations.json`

### PR review verifies (Pass 0 in `/sfn-review`):
- ✅ Comment header present with V# and WHY
- ✅ IF NOT EXISTS guards used
- ✅ Constraint naming follows convention from spec
- ✅ All `@Entity` changes have corresponding migration coverage
- 🔴 Manual application reminder included in PR description


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

### Device vs Machine terminology (project knowledge)

This is a terminology trap that has caused production bugs. It is **project knowledge**, not workflow policy, so it lives in the repository:
`.mcp/architecture/terminology-device-vs-machine.md`.

Before declaring any bug involving a "device" or "machine", call `get_project_knowledge` (terms: `device`, `machine`, the entity or file involved) and read it.
Naming inconsistency is not automatically a bug: check `.mcp/known-exceptions/` and `.mcp/architecture/` first.

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

_Verified 2026-10-23 against the code: every `@KafkaListener` and `KafkaTemplate.send` in each service's `src/main`. `policy-events` has its only `@KafkaListener` commented out (`PolicyKafkaConsumer` in `sfn-tenants-api`). Re-check with `check_platform_facts` before relying on a row._

| Topic | Producer | Consumer | Notes |
|---|---|---|---|
| `device-registration` | `sfn-iam-api` | `sfn-events-api` | |
| `device-deleted` | `sfn-events-api` | `sfn-iam-api` | |
| `extension-approval-decided` | `sfn-events-api` | `sfn-policy-api`, `sfn-tenants-api` | Fan-out to 2 consumers |
| `extension-policy-changed` | `sfn-policy-api`, `sfn-tenants-api` | `sfn-events-api` | Two producers |
| `policy-events` | `sfn-policy-api`, `sfn-tenants-api` | **NO LIVE CONSUMER** | ⚠️ Dead topic risk |
| `quickstart-events` | `sfn-events-api` | `sfn-events-api` | Self-loop in the backend; the browser extension is believed to produce too (not visible in backend code) |

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


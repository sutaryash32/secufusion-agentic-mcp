# SecuFusion MCP Server

> **Project-level spec driven AI workflow tooling for the SecuFusion platform** — loads full project DNA at session start, enforces zero-trust architecture standards, tracks task specs, and gates PRs with automated guardrail checks.

[![npm version](https://img.shields.io/npm/v/secufusion-mcp)](https://www.npmjs.com/package/secufusion-mcp)
[![license](https://img.shields.io/npm/l/secufusion-mcp)](./LICENSE)
[![node](https://img.shields.io/node/v/secufusion-mcp)](https://nodejs.org)

---

## What is this?

`secufusion-mcp` is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that plugs into AI coding assistants (Claude Desktop, Cursor, Cline, etc.) and gives them **ten powerful tools** to enforce SecuFusion's engineering standards throughout the development lifecycle:

| Tool | Phase | What it does |
|---|---|---|
| `manage_project_spec` | **Phase 00** — Session Start | Loads `.secufusion-project-spec.json` — full project DNA (ports, repos, domains, coding patterns, golden rules) |
| `manage_task` | **Phase 0.7 / 1 / 2 / 4** — Task Lifecycle | Creates dynamically named `.secufusion/tasks/{id}-{slug}/` folder (the HOW layer: spec, progress, decisions, files-touched). |
| `spec_create_intent` | **Phase 1** — Planning | **NEW in v2.1** — Creates the Markdown intent file (the WHY layer: business goal, PM, ACs, polyglot service map). |
| `spec_read_intent` | **Phase 0 / 1** — Session Start | **NEW in v2.1** — Reads the Markdown intent file and ticks AC checkboxes. |
| `spec_next_number` | **Phase 1** — Planning | **NEW in v2.1** — Generates the next sequential ID for intent files. |
| `get_task_history` | **Phase 0 / 1** — Cross-Task Intelligence | Retrieves the full history of a past task before starting similar work |
| `search_tasks` | **Phase 0 / 1** — Cross-Task Intelligence | Keyword search across all past task files — prevents re-solving solved problems |
| `get_pattern_from_task` | **Phase 1** — Cross-Task Intelligence | Extracts reusable decisions, file patterns, and test scenarios from a completed task |
| `manage_branch_state` | Legacy — Branch State | Backward-compatible branch-scoped JSON state tracker (for tasks before `manage_task`) |
| `log_rejected_pattern` | **Phase 3** — Course Correction | Records bad patterns to `.rejected-patterns.json` so they are never repeated |
| `get_secufusion_rules` | **Setup** | Returns the `AGENTS.md` rules for AI clients that don't natively support MCP Resources |
| `classify_task` | **Phase 0.5** — Task Classification | **NEW** — Deep multi-pass analysis engine. Classifies any task as `BACKEND_ONLY`, `FRONTEND_ONLY`, etc. based on root cause. |
| `prime_session` | **Phase 0** — Session Start | **NEW** — Hyper-efficient session startup. Combines Phase 00 (spec) and Phase 0 (task) into one call using Thin Indexes to optimize context tokens. |
| `skill_recommend` | **Phase 1** — Planning | **NEW** — Dynamically recommends and retrieves domain-specific coding skills from `skills-catalog.json`. |

---

## 🚀 What's New: The SecuFusion MCP Complete Rewrite (Phases 1-8)

The SecuFusion MCP has been completely rebuilt from the ground up as a deterministic engineering control plane. It now operates as a rigorous evidence broker rather than a predictive AI tool.

1. **Phase 1 (Knowledge & Evidence Foundation):** Deterministic extraction of poly-repo architecture (Java, TS, configuration) into a living, queryable `.secufusion/dna.json` graph.
2. **Phase 2 (Requirement Intelligence & Clarification):** Bounded requirement state machine that explicitly blocks planning if business rules, authorization, or destructive operation semantics are unknown.
3. **Phase 3 (Traceability & End-to-End Reasoning):** Strict graph linkage connecting Requirements -> UX -> Code -> Tests -> Infrastructure.
4. **Phase 4 (Controlled Engineering Execution Loop):** Structured implementation planning (`ImplementationPlan`) enforcing deterministic bounds on modified files and testing obligations.
5. **Phase 5 (Automated Testing Intelligence):** Automated discovery and parsing of unit/integration test results across the ecosystem to prove traceability validation.
6. **Phase 6 (Engineering Knowledge & Validated Experience):** Structured recording of validated historical lessons (e.g. anti-patterns, recurring test failures) linked to architectural components, preventing recurring mistakes.
7. **Phase 7 (Continuous Intelligence & Regression Prevention):** Snapshot-based architecture comparison (`compare_repository_snapshots`) detecting architectural drift, requirement gaps, and historical regression risks prior to implementation.
8. **Phase 8 (Product Design & UX Reference):** Bounded deterministic UI intelligence (`discover_ui_patterns`) and sandboxed static HTML reference generation (`generate_static_ui_reference`) to prototype UX interactions before writing React code.

---

## ⚡ Legacy Features & Architecture Alignment

## 🧬 Built-In DNA Discovery & Architecture Exploration

`secufusion-mcp` includes native ecosystem-wide discovery tools:

- **Dynamic Stack Analysis:** Identifies Java/Spring, Node, Docker, and other frameworks on the fly.
- **Automated Dependency Mapping:** Generates cross-service dependency maps and evaluates the blast radius of potential changes.
- **Interactive Commands:** Use `/sfn-init` to map your entire workspace and launch the watcher, and `/sfn-explore` on-demand to render Mermaid architecture graphs or analyze component blast radius.

---

## ⚡ The Shift: "WHY before HOW" Spec-Driven Workflow (v2.1)

This is the biggest architectural upgrade to the SecuFusion MCP, fundamentally changing how the AI approaches a new task.

### The Problem
Previously, the AI acted as a blind code-generator. When given a task (e.g. "Add MFA"), it would immediately jump into writing code or initializing tracking infrastructure (`.secufusion/tasks/`), without understanding **why** the feature was being built, who requested it, or the business risk. Furthermore, its AST parsers were limited to Java/TypeScript, leaving Go, Python, or Rust services completely invisible.

### The v2.1 Solution: The Two-Layer Architecture
Every task now requires **two complementary files** that the AI reads together:

```
.secufusion/
├── intents/                    ← WHY layer  (business truth, human-driven, Markdown)
│   └── 0001-WI-2847-add-mfa-enforcement.md
│       ├── Business Goal       ← why is this being built?
│       ├── PM Owner            ← who owns it?
│       ├── Acceptance Criteria ← tickable checkboxes
│       ├── Service Map         ← polyglot bridge (Go, Python, Rust...)
│       └── Risk Assessment     ← what breaks if we don't ship?
│
└── tasks/WI-2847/              ← HOW layer  (code truth, AST-driven, JSON)
    ├── progress.json           ← pending/completed ACs
    └── decisions.json          ← architectural decisions log
```

### The Polyglot Bridge
The new `spec_create_intent` tool captures a `services_involved` array that is **language-agnostic**. You can list a Go microservice, a Python Lambda, or a COBOL batch job. The AI reads this declaration and knows those services are in scope without needing a custom AST parser.

### The New `/sfn-plan` Flow
When you type `/sfn-plan WI-2847 Add MFA`:
1. **The Guard (Phase -1):** The AI silently runs a `philosophy_check` against your Project DNA. It evaluates the WHY, WHO, WHAT, and RISK of the task. (Note: Bugs and hotfixes still undergo this check, though with slightly relaxed sensing).
2. **The Pushback (Phase 1):** If the Philosophy Engine fails the request (e.g. unclear business intent or high risk), the AI will **NOT** plan. It will stop and ask you for clarity: *"Why are we building this? Who confirmed it?"*
3. **The WHY (Phase 1.5):** You answer, and the AI generates the Markdown intent file (`spec_create_intent`).
4. **The HOW (Phase 2):** Only then does it initialize the code tracking infrastructure (`manage_task`).
5. **Context & Classify (Phase 3/4):** The AI loads the AST (`prime_session`), flags architectural risks (`classify_task`), and yields for your approval.
6. **The Plan (Phase 5):** The AI outputs the strict implementation plan.

---

## ⚡ The Shift: Problem-Statement Driven → Project-Level Spec Driven

### Before (problem-statement driven)
The AI started every session **cold**. It had zero knowledge of the codebase and relied entirely on the developer feeding context through a work item description. Every session began with implicit questions:
- *"Which port does sfn-iam-api run on?"*
- *"How do you extract tenantId from the JWT?"*
- *"What's the coding pattern for DTO mapping?"*

The AI was **reactive** — it knew only what you told it about the current task.

### After (project-level spec driven)
The AI starts every session by reading `.secufusion-project-spec.json` — a single file containing the **entire project's DNA**:

```
✅ All microservice ports, repos, Eureka names, domains
✅ Table ownership per service
✅ Inter-service call graph
✅ Kafka topics produced/consumed per service
✅ Keycloak realm + client config per service
✅ Coding patterns (DTO mapping, @Transactional style, tenant passing)
✅ Golden rules (tenant isolation layers, authority rules, banned patterns)
✅ Flyway migration state per service
```

The AI is now **proactively context-aware** — it knows your entire architecture before you say a single word about the task:

| Before | After |
|---|---|
| You explain the service every session | AI already knows all services |
| You describe the coding pattern | AI reads it from the spec |
| AI asks which port to use | AI looks it up from the spec |
| Context resets between sessions | Project knowledge is permanent |
| Spec is task-scoped | Spec is project-scoped |

> **One-time setup:** Generate `.secufusion-project-spec.json` once using the extraction prompt. From that point, every AI session starts fully informed.

---

## 🤖 The Autonomous AI Reviewer Engine (v2.2.5)

Version 2.2.0 removes the legacy, rigid TypeScript tools (`run_pre_pr_checks`) and replaces them with a fully standalone, AI-driven markdown execution contract (`/sfn:review`). 

### Why is this significant?
1. **Context-Aware, Not Regex-Bound**: The old tools blindly searched for regex patterns (like `@TenantScopeException`). The new AI reviewer genuinely reads the file, understands *how* the `tenantId` is flowing through the thread context, and makes intelligent architectural judgments.
2. **Zero Dependencies**: You no longer need to rely on the MCP server executing heavy AST-parsing scripts under the hood. The AI handles the review completely independently.
3. **10 Strict Passes**: The reviewer is contractually bound to execute 10 precise checks before it can output a verdict, including Kafka blocking detection, Acceptance Criteria coverage, Decision Drift (did you write code you didn't plan?), and Rejected Pattern enforcement.
4. **Ruthless Persona**: We injected a specific persona into the reviewer. It is explicitly forbidden from saying "Looks good to me!" to be polite. It operates as a senior architect with a zero-tolerance policy for guardrail violations.

---

## Spec-driven, LLM-judged lifecycle

The server no longer makes judgment calls with keyword scoring. It gathers evidence, asks a model, validates the answer against a schema, records it, and then **enforces** it with hard gates.

```
philosophy_check → spec_create_intent → classify_task → manage_requirement (assess → CONFIRMED)
   → manage_implementation_plan → validate_implementation_plan → code → verify_against_spec → manage_task complete
```

| Gate | Decided by | Passes when |
|---|---|---|
| `philosophy` | LLM | WHY / WHO / WHAT / RISK are clear (PASS or ADVISORY) |
| `intent` | mechanical | business goal and ≥1 acceptance criterion exist |
| `classification` | LLM | not FRONTEND_ONLY (regex score is passed to the model as a *prior*, not a decision) |
| `requirement` | LLM | a READY assessment that still matches the requirement's current content (edit it and it goes stale) |
| `plan` | LLM + deterministic | every AC covered by a step and a test, no scope creep, no unconfirmed destructive op, no server-side errors |
| `review` | LLM (adversarial) | every AC `MET` with evidence, none skipped, no guardrail violations |

A tool whose prerequisites have not passed returns `⛔ SPEC GATE` and says what to run. `spec_status` shows the ledger and the next step.

**How the model is reached** (`mcp/src/judge.ts`):
1. **MCP sampling**: if the client supports it, the server asks the client's model directly.
2. **Caller judgment**: otherwise the tool replies `🧠 JUDGMENT REQUIRED` with rubric, evidence and a JSON shape; the calling LLM re-invokes the tool with `judgment`. Nothing is recorded until it validates.

Every judgment is stored in `.secufusion/judgments/<id>/<kind>.json` (source, verdict, evidence hash) and gate state in `.secufusion/gates/<id>.json`. Commit both.

> In caller mode the model that did the work also judges it. The schema forces evidence (`MET` needs a `file:line` or test name; every criterion must be judged), but for an independent review use a sampling-capable client or run `verify_against_spec` in a separate session.

---

## Installation

[![Claude Marketplace](https://img.shields.io/badge/Download_from-Claude_Marketplace-blue?logo=anthropic)](https://claude.ai/marketplace/secufusion-mcp)

### Option 1 — `npx` (no install required)

```bash
npx secufusion-mcp
```

### Option 2 — Global install

```bash
npm install -g secufusion-mcp@2.2.5
```

### Option 3 — Local project install

```bash
npm install --save-dev secufusion-mcp@2.2.5
```

---

## Setup: Add to Your MCP Client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or  
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "secufusion-mcp": {
      "command": "npx",
      "args": ["-y", "secufusion-mcp"]
    }
  }
}
```

### Cursor

Open **Settings → MCP** and add:

```json
{
  "secufusion-mcp": {
    "command": "npx",
    "args": ["-y", "secufusion-mcp"]
  }
}
```

### Cline (VS Code Extension)

Open Cline settings → MCP Servers → Add:

```json
{
  "secufusion-mcp": {
    "command": "npx",
    "args": ["-y", "secufusion-mcp"],
    "disabled": false
  }
}
```

### Using a local build (development)

```json
{
  "secufusion-mcp": {
    "command": "node",
    "args": ["C:/path/to/secufusion-mcp/index.js"]
  }
}
```

---

## Tools Reference

### 1. manage_branch_state

Manages a structured JSON state file (`.secufusion-state.json`) keyed to the current Git branch. This replaces unstructured Markdown parsing and ensures the AI can resume perfectly.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `initialize`, `read`, or `update` |
| `task_description` | string | No | (For `initialize`) Summary of the work |
| `pending_acs` | array | No | Array of strings for pending tasks (For `initialize`/`update`) |
| `completed_acs` | array | No | Array of completed AC strings (For `update`) |
| `next_step` | string | No | **CRITICAL for `update`**: A clear instruction on what to do next to allow instant resumption. |
| `reference_file_path` | string | No | Path to a reference file with standard coding patterns (auto-compressed to save tokens) |

**Example — Starting a new task:**
```json
{
  "action": "initialize",
  "task_description": "Implement DeviceActivitySummaryDTO with browserUsage map.",
  "pending_acs": ["Add browserUsage map", "Add unit tests", "Update OpenAPI"]
}
```

**Example — Updating progress:**
```json
{
  "action": "update",
  "pending_acs": ["Update OpenAPI"],
  "completed_acs": ["Add browserUsage map", "Add unit tests"],
  "next_step": "Generate the OpenAPI YAML for DeviceActivitySummaryDTO and test generation."
}
```

---

### 2. `log_rejected_pattern`

Appends a rejected code pattern to `.rejected-patterns.json`. The AI checks this file implicitly before every architectural suggestion to avoid repeating past mistakes.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | Yes | The bad pattern or approach |
| `reason` | string | Yes | Why it was rejected and what to do instead |
| `category` | enum | No | `architecture` \| `security` \| `database` \| `logging` \| `api-design` \| `testing` \| `other` |
| `file_context` | string | No | File or area where the pattern was observed |

**Example:**

```
Tell your AI: "Never use a global @Repository bean without tenantId scoping again.
It was leaking cross-tenant data."
```

The AI will call:
```json
{
  "pattern": "Injecting global @Repository bean and querying without tenantId filter",
  "reason": "Causes cross-tenant data leakage. Always add .where(tenantId = :tenantId) or use TenantAwareRepository base class.",
  "category": "security",
  "file_context": "src/repositories/AuditLogRepository.java"
}
```

This writes to `.rejected-patterns.json`:
```json
[
  {
    "id": 1,
    "timestamp": "2026-08-26T14:35:00.000Z",
    "category": "security",
    "pattern": "Injecting global @Repository bean...",
    "reason": "Causes cross-tenant data leakage...",
    "file_context": "src/repositories/AuditLogRepository.java"
  }
]
```

---

### 3. generate_ado_comments
### 3. Native Document Generation (v1.0.58+)

Instead of using a generic tool, the agent natively generates two highly structured files based on strict `AGENTS.md` templates:
- **`ado-comments.md`**: For the Azure DevOps board (Layman summary + Technical Deep-Dive).
- **`pr-comment.md`**: For the PR Description (Changes, Impact, Scenarios, Guardrails).

The AI constructs these dynamically by reading `scenarios.json`, `decisions.json`, and `files-touched.json`, and presents them to the developer.

---

### 4. `manage_project_spec`

Loads and manages `.secufusion-project-spec.json` — the permanent project memory file. **Called automatically at the start of every session (Phase 00)** before any task begins.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | enum | Yes | `read` \| `get_service` \| `get_golden_rules` \| `get_coding_patterns` \| `update` |
| `service_name` | string | No | **(For `get_service`)** Name of the microservice, e.g. `sfn-events-api` |
| `update_path` | string | No | **(For `update`)** Dot-notation path, e.g. `microservices.sfn-iam-api.port` |
| `update_value` | any | No | **(For `update`)** New value to set at `update_path` |

**Actions:**

| Action | Returns | Token cost |
|---|---|---|
| `read` | Full spec (all services, all patterns, all rules) | High — use once at session start |
| `get_service` | Only the block for the requested microservice | Low — use when focused on one service |
| `get_golden_rules` | `golden_rules` block + `rejected_patterns` | Low — use before any architectural decision |
| `get_coding_patterns` | `coding_patterns` block | Low — use before writing any new class |
| `update` | Confirmation of surgical dot-notation write | Low — never overwrites the full file |

**Example — Session start (reads full project context):**
```json
{ "action": "read" }
```

**Example — Focused lookup before writing a service:**
```json
{ "action": "get_service", "service_name": "sfn-iam-api" }
```

**Example — Check golden rules before an architectural decision:**
```json
{ "action": "get_golden_rules" }
```

**Example — Surgical port update (never overwrites the full file):**
```json
{
  "action": "update",
  "update_path": "microservices.sfn-iam-api.port",
  "update_value": 9005
}
```

**File location resolution order:**
1. Same directory as `index.js`
2. `process.cwd()`
3. Walk up from `cwd` (up to 5 levels)
4. The global MCP package installation directory (bundled spec fallback)

---

### 5. `get_secufusion_rules`

A simple utility tool that returns the raw text of the `AGENTS.md` workflow rules. This is designed as a workaround for AI clients (like older versions of Cline or Claude Code) that do not support the MCP **Resources** capability.

By calling this tool, the AI can read the globally bundled rules without you needing to copy the `.agents` folder into your local repository.

**Example:**
> "Call the get_secufusion_rules tool and read the rules before we begin."


---

## Guardrails Summary

These rules are enforced automatically — the AI will never violate them:

```
✅ All DB queries and event payloads scoped with tenantId
✅ No console.log() or System.out.println() in any source file
✅ No hardcoded UAT/Prod IPs or environment URLs
✅ Every JPA @Entity change accompanied by a Flyway .sql migration
✅ State in .secufusion-state.json must be fully resolved before PR is raised
✅ Token Efficiency: Every tool response includes a 📊 Telemetry receipt tracking input/output tokens, cost, and the Session Total
```

**Performance Guardrails** (enforced whenever writing queries, Kafka consumers, or cross-service calls):
```
✅ All GET service methods use @Transactional(readOnly = true)
✅ No repository method called inside a for/forEach loop — batch with findAllById/saveAll
✅ Every new query column that is filtered/sorted has a CREATE INDEX in the Flyway migration
✅ Kafka listeners never do synchronous DB writes or REST calls — offload to @Async
✅ Every RestTemplate/WebClient call has an explicit timeout and fallback
```

**Rollback Guardrails** (enforced on every Flyway migration, API contract change, Kafka schema change):
```
✅ SAFE migration (additive) — safe to roll back by reverting code
⚠️  RISKY migration (NOT NULL without DEFAULT) — requires compensating migration
🚫 DANGEROUS migration (DROP/RENAME) — requires explicit developer confirmation before writing
✅ API hard cutover (removing /v1/ or a field) — requires confirmation; prefer /v2/ + deprecation first
✅ Kafka schema change — coordinated deployment of producer + all consumers; flagged in rollback plan
✅ Every manage_task initialize logs a rollback strategy starter entry in decisions.json
```

**Breaking Change Detection** (run as Step 4 in Phase 0.5 before any plan is written):
```
✅ Check 1: Endpoint consumers — who calls this endpoint? Flag if response shape changes
✅ Check 2: Entity/table consumers — @Query annotations across all repos for this column
✅ Check 3: Kafka topic consumers — coordinated deployment required if schema changes
✅ Check 4: Chrome extension — silent breaks invisible until users report them
✅ Over-flag > under-flag: always present a breaking change report if in doubt
```

**classify_task — Deep Analysis Engine** (runs first on every task, before anything else):
```
✅ Weighted signal tiers: service names = 10pts, tech constructs = 5pts, generic = 1pt
✅ Root-cause extraction: classifies by WHERE THE FIX LIVES, not where the symptom appears
✅ Negation detection: "not a UI issue" removes frontend signal weight
✅ Bug disambiguation: data-correctness/exception/auth/CRUD/performance bugs → +backend
✅ Confidence gate: HIGH only when score ratio ≥ 1.8× AND Tier 1/2 signal matched
✅ Persists to .secufusion/classifications/{id}.json — no re-classification on resume
```

---

## File Outputs

| File | Description | Commit? |
|---|---|---|
| `.secufusion-project-spec.json` | **Project DNA** — all services, ports, patterns, golden rules. Generated once, read every session | ✅ Yes |
| `.secufusion/registry.json` | Index of all initialized work items and their exact dynamic folder names — used by `search_tasks` | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/spec.json` | Task spec — title, description, ACs, tags, status | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/progress.json` | AC tracking — pending, completed, next_step | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/decisions.json` | Architectural decisions log (including rollback strategy) | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/files-touched.json` | All files modified with change summaries | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/scenarios.json` | Test scenarios (unit / integration / e2e / manual) | ✅ Yes |
| `.secufusion/tasks/{id}-{slug}/pr-summary.md` | Auto-generated PR summary on `manage_task complete` | ✅ Yes |
| `.secufusion-state.json` | **Legacy** branch-scoped state — still works via `manage_branch_state` | ✅ Yes |
| `.rejected-patterns.json` | Cumulative log of all rejected patterns across sessions | ✅ Yes |
| `.secufusion-tokens.json` | Persistent tracking of session-wide LLM token usage and cost | ❌ No |

> **Tip:** Commit the entire `.secufusion/` folder and `.rejected-patterns.json` to your repo. Do **not** commit `.secufusion-tokens.json`.

---

## Workflow Overview

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│  Phase 00    │  manage_project_spec (action=read + get_golden_rules)         │
│  Project DNA │  → FIRST step — runs before ANY problem statement is read     │
│  (Session    │  → AI loaded with ALL services, ports, coding patterns,       │
│   Start)     │     Kafka topics, golden rules, and tenant isolation config   │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 0.5   │  Ultimate Reasoning (ReAct) → classify_task                   │
│  Task        │  Step 1: AI outputs ### Ultimate Reasoning block              │
│  Classification  Deconstruction / Observation / Root Cause / Hypothesis    │
│              │  Step 2: classify_task → 5-pass deep analysis engine          │
│              │    Pass 1: Weighted signal scoring (Tier 1-4)                 │
│              │    Pass 2: Negation detection per sentence                    │
│              │    Pass 3: Root-cause phrase extraction                       │
│              │    Pass 4: Bug disambiguation matrix                          │
│              │    Pass 5: Confidence gate (≥ 1.8× + Tier 1/2 required)      │
│              │  → allowed_next_action: PROCEED / CONFIRM / STOP              │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 0.6.6 │  manage_task (action=read_summary)  OR  search_tasks          │
│  Resume      │  → Token-efficient status view → resume next_step instantly   │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 0.7   │  Present full plan (scope, files, ACs, perf, rollback)        │
│  Plan Gate   │  → STOP and wait for "proceed" / "adjust" / "cancel"          │
│              │  → manage_task (action=initialize) only after proceed          │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase -1    │  philosophy_check (Silently validates WHY/WHO/WHAT/RISK)       │
│  Philosophy  │  → Blocks planning if intent or safety is unclear (ALL TASKS)  │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 1     │  search_tasks → get_task_history → manage_task initialize     │
│  Planning    │  → Creates .secufusion/tasks/{id}-{slug}/ with all 5 files    │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 2     │  manage_task: update_spec / log_file_touched /                │
│  Execution   │              log_decision / add_scenario                       │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 3     │  log_rejected_pattern                                          │
│  Correction  │  → Record mistakes permanently to avoid repeat                │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Phase 4     │  /sfn:review (Standalone AI Reviewer Engine)                  │
│  PR Handoff  │  → Enforces 10 strict architecture passes directly on code    │
│              │  → manage_task (action=complete) → pr-summary.md generated    │
│              │  → Document Generation (ado-comments.md, pr-comment.md)         │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

---

## Real-World Walkthrough

A complete end-to-end example of what you actually type and what happens at each phase.

---

### Step 1 — Integrate (one-time setup)

Add this to your MCP client config and restart. That's it.

**Antigravity / Claude Desktop / Cline — if you have the source on disk:**
```json
{
  "mcpServers": {
    "secufusion-mcp": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\Desktop\\mcp\\secufusion-mcp\\index.js"],
      "type": "stdio"
    }
  }
}
```

**Teammates / fresh machines — pulls from npm, cached after first run:**
```json
{
  "mcpServers": {
    "secufusion-mcp": {
      "command": "npx",
      "args": ["-y", "secufusion-mcp"],
      "type": "stdio"
    }
  }
}
```

> **Why two options?** If you have the compiled `index.js` on disk, `node` starts instantly and works fully offline. Teammates who don't have the source use `npx` — it downloads from npm once (~3s), then caches it locally so every subsequent run is instant with no network needed.

---

### Step 2 — Start a new task (Classification phase)

Just paste your Azure DevOps work item ID and description directly into the chat. No special syntax needed.

Before analyzing the problem statement, the AI has already loaded the Project DNA from Phase 00. It now outputs an **Ultimate Reasoning block** — a structured, spec-grounded analysis of the problem — then calls `classify_task`.

**You type:**
```
WI-2847: Add MFA enforcement for admin users on login

**User Story:**
As a security administrator,
I want to enforce TOTP-based Multi-Factor Authentication (MFA) for all users with the ADMIN role,
So that sensitive dashboard actions are protected against compromised credentials.

**Acceptance Criteria:**
1. Any user with the ADMIN role attempting to log in must be prompted for a TOTP token after password verification.
2. The system must validate the TOTP token against the user's registered MFA device.
3. Service accounts (role = SERVICE_ACCOUNT) are exempt from MFA, even if they possess admin privileges.
4. If MFA fails 3 times, the account should be temporarily locked for 15 minutes.
```

**The AI outputs:**
```
### Ultimate Reasoning
- **Deconstruction:** TOTP enforcement is an auth-layer concern. sfn-iam-api owns the login flow.
- **Observation:** AuthService.java contains the password verification step (line 112). No MFA interceptor exists yet. sfn-iam-api runs on port 9001 per project spec.
- **Root Cause:** No MFA gate exists between password verification and JWT issuance.
- **Hypothesis:** Add a MfaVerificationService that validates TOTP after password passes, blocks JWT issuance on failure, and records attempts for lockout logic.
```

**Then classifies and upon approval initializes:**
```json
{
  "action": "initialize",
  "work_item_id": "2847",
  "title": "Add MFA enforcement for admin users on login",
  "description": "Enforce TOTP-based MFA for ADMIN roles, exempting service accounts, with account lockout on 3 failed attempts.",
  "acceptance_criteria": [
    "Prompt ADMIN users for TOTP token post-password",
    "Validate TOTP token",
    "Exempt SERVICE_ACCOUNT role",
    "Lock account for 15m after 3 failed attempts"
  ],
  "tags": ["security", "auth", "mfa"]
}
```

---

### Step 3 — Write code normally

Just code as usual. With the MCP server active, the AI automatically:

- Adds `tenantId` scoping to every DB query it writes
- Uses a proper logger (e.g., `log.info()`) — never `console.log`
- Reads `.rejected-patterns.json` before making any architectural suggestion
- Reminds you to create a Flyway migration if it touches a `@Entity`
- References any `reference_file_path` you provided to match your coding style

---

### Step 4 — Tick off completed work (Execution phase)

As you finish pieces of the feature, tell the AI:

```
I've finished the tenantId scoping on all queries and written the unit tests.
Update the state.
```

The AI calls `manage_task` with `action=update_spec` and the state updates:

```json
{
  "action": "update_spec",
  "work_item_id": "2847",
  "pending_acs": ["Exempt SERVICE_ACCOUNT role", "Lock account for 15m after 3 failed attempts"],
  "completed_acs": ["Prompt ADMIN users for TOTP token post-password", "Validate TOTP token"],
  "next_step": "Implement exemption logic for service accounts in AuthController"
}
```


---

### Step 5 — Course correction (if the AI does something wrong)

Say the AI used a hardcoded URL or proposed a pattern your team has banned:

```
Stop using hardcoded staging URLs like https://staging.secufusion.io.
All env URLs must come from application.properties. Never hardcode them.
```

The AI **immediately** calls `log_rejected_pattern`:

```json
{
  "pattern": "Hardcoded staging URL https://staging.secufusion.io in source files",
  "reason": "Must use @Value('${app.base-url}') from application.properties. Hardcoded URLs break environment parity and expose internal topology.",
  "category": "security",
  "file_context": "src/services/NotificationService.java"
}
```

---

### Step 6 — Complete the task (PR Handoff phase)

When you're done, say:

```
I'm done with WI-2847. Please complete the task and generate the ADO comments.
```

The AI marks the task complete, auto-generates a PR summary locally, and then outputs two Azure DevOps comments for you to paste into the ticket:

**✅ Passing output:**
```
Here are the comments for your ADO ticket:

**Layman Summary:**
The problem where some devices weren't accurately appearing on the admin dashboard has been resolved. The fix ensures that the system accurately tallies the registered hardware without throwing silent errors.

**Technical Deep-Dive:**
The `DeviceActivitySummaryDTO` was throwing a NullPointerException because the `browserUsage` map was uninitialized when `deviceList` was empty. I added an explicit `ConcurrentHashMap` initialization and scoped the iteration inside a `tenantId` check to preserve cross-tenant boundaries.
```

---

## How It Works (The 3 Layers)

The SecuFusion MCP operates across three complementary layers to prevent AI amnesia, enforce architecture standards, and gate code quality:

**Layer 1 — Project Spec (permanent, project-scoped):** `.secufusion-project-spec.json` — loaded once per session via `manage_project_spec`. The AI never needs to be told what port a service runs on, what pattern to use for DTO mapping, or how tenantId flows through the system.

**Layer 2 — Task Memory (persistent, work-item-scoped):** `.secufusion/tasks/{id}-{slug}/` — one dynamically named folder per work item, initialized via `manage_task`. Tracks spec, progress, decisions, files touched, scenarios, and generates a `pr-summary.md` on completion. Cross-task intelligence via `search_tasks`, `get_task_history`, and `get_pattern_from_task` prevents re-solving solved problems.

**Layer 3 — AST Guardrails (automated, quality-gating):** ESLint, Maven Checkstyle, tenant isolation scanner, Flyway checker, performance rules, rollback classification, and breaking change detection run at PR time. Cannot be bypassed without explicit `skip_checks`.

### How it all wires together

```
mcp_config.json                →  starts the server (tools available)
      +
.agents/AGENTS.md              →  tells AI when to invoke each tool
      ↓
★ SESSION STARTS
      ↓
Phase 00: manage_project_spec (read + get_golden_rules)
          → AI's brain loaded with full Project DNA BEFORE any task is read
          → knows all ports, services, patterns, tenant rules from spec
      ↓
You say: "WI-1042: Add audit log export"
      ↓
Phase 0.5: ### Ultimate Reasoning (spec-grounded ReAct)
           → Deconstruction / Observation / Root Cause / Hypothesis (written to chat)
           → classify_task: 5-pass deep analysis
              weighted scores + root-cause phrases + negation + bug heuristics
              allowed_next_action: PROCEED (backend) / CONFIRM (mixed) / STOP (frontend)
              + performance risk scan (GREEN/AMBER/RED)
              + breaking change scan (endpoints/entities/Kafka/extension)
      ↓
Phase 0.7: full plan presented → developer approves ("proceed")
      ↓
Phase 1: search_tasks (always) → get_task_history → manage_task initialize
       → .secufusion/tasks/1042-add-audit-log-export/ created
      ↓
Phase 2: code + log_file_touched + log_decision + add_scenario (ALL mandatory)
      ↓
Phase 4: /sfn:review → APPROVED / DISCUSS
       → manage_task complete  →  pr-summary.md generated
       → Generate PR & ADO Documents natively using templates
```

### Reusing across projects (Global Bundling)

As of version **1.0.13+**, `secufusion-mcp` globally bundles both `.secufusion-project-spec.json` and `AGENTS.md`. You **no longer need to copy these files** into every single repository!

When you install globally (`npm install -g secufusion-mcp@2.2.5`), the AI can automatically read your rules and project spec on the fly from the global installation.

**How to load the Rules in a new project:**
Depending on your AI client's capabilities, you can load the rules instantly by telling the AI:
- **"Use the `secufusion_developer` prompt"** (if Prompts are supported)
- **"Read the `secufusion://rules` resource"** (if Resources are supported)
- **"Call the `get_secufusion_rules` tool"** (if only Tools are supported)

*(If you prefer the legacy method, you can still copy `.agents/AGENTS.md` and `.secufusion-project-spec.json` into your project root).*

### Dynamic Task Folders (v1.0.17+)

As of version **1.0.17**, the MCP server automatically generates human-readable, safe folder names for all new tasks using the task's title.

When you pass a title like `"BUG-1140: Tenant deletion reports failure"` to `manage_task initialize`, the server strips bad characters, truncates the string safely, and generates a perfect folder name:
`.secufusion/tasks/BUG-1140-tenant-deletion-reports-failure/`

- **Backward Compatible:** The AI only ever needs to supply the `work_item_id` (e.g. `BUG-1140`) for subsequent updates. The server instantly finds the correct folder via `registry.json` (O(1) lookup) or falls back to a prefix scan for legacy `WI-{id}` folders.
- **OS Safe:** Automatically trims trailing dashes and clamps lengths to prevent Windows `MAX_PATH` errors.

### Dynamic Architecture Validation (v1.0.23+)

As of version **1.0.23**, the deep analysis engine in `classify_task` is fully dynamic and driven entirely by your `.secufusion-project-spec.json`:
- Validation dynamically cross-references explicit microservices, frontend repos, and Chrome extensions.
- Explicit frontend overrides (e.g., `"pure ui"`, `"no backend changes"`) can bypass false-positive `FULL_STACK` labels.
- The Breaking Change Pre-Scan safely checks for exact table names and Kafka topics derived from your architecture.
- `coding_patterns` defined in the spec are injected seamlessly into `secufusionFlags` validation.

### Retrospective Intelligence (v1.0.24+)

As of version **1.0.24**, the MCP server introduces a fully automated **Retrospective Layer**:
- **Auto-Retrospective Trigger**: `manage_task complete` now automatically generates a partial retrospective and asks the developer 7 targeted questions.
- **record_retrospective**: A new tool that saves retrospective insights, tracking plan accuracy, classification accuracy, and pre-PR check attempts.
- **Dynamic Learning (Pass 0)**: `classify_task` now includes a Pass 0 that injects learned signals from past retrospectives into the active classification logic.

### Rule 0 Enforcement & Frontend Fallbacks (v1.0.50+)

As of version **1.0.50**, the MCP server strictly enforces **Rule 0** and adds intelligent fallbacks:
- **Rule 0 (DNA Load First)**: Agents are now strictly forbidden from reasoning, classifying, or planning until they have called `manage_project_spec` to load the project DNA.
- **Auto-Syncing AGENTS.md**: The package now automatically syncs the workspace rules before publishing, guaranteeing AI agents always run the latest constraints.
- **Frontend Service Resolution**: `get_service` now intelligently resolves frontend and extension repositories (like `sfn-web-ui`) even when they aren't explicitly keyed as backend microservices.
- **Explicit AC Recognition**: `classify_task` now overrides `VAGUE` completeness warnings if it detects explicit Acceptance Criteria in the task description.

### Strict Comment Guardrails & Slugification Fixes (v1.0.55+)

As of version **1.0.55**, the MCP server introduces two new quality-of-life and enforcement updates:
- **No Ticket IDs in Comments**: A strict rule has been added to `AGENTS.md` and the Tier 2 AI Reviewer now explicitly flags any inline ticket IDs (e.g., `// WI-1097`) inside code comments as a CRITICAL violation. Comments must explain the durable WHY, not point to decaying tracking tickets.
- **Clean Task Slugs**: `manage_task initialize` now automatically strips leading ticket prefixes (like `BUG-1173: `) from the title before generating the folder slug, preventing duplicated IDs in the folder path (e.g., no more `1173-bug-1173-`).

---

## Talking to the AI — What You'll Ever Say

Once all three layers are in place, you interact completely naturally:

| Situation | What you say |
|---|---|
| 🆕 New task | `WI-XXXX: [paste description from Azure]` |
| ✅ Done a chunk | `Done with the tenantId scoping, update the state` |
| ❌ AI did something wrong | `Don't do X, do Y instead` |
| 🚀 Ready for PR | `Run checks for WI-XXXX` or `Prepare PR` |
| 🔄 Resuming after a break | `What's left?` or `Resume the current task` |
| 🔍 Starting similar work | `Has this been done before?` — AI calls `search_tasks` |
| 📋 Want the full plan first | AI automatically presents plan in Phase 0.7 — type `proceed` to start |

**Before `manage_project_spec`:** The AI started cold every session. You explained ports, coding patterns, and tenantId flow every single time.

**After `manage_project_spec`:** The AI reads `.secufusion-project-spec.json` at session start and **already knows your entire architecture**. You just describe the work.

**Before `manage_task`:** The AI used a flat branch-state file with no cross-task memory.

**After `manage_task`:** Every work item has its own structured folder. The AI tracks decisions, files, and scenarios per task. `search_tasks` finds related past work. `get_pattern_from_task` reuses proven approaches.

**Before Phase 0.5 + 0.7:** The AI started coding immediately with no ownership check or explicit plan.

**After Phase 0.5 + 0.7:** The AI performs deep code investigation, writes an **Ultimate Reasoning** block to prove its root-cause understanding, and then calls `classify_task`. The deep analysis engine confirms the classification, runs a performance risk and breaking change scan, presents a complete plan with rollback strategy, and **waits for your approval before writing a single line of code**.

**Before strict AGENTS.md:** Each phase was a soft bullet list with suggestions. The AI could skip steps.

**After strict AGENTS.md:** Every phase has a MANDATORY tool-call sequence in code-block format, an explicit ❌ prohibition list, and a hard gate. Skipping any step is a named violation.

---

## Tool 10: `classify_task` — Deep Analysis Engine

The **mandatory first step** for every task without exception. Classifies a task as `BACKEND_ONLY`, `FRONTEND_ONLY`, `FULL_STACK`, or `EXTENSION_ONLY` using a 5-pass deep analysis pipeline.

> **Core principle:** Classifies by **where the fix lives** — not where the symptom appears.
> `"Dashboard shows wrong device count"` → fix is in the API/DB query → **BACKEND_ONLY**
> `"Button layout is broken"` → fix is in the React component → **FRONTEND_ONLY**

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `work_item_id` | string | Yes | Azure DevOps work item ID, e.g. `BUG-1140` or `2847` |
| `title` | string | Yes | Full task title from Azure DevOps |
| `description` | string | Yes | Full task description / problem statement — paste everything |
| `task_type` | enum | Yes | `bug` \| `user_story` \| `feature` \| `hotfix` \| `refactor` \| `chore` |

**The analysis passes:**

| Pass | What it does |
|---|---|
| **Pass 1 — Weighted signal tiers** | Tier 1: service names = 10pts each (dynamically populated from `project-spec.json`). Tier 2: tech constructs = 5pts. Tier 3: domain terms = 2-3pts. Tier 4: generic words = 1pt. |
| **Pass 2 — Negation detection** | Scans each sentence. `"not a UI issue"` → frontend penalty. Explicit overrides (e.g. `"pure ui"`, `"no backend changes"`) zero out backend scores to prevent `FULL_STACK` misclassifications. |
| **Pass 3 — Root-cause phrase extraction** | 25 backend patterns + 9 frontend patterns matched via regex. |
| **Pass 4 — Bug disambiguation matrix** | For `task_type: bug`: data-correctness → +15 backend, exception/crash → +15 backend, auth/permission → +12 backend. |
| **Pass 4.5 — Problem Statement Validation** | **NEW (v1.0.19+)**: Validates Title, Scope, and Task Type. Dynamically extracts `coding_patterns` from the project spec and injects them as active validations if relevant keywords are found. |
| **Pass 5 — Confidence & Breaking Change Gate** | `HIGH` only when dominant score ≥ 1.8× second-place **AND** at least one Tier 1/2 signal matched. Dynamically cross-references explicitly mentioned endpoints, Kafka topics, and DB tables against `project-spec.json` to accurately flag breaking change risks. |

**Output — `allowed_next_action`:**

| Value | Meaning | What the AI does |
|---|---|---|
| `PROCEED` | `BACKEND_ONLY` HIGH confidence | Moves directly to Phase 0.7 plan presentation |
| `CONFIRM` | Mixed / LOW / extension | Presents analysis report, waits for developer YES |
| `STOP` | `FRONTEND_ONLY` | Hard stop — routes to frontend team, no code written |

**Mixed signal resolution:** Backend dominates only when `backendScore ≥ 2.5× frontendScore`. Below that threshold → `FULL_STACK` (requires confirmation).

**Persistence:** Result saved to `.secufusion/classifications/{work_item_id}.json`. Resuming a classified task skips re-classification and loads the prior result.

**Example output for a bug:**
```
✅ BACKEND_ONLY (HIGH confidence)

Weighted scores: Backend=47 | Frontend=3 | Extension=0
Score ratio: 15.7x dominant
Root-cause evidence: [BE+12] data correctness → backend query | [BE+12] persistence failure → backend
Bug heuristic: data-correctness bug → +15 backend (API/DB likely source)
Classification reason: Backend dominates (47 vs FE:3 EXT:0) — frontend signals are noise

Proceeding to plan presentation. No developer confirmation needed.
```

---

## What Changed — Strict Enforcement Update

### `classify_task` — Deep analysis engine (replaces keyword counting)

| Before | After |
|---|---|
| Flat keyword counting — every word scored equally | 4-tier weighted scoring — service names = 10× generic words (dynamically loaded from `project-spec.json`) |
| `"dashboard"` → scored as frontend | Root-cause phrases — `"shows wrong count on dashboard"` → backend +12 |
| No negation awareness | Sentence-level negation — `"not a UI issue"` removes frontend weight. Explicit overrides (e.g. `"pure ui"`) safely force `FRONTEND_ONLY`. |
| Bug heuristic: default to backend only on LOW confidence | 5-category bug disambiguation matrix (+12–15pts per category) |
| HIGH confidence even on equal scores | HIGH only when ratio ≥ 1.8× AND Tier 1/2 signal matched |
| Mixed signals → always FULL_STACK | Backend dominates at 2.5× → classified BACKEND_ONLY, frontend treated as noise |
| Validation / Breaking Changes hardcoded | Validation rules, endpoints, DB tables, and Kafka topics dynamically extracted from `project-spec.json` |

### `AGENTS.md` — All phases rewritten to strict enforcement

| Phase | Before | After |
|---|---|---|
| **Phase 00** | Bullet list, no gate | MANDATORY 3-step sequence + ❌ prohibition list |
| **Phase 0 (Resume)** | `"Call read_summary, begin executing"` | Explicit STEP 1/2/3 + ❌ list (no guessing, no re-reading) |
| **Phase 0.7 (Plan Gate)** | `"Build a plan"`, soft suggestions | Every plan section is **mandatory** — omitting any = violation. Explicit proceed/adjust/cancel contract. |
| **Phase 1 (Planning)** | `"Call search_tasks if relevant"` | `search_tasks` is **unconditional** — STEP 1 always, even if "sure" there's no prior work |
| **Phase 2 (Execution)** | Bullet suggestions | MANDATORY code block for all 4 tool calls + `next_step` contract with explicit VIOLATION labels |
| **Phase 3 (Correction)** | `"Immediately call log_rejected_pattern"` | Explicit STEP 1/2/3 + ❌ list — log immediately, not end of session |
| **Phase 4 (PR Handoff)** | `"Call complete → run checks → fix if error"` | Explicit STEP 1-3 **fix → recheck loop** until ZERO errors (Unified 3-tier check) |
| **Guardrails** | Mixed soft/hard language | All `should` → `MUST`, all `avoid` → `FORBIDDEN`, linter errors explicitly blocking |
| **Cross-Task Intelligence** | Prose bullets | MANDATORY STEP 1-4 sequence + ❌ list |


---

## 🏗️ v2.0.0 — Native Claude Plugin Architecture

`secufusion-mcp@2.0.0` is a **complete architectural rebuild** of the MCP server into a native Claude Plugin. It unifies the MCP server, slash commands, personas, and hooks into a single self-contained, portable package following the enterprise-grade `ml-specs` plugin standard.

### What Changed

| Area | Before (≤ 1.2.8) | After (2.0.0) |
|---|---|---|
| **Plugin type** | Standalone MCP server only | Native Claude Plugin (`.claude-plugin/plugin.json` + `.mcp.json`) |
| **Slash commands** | Disconnected — no wiring to server | Natively registered — appear in Claude IDE `/` command menu |
| **Agent personas** | Scattered globally in `.agents/` | Self-contained inside `agents/` within the plugin package |
| **Path portability** | Hardcoded absolute paths | Fully portable via `${CLAUDE_PLUGIN_ROOT}` |
| **DNA plugin** | Separate `secufusion-dna-plugin` package | Fully merged into `secufusion-mcp` |
| **TypeScript build** | Root-level compile | Isolated in `mcp/src/` → compiles to `mcp/dist/` |
| **Repo validation** | Not present | Reads `.secufusion-project-spec.json` to verify all mandatory repos are cloned |
| **Frontend/ext validation** | Not present | Checks `frontend.repo` and `chrome_extension.repo` from project spec |

### New Package Structure

```
secufusion-mcp/
├── .claude-plugin/
│   └── plugin.json          ← Claude registers this as a native plugin
├── .mcp.json                ← MCP server wired into the plugin (${CLAUDE_PLUGIN_ROOT} relative)
├── agents/                  ← All agent personas (planner, coder, reviewer, claude, AGENTS.md)
├── commands/                ← All slash command definitions (markdown)
├── hooks/                   ← Lifecycle hooks (knowledge-drift.sh)
├── mcp/
│   ├── src/
│   │   ├── server.ts        ← Main MCP server logic
│   │   └── parsers/         ← Polyglot AST parsers (Java, TS, React, Config, Infra...)
│   ├── dist/                ← Compiled output (what npm ships)
│   └── tsconfig.json        ← Isolated TypeScript config
├── scripts/
│   ├── sfn-pr-check.js      ← Pre-PR mechanical guardrail runner
│   └── utils.js
└── package.json
```

### Merged: SecuFusion DNA Plugin

The previously separate `secufusion-dna-plugin` is now fully merged into `secufusion-mcp`. There is no longer a need to install or configure it separately. All DNA discovery tools are available natively:

- `scan_repository_stack` — discovers framework/stack and validates repos vs project spec
- `extract_domain_models` — maps JPA entities and domain objects via AST
- `extract_api_endpoints` — maps REST/GraphQL endpoints across all services
- `extract_event_topics` — maps Kafka producers and consumers
- `start_dna_watcher` — starts continuous background file watcher

### Mandatory Repository Validation

During `scan_repository_stack`, the server reads `.secufusion-project-spec.json` and cross-references:
- All keys under `"microservices"` (e.g., `sfn-auth-api`, `sfn-events-api`)
- The `"frontend.repo"` value (e.g., `sfn-web-ui`)
- The `"chrome_extension.repo"` or `"snf-browser-extn"` value (e.g., `snf-browser-extn`)

If any of these are physically missing from your local workspace folder, a `[WARNING]` is emitted listing exactly which core pillars need to be cloned before a complete DNA map can be built.

---

## ⚡ End-to-End Slash Command Workflow

All commands are natively registered as Claude Plugins and appear directly in the Claude IDE `/` command picker. The workflow is streamlined into **5 core commands** with zero redundancy:

| # | Command | Persona / Role | When to run | What it does |
|---|---|---|---|---|
| **1** | `/sfn-init` | Ecosystem Architect | First thing in morning, on new machine, or new clone | Bootstraps workspace, validates mandatory repos against `.secufusion-project-spec.json`, extracts domain models, API endpoints, Kafka topics, generates `.secufusion/dna.json`, builds full Mermaid architecture diagram, and launches continuous background file watcher (`chokidar`). |
| **2** | `/sfn-plan <ticket-id or desc>` | `planner.md` | When starting any story, chore, feature, bug, or hotfix | Evaluates Phase -1 Philosophy gate (WHY/WHO/WHAT/RISK), creates Markdown business intent (`spec_create_intent`), primes session AST context (`prime_session`), classifies task boundaries (`classify_task`), enforces **Rule 5 STRICT YIELD** for your green light, then generates structured `plan.md`. |
| **3** | `/sfn-code` | `coder.md` | After you approve the plan | Implements strictly according to the approved plan. Enforces zero-trust standards: mandatory tenant isolation on DB operations, proper `@Transactional` scoping, DTO mapping rules, and logs anti-patterns to `.rejected-patterns.json`. |
| **4** | `/sfn-review` | `reviewer.md` | After coding is done, before opening a PR | Adversarial PR gate running 3 tiers in a single pass: (1) Mechanical AST guardrails (tenant isolation, N+1 queries, hardcoded endpoints), (2) AI file-by-file code review, (3) Context-aware task evaluation against spec. Blocks PR if Tier 1 violations exist. |
| **5** | `/sfn-explore [map \| <component>]` | Architecture Explorer | On-demand for cross-service impact & system maps | Dual-mode architecture query: `/sfn-explore map` renders the full cross-service Mermaid architecture diagram; `/sfn-explore <component-or-path>` calculates blast radius and affected downstream consumers before making breaking changes. |

---

### 📊 The 5-Command SDLC Flow at a Glance

```
Morning / First Setup
  │
  ▼
/sfn-init                    ← Scans workspace, writes dna.json, draws Mermaid diagram, starts watcher
  │
  ├─► /sfn-explore map        (Optional on-demand: view ecosystem graph)
  │
Ticket Arrives (Feature / Bug / Hotfix)
  │
  ▼
/sfn-plan WI-XXXX            ← Phase -1 Philosophy check → Intent WHY → Prime → Classify → STRICT YIELD
  │
  ├─► User Approves Plan ✅
  │
  ▼
/sfn-code                    ← Implement approved plan with zero-trust guardrails
  │
  ├─► /sfn-explore <comp>    (Optional: verify blast radius if touching shared interfaces)
  │
  ▼
/sfn-review                  ← 3-Tier PR Gate: mechanical AST checks + AI review + spec matching
  │
  ▼
PR Ready to Merge 🚀
```

---

## Requirements

- **Node.js** >= 18.0.0
- An MCP-compatible AI client (Antigravity IDE, Claude Desktop, Cursor, Cline, etc.)

---

## License

ISC © SecuFusion

## Phase 9 Features Added
- Config-driven deterministic Workspace Discovery (`.secufusion/workspace.json`)
- Dynamic Core vs Optional Repository Classification
- Evidence Completeness Engine (`get_evidence_completeness`)
- Portable Workspace Paths (No hardcoded paths)

## Phase 10 Features Added
- End-to-End Real Repository Validation
- Handled massive-scale AST extraction spanning 800+ entities
- Fixed undefined identifier faults for raw source parsing
- Proven against Real MFA, Retention, and User Deletion Workflows

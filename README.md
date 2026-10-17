# SecuFusion MCP

A project-aware engineering assistant, delivered as a [Model Context Protocol](https://modelcontextprotocol.io) server and Claude plugin, built to behave like a disciplined senior engineer.

It does not just answer questions about your code. It runs a **workflow** (understand, specify, build, verify) with hard gates between the steps, keeps what the project has learned **inside the repository**, and refuses to let an assumption quietly become an architectural fact.

> **Agent remembers project → OLD.  Project teaches the agent → NEW.**

> **Version 4.9.0** · Node ≥ 18 · project knowledge moves into the repository (`.mcp/`), `/sfn-explore` and `/sfn-plan` became `/sfn-spec` (4.0.0), 4.1.0 adds a knowledge health report, templates and a suggestion engine, 4.2.0 makes `/sfn-review` a standalone, product-aware, investigation-driven reviewer, 4.3.0 makes the release file written by `/sfn-init` say what the new MCP version brings, 4.4.0 makes `/sfn-review` spec-aware and experience-aware, 4.5.0 gives every document one home, 4.6.0 adds the design investigation record to the post-review documents, 4.7.0 turns the PR summary into an engineering change summary and makes the philosophy gate show its reasoning, 4.8.0 writes ADRs as design narratives and seeds Device vs Machine by default, and 4.9.0 adds the merge-regression, silent-behavior-change and scope-drift lanes to every review. 85 tools. See [What's New in 4.9.0](#whats-new-in-490) and [Upgrading from 3.x](#upgrading-from-3x).

## Contents

1. [Core Philosophy](#core-philosophy)
2. [Why This Exists](#why-this-exists)
3. [Major Revamp: Project Intelligence Layer](#major-revamp-project-intelligence-layer)
4. [Unified Project Knowledge System](#unified-project-knowledge-system)
5. [Project Intelligence Layer](#project-intelligence-layer)
6. [MCP Workflow](#mcp-workflow)
7. [Commands](#commands)
8. [How the MCP Thinks](#how-the-mcp-thinks)
9. [Review Philosophy](#review-philosophy)
10. [Knowledge Management](#knowledge-management)
11. [Lessons Learned](#lessons-learned)
12. [Architectural Decisions](#architectural-decisions)
13. [Work-Item Identity](#work-item-identity)
14. [What's New in 4.9.0](#whats-new-in-490)
15. [What's New in 4.8.0](#whats-new-in-480)
16. [What's New in 4.7.0](#whats-new-in-470)
17. [What's New in 4.6.0](#whats-new-in-460)
18. [What's New in 4.5.0](#whats-new-in-450)
19. [What's New in 4.4.0](#whats-new-in-440)
20. [What's New in 4.3.0](#whats-new-in-430)
21. [What's New in 4.2.0](#whats-new-in-420)
22. [What's New in 4.1.0](#whats-new-in-410)
23. [What's New in 4.0.0](#whats-new-in-400)
24. [Upgrading from 3.x](#upgrading-from-3x)
25. [Getting Started](#getting-started)
26. [New Contributor Guide](#new-contributor-guide)
27. [Contributing Knowledge](#contributing-knowledge)
28. [Release Notes Philosophy](#release-notes-philosophy)
29. [Tool Reference](#tool-reference)
30. [Repository Layout and Where State Lives](#repository-layout-and-where-state-lives)
31. [Development](#development)
32. [Status and Known Limitations](#status-and-known-limitations)
33. [Roadmap: Next Evolution of the Project Intelligence Layer](#roadmap-next-evolution-of-the-project-intelligence-layer)
34. [Long-Term Vision](#long-term-vision)

---

## Core Philosophy

- **Understand before acting.** Load the project's context before touching anything.
- **Investigate before designing.** Read the real code, tests and config. Cite `file:line`. Never fabricate evidence.
- **Design before coding.** A complete, validated specification exists before the first line of production code.
- **Preserve repository conventions.** The existing code is the reference. The MCP never imposes a preferred style.
- **Minimize unnecessary change.** Build only what was specified. No drive-by refactors, reformatting or reordering.
- **Validate implementation quality and diff quality.** A correct change with a noisy diff is not a reviewed change.
- **Convert tribal knowledge into project-owned knowledge.** What the team learns lives in the repository, version-controlled, not in a prompt or a person.

---

## Why This Exists

| Problem | What it costs | How the MCP addresses it |
|---|---|---|
| **Tribal knowledge** | Critical facts live in one engineer's head and leave with them | Knowledge is recorded in `.mcp/` with a source, next to the code |
| **Lost architectural context** | Nobody remembers why a service owns a table or a topic has two producers | Architecture notes and ADRs are loaded at `/sfn-init` and retrieved when relevant |
| **Historical decisions disappearing** | A past, deliberate trade-off gets "fixed" as if it were a bug | Intentional exceptions are recorded; the reviewer is told not to flag them |
| **Repeated investigation** | The same terminology trap or false positive is rediscovered every quarter | Lessons learned are searchable and surface by ticket terms and touched files |
| **Onboarding difficulty** | New engineers need weeks of conversations to become safe | The repository explains itself: read `.mcp/`, run `/sfn-init` |
| **AI assistants without project context** | Generic advice, invented facts, silent assumptions | The assistant works from recorded evidence, asks you for decisions only you can make, and is gated step by step |

---

## Major Revamp: Project Intelligence Layer

| | Before | Now |
|---|---|---|
| **Where project knowledge lives** | Inside prompts and a growing `AGENTS.md` | In the repository, under `.mcp/`, version-controlled |
| **Who owns it** | A specific MCP instance, prompt or engineer | The project |
| **New MCP instance / new engineer** | Needs history from conversations | Reads the repository |
| **What `AGENTS.md` is** | A large store of project history and rules | A lightweight guide to *how to think*: workflow, investigation and review philosophy |
| **Commands** | `explore → plan → code → review` | `init → spec → code → review` |
| **Review** | Functional and architectural checks | Plus repository consistency and **diff quality** |
| **Release notes** | A repository scan with boilerplate | A change-driven changelog computed from the previous version |
| **Trust in recorded knowledge** | Implicit | Explicit: `proposed` vs `accepted`, with a source on every entry |

Knowledge belongs to the project, not to a specific engineer or MCP instance. The code explains **what** the system does. The Project Intelligence Layer explains **why**: which decisions are intentional, which patterns are preferred, which inconsistencies are legacy, which behaviours must not change, and which mistakes were already found.

---

## Unified Project Knowledge System

The MCP builds one understanding of a project from two complementary layers. Neither is useful alone.

| | Layer 1: **DNA** | Layer 2: **Project Intelligence** (`.mcp/`) |
|---|---|---|
| **Answers** | *What exists?* | *Why does it exist?* |
| **Holds** | Services, controllers, APIs, topics, domain models, event flows, dependencies, database mappings, topology | Terminology, auth models, decisions, intentional exceptions, incidents, lessons, review findings, operational constraints |
| **Produced by** | Scanning the code (`scan_repository_stack`, `extract_*`); regenerable | People and reviews, with a source on every entry; version-controlled |
| **Lives in** | `.secufusion/dna.json`, `.secufusion-project-spec.json`, `.secufusion-migrations.json` | `.mcp/` |
| **Can be rebuilt from code?** | Yes | **No.** That is why it must be recorded |

> **DNA tells the MCP what the system is. Project Intelligence tells the MCP why the system became that way.**

`/sfn-init` loads both and presents them together: DNA counts (what exists) beside Project Intelligence counts (what is explained), then the health report, which measures how much of the discovered structure has recorded reasoning. Structure without rationale is how a deliberate trade-off gets "fixed" as a bug; rationale without structure cannot be checked against the code.

The knowledge belongs to the repository. Clone the project, run `/sfn-init`, and inherit both the structure and the understanding, regardless of who wrote it or which MCP instance is running.

---

## Project Intelligence Layer

```
.mcp/
├── agents.md            optional; lightweight: workflow rules and engineering philosophy only
├── architecture/        how the system works
├── adr/                 why decisions were made
├── patterns/            how code should be written
├── known-exceptions/    intentional behaviours that may look incorrect
├── lessons-learned/     historical mistakes, findings, incidents, review lessons
├── operational/         deployment and runtime knowledge
└── release-history/     version evolution and release intelligence
```

| Folder | Holds | Typical entry |
|---|---|---|
| `architecture/` | System design, service relationships, domain terminology, entity ownership, data flow | *Device vs Machine terminology* |
| `adr/` | The decision, the alternatives rejected, the reasoning, the constraints and trade-offs | *Manual migrations instead of auto-apply* |
| `patterns/` | Coding conventions, API / Kafka / repository patterns, naming standards | *Query-level tenant scoping* |
| `known-exceptions/` | Intentional inconsistencies, legacy constraints, backward-compatibility decisions, accepted debt | *Retention scheduler authorizes as the system principal* |
| `lessons-learned/` | Production incidents, review findings, historical bugs, common false positives | *A 3-line change landed as a 1,100-line diff* |
| `operational/` | Deployment constraints, migration knowledge, environment-specific behaviour, risk areas | *Migrations are applied manually* |
| `release-history/` | Release notes and the snapshots each release is compared against | `v2.2.5.md`, `snapshots/v2.2.5.json` |

Each entry is one markdown file with a small frontmatter block:

```markdown
---
id: "terminology-device-vs-machine"
title: "Device vs Machine terminology"
category: architecture             # must match the folder
status: accepted                   # proposed | accepted | superseded | deprecated
tags: ["terminology", "device", "machine"]
applies_to: ["device", "*Device*"] # terms and/or path globs; used to surface the entry when relevant
source: "Where this came from: ticket, PR, incident, person, file"
date: 2026-10-08
supersedes: []
---
What is true, why, and what must NOT be "fixed".
```

**ADRs are documents first.** An ADR is an engineering design narrative for engineers, reviewers, architects and future maintainers, so it never opens with metadata. The file starts with the title (`# ADR-0003: Preventing Scheduler State Divergence Across Events API Replicas`) and a one-sentence summary, and the same fields sit in an invisible `<!-- mcp:entry ... -->` comment at the **end** of the file. The loader reads either form, so older entries with front matter at the top keep working.

The required structure answers, on the first page, *what problem did we have, why was it important, what did we choose, why*:

```markdown
# ADR-XXXX: <Decision Title>

> One sentence: the architectural problem and the selected approach.

## Decision Snapshot        (**Problem**, **Decision**, **Outcome**, **Status**, **Related Work**)
## Executive Summary
## Context
## Problem Statement
## Investigation Summary
## Options Considered
## Decision
## Consequences             (### Benefits, ### Trade-Offs, ### Risks, ### Future Reconsideration Criteria)
## Verification
## References
```

`record_project_knowledge` refuses an ADR that does not follow this structure and lists what is missing. The tool writes the title and the metadata; the readable **Status** line in the Decision Snapshot follows `set_knowledge_status`.

Entries are validated on load: missing fields, a wrong folder, a bad status, duplicate ids, dangling `supersedes` and empty bodies are reported, never silently ignored.

**It is retrieved by relevance, not dumped.** `/sfn-init` builds a compact index of the whole layer; during a task, `get_project_knowledge` returns only the entries that apply, ranked by the ticket's terms, the files involved and tags, with the reason each matched. Generic words in a free-text ticket do not drag in unrelated entries.

**Platform defaults.** `/sfn-init` calls `load_project_knowledge(seed_defaults: true)`, which records the platform knowledge the MCP ships, starting with the **Device vs Machine terminology**, into `.mcp/architecture/` by default. It is the MCP-owned terminology already carried in the project spec, so nothing is invented; it is saved `proposed` with its source until a person confirms it; it is skipped when the project already records an equivalent entry (no second copy), and it never overwrites or demotes an accepted one. Terminology lives in `architecture/`, not `adr/`, because an ADR records a decision and each document has one home.

**Health, templates and suggestions.**
- `get_knowledge_health` compares what the project spec says exists with what `.mcp/` documents (see *What's New in 4.1.0* for the exact definition) and lists the gaps; `/sfn-init` prints it.
- `.mcp/templates/` holds a starter per category. `load_project_knowledge(scaffold: true)` creates the layer; auto-creation is opt-in and off by default.
- `suggest_project_knowledge` turns evidence (repeated lookups, undocumented entities, tribal sections in the agent file) into prefilled, bodiless `record_project_knowledge` calls.

---

## MCP Workflow

```
   /sfn-init   ──►   /sfn-spec   ──►   /sfn-code   ──►   /sfn-review
   Load context      Think             Build             Verify
```

| | Legacy | Current |
|---|---|---|
| 1 | `/explore` | `/init` |
| 2 | `/plan` | `/spec` |
| 3 | `/code` | `/code` |
| 4 | `/review` | `/review` |

Short names are used in prose; the commands you type carry the plugin prefix: `/sfn-init`, `/sfn-spec`, `/sfn-code`, `/sfn-review`. The legacy `/sfn-explore` and `/sfn-plan` no longer exist.

**Why `explore` and `plan` were merged.** In practice they almost always ran back to back: exploration finds the current state, the root cause and the affected areas, and planning immediately uses those findings to define the approach, scope, risks and acceptance criteria. They are one engineering thought process, so they are now one **specification phase** (`/sfn-spec`) that keeps the same analytical depth behind a single command. The old command names no longer exist.

Between the commands the server enforces **gates**, so steps cannot be skipped:

```
philosophy → intent → classification → requirement → plan → review
```

A tool called before its prerequisites have passed returns `⛔ SPEC GATE` and says what to run first. `spec_status` shows the ledger and the next step at any time.

> **Command names.** In examples the commands are written `/sfn-init`, `/sfn-spec`, `/sfn-code`, `/sfn-review`. Use the `sfn-` prefix when invoking them: bare `/init` and `/review` collide with built-in commands in some clients.

---

## Commands

### `/sfn-init`: build project understanding

**Purpose.** Establish project intelligence and working context. Not only metadata: it constructs the project's understanding.

**Responsibilities**
- Scan the repository and workspace; create or merge `.secufusion-project-spec.json` (services, topics, rules, patterns) and the knowledge graph
- Load the Project Intelligence Layer: architecture, ADRs, patterns, known exceptions, lessons learned, operational knowledge, release history (`load_project_knowledge`)
- Validate it and report unreviewed entries, problems, and whether `agents.md` has grown into a knowledge dump
- Draw the architecture diagram and generate change-driven release notes when the spec version changes

**Outcome.** The MCP understands the project before making any decision. *Mental model: context first.*

### `/sfn-spec`: think before building

**Purpose.** Investigation and design as one process, ending in a complete specification.

**Responsibilities**
- Understand the requirement; check intent and story integrity (`philosophy_check`)
- Consult the project's recorded knowledge for the ticket's terms and files
- Investigate the **real** repository; identify the **root cause** with `file:line` evidence; classify the work
- Identify impacted services and contracts (blast radius, traceability)
- Assess UI impact; build a static, clearly-marked reference design when the UI changes, and have **you** review it
- Ask **you** every decision only you can make, then stop until you answer
- Confirm the requirement, create and validate the implementation plan, assess risks
- Define acceptance criteria and write the specification

**Outcome.** A complete **Implementation Specification** (`spec.md`), assembled from recorded state, never free-written: requirement, current state, root cause, scope, impact, decisions, strategy, expected file changes, acceptance criteria, tests, risks, assumptions and unknowns. *Mental model: understand → analyze → design.*

### `/sfn-code`: build only what was specified

**Purpose.** Implement the approved specification.

**Responsibilities**
- Refuse to start without a validated specification
- Follow the specification; produce focused changes
- Preserve repository conventions, including line endings and formatting
- Minimize the change surface; no unrelated refactoring; stop and ask before touching a file the specification does not cover

**Outcome.** An implementation that stays aligned to the specification and blends into the codebase. *Mental model: build only what was specified.*

### `/sfn-review`: verify the change, not just the logic

**Purpose.** Validate implementation quality **and** change quality.

**Responsibilities**
- Verify functionality, requirement coverage and specification compliance (every acceptance criterion judged, with evidence)
- Verify architecture alignment, impacted services, edge cases, security and tenant isolation
- Verify repository consistency and diff cleanliness (**PASS 10**): CRLF ↔ LF conversions, mixed line endings, diff inflation, formatting rewrites, whitespace-only changes, encoding changes, unnecessary reordering, files outside the specification
- Check naming and convention consistency against the surrounding code
- Consult recorded exceptions and decisions before flagging anything

**Outcome.** Only intentional, minimal, repository-consistent changes pass. *Mental model: trust but verify.*

---

## How the MCP Thinks

The server and the model have different jobs, and the split is deliberate.

| The server (deterministic) | The model (judgment) | The human (decision) |
|---|---|---|
| Stores state, enforces the order of steps, validates every verdict against a schema | Reads the code, forms an investigation, judges "is this requirement clear", "does this plan cover every criterion", "is every criterion met" | Business, security, tenant, data, deletion, API, UX and destructive decisions |
| Measures the diff, detects line endings, computes release deltas, retrieves relevant knowledge | Writes the investigation and the implementation | Approves designs, accepts knowledge, accepts diff noise |

- **Judgments are recorded, not assumed.** Tools such as `philosophy_check`, `classify_task`, `manage_requirement assess`, `validate_implementation_plan` and `verify_against_spec` either ask the client model directly (MCP sampling) or reply `🧠 JUDGMENT REQUIRED` with a rubric, the evidence and a JSON shape. The model answers by calling the tool again with a `judgment`. Nothing is recorded until it validates, and verdicts need evidence (a criterion is `MET` only with a `file:line` or a test).
- **Evidence over assertion.** Output is labelled FACT, INFERENCE, ASSUMPTION, UNKNOWN, CONFLICT, BLOCKER, DECISION or USER_DECISION_REQUIRED. Inferences are never presented as facts.
- **Never invent a decision.** An open decision is put to you with concrete options, and the work stops. Answering a decision, approving a design, accepting knowledge, accepting diff noise and converting line endings all require `user_statement`: your own words.
- **Hard gates, not reminders.** The server refuses out-of-order steps. A deterministic HIGH diff-quality finding blocks `APPROVED` no matter what the model concludes; only you can accept it.

---

## Review Philosophy

A real review once exposed a gap. A client reported that **a three-line change showed up as a 1,100-line diff** because of an unintended CRLF → LF conversion. The functionality was correct, but the change was unreviewable: the real edit was buried, merge-conflict risk went up, and reviewer trust went down. The review process had checked correctness and missed repository consistency.

So reviews now validate:

| Dimension | Question |
|---|---|
| **Functional correctness** | Does it do what the acceptance criteria say, with evidence? |
| **Architectural correctness** | Does it fit the service boundaries, tenancy, contracts and recorded decisions? |
| **Repository consistency** | Does it follow the conventions already in this file and repository? |
| **Diff cleanliness** | Is the committed diff the size of the intended change? |
| **Traceability** | Does every change trace to a criterion or a necessary consequence? |

> **A correct implementation with a noisy diff is not a fully reviewed change.**

### Product-aware review (PASS 11 to 18)

`/sfn-review` is a standalone, product-aware engine. It needs no earlier session: it builds a **Product Knowledge Brief** first (`.mcp/` entries, the project spec, the DNA graph, then the source itself), asks the developer what it cannot establish, and then reviews along eight dimensions: code quality, product behavior, service boundaries, deployment model, tenant hierarchy, privacy, operational resilience and maintainability.

**PASS 11, Product & Privacy Fit,** answers five questions with evidence, each as `FITS`, `DOES NOT FIT`, `CONCERN` or `UNVERIFIED`: does this match the product's actual behavior, will it work in the production deployment model, does it subtly break the tenant hierarchy, will it be hard to maintain in six months, does it violate the privacy model. PASS 12 to 18 supply the evidence.

Before it reads your code it loads three kinds of memory and keeps them apart: **product knowledge** (`.mcp/`, the project spec, the DNA graph), **the specification** the change was built against (requirement, plan, Implementation Specification, recorded decisions; it reviews scope, acceptance criteria, decisions and carried assumptions, and asks whether the spec itself contradicts the product), and **engineering experience** (lessons from earlier tasks, the lowest-trust source: a hint about where to look, never a rule). With no specification it says so and does not invent one.

It is an **investigation, not a checklist.** The reviewer models the change and its blast radius (using the DNA graph), forms specific hypotheses about how *this* change could harm the product, investigates each until it is confirmed or dismissed, asks the developer only what the evidence cannot settle, and shows its work in a *Reasoning trace* that includes the suspicions it dismissed. The passes are lenses that stop it forgetting a class of risk, not a form to fill in, and it reports what the lenses missed. The deterministic facts (`check_diff_quality`, the spec gate) stay deterministic.

**The review stays inside the story.** Before it judges anything it establishes the story boundary (objective, acceptance criteria, architectural and product decisions, out-of-scope items; with no specification the diff is the boundary) and classifies every finding:

| Class | Meaning | Reported as | Can change the verdict? |
|---|---|---|---|
| **A, in scope** | Directly impacts the acceptance criteria, requirements, implemented architecture, security, data or production correctness, or an explicit product decision, in what this change adds or modifies | In-scope findings (BLOCKER or WARNING) | **Yes, and only these** |
| **B, adjacent concern** | Found while reviewing, but not needed to satisfy the story | Out-of-scope observations, each with why it is out of scope and a suggested separate story | No |
| **C, future product risk** | Scalability, future tenant lifecycle, operational improvements, audit enhancements, UX ideas | Future considerations | No |

The test for every finding is: *does fixing this directly contribute to satisfying the acceptance criteria, the ADR or the problem statement of this story?* If not, the review does not ask for it to be changed in the current story. It does not hide real problems behind the boundary: whatever the acceptance criteria, the ADR or a recorded product decision requires is Class A, and diff-quality and scope-creep findings about the change itself are always Class A. The report order is Story scope assessment, In-scope findings, Out-of-scope observations, Future considerations, then the verdict, which says it rests only on in-scope findings.

**Three lanes run in every review, beside the scope classes** (each has its own section in the report):

| Lane | Tool | What it does | Effect on the verdict |
|---|---|---|---|
| **Merge regressions** | `check_merge_regressions` | Finds functionality accidentally lost during merge conflict resolution: methods, endpoints, repository queries and predicates, security and authorization checks, tests, config keys, translation keys, OpenAPI annotations, docs. Uses the merge commit, both parents and the merge base, and git's three-way logic (a deliberate deletion the merge honoured, and a method that moved, are not reported). Severity HIGH / MEDIUM / LOW. | None, unless one directly impacts an acceptance criterion |
| **Silent behavior changes** | `check_behavior_changes` | Finds behavior that moved while the code compiles and tests pass: authorization, validation, query predicates, filtering, defaults, feature flags, conditionals, time calculations. The reviewer writes a BEHAVIOR CHANGE block per change (old and new behavior, affected users, acceptance-criteria impact, risk, intent explicitly confirmed). Before it may write "intent not confirmed" it must search the acceptance criteria, the story text, ADRs, recorded product decisions and the user's instructions; with the work item, the tool searches the first four and lists possible supporting evidence under each change. | Unconfirmed MEDIUM/HIGH changes become in-scope findings |
| **Scope drift** | `check_scope_drift` | Classifies changed files as core, indirectly related or unrelated to the story and reports the unrelated ones with the recommendation to move them to a separate story or explain why they are included. | **None: report only** |

**Product-centric pessimistic mode.** For stories about ownership, roles, admin, tenancy, permissions or lifecycle (detected automatically, or requested with `--pessimistic`), the review stops asking whether the code works and asks why the change may fail in production. It explains the change in business terms and lists the **feature invariants** before reading code (confirmed by a source, or proposed and put to the developer, because the reviewer never invents a product rule), then reviews every write path against them across the lifecycle, state transitions, ownership, authorization (can ownership and authority diverge, elevation paths), tenancy (self, child, parent, peer, platform, system), concurrency, audit data, cross-service dependents, similar features, UX and operations. `check_entity_impact` searches the whole platform, not just the diff, for ownership, admin, role and status checks, `tenant.email` and `defaultUser` coupling, audit fields, write paths, caches, events and jobs. Findings carry a severity (CRITICAL to LOW), root cause, business and long-term impact, reproduction and fix; critical and high findings backed by facts block, suspicions become questions, and the story is approved only when the invariants, lifecycle, authorization, tenancy, audit data, operations, future behavior and platform assumptions all hold.

**Review maturity: confidence, decisions, invariants.** A review that finds nothing is not a review that can be trusted. `score_review_confidence` turns the evidence the review actually has (invariants confirmed vs inferred, cross-service scan, test evidence, database constraints examined, concurrency / lifecycle / authority coverage, UNVERIFIED and REQUIRES_DECISION counts) into **HIGH / MEDIUM / LOW**, with hard caps: a stale review or a pessimistic story with no cross-service scan is LOW, an open decision caps at MEDIUM. `check_decision_alignment` searches the decisions the project already made (`.mcp/decisions/`, and read-only the earlier work records) and shows which ones the change touches, with signals; the reviewer answers ALIGNS / VIOLATES / PARTIALLY ALIGNS / UNVERIFIED. `get_relevant_invariants` retrieves the invariant catalog (`.mcp/invariants/`) for the change, classified from status plus real enforcement evidence. The server suggests; a person confirms: nothing is recorded as accepted without the user's own words.

**Calibration against a client review.** `build_feature_model` builds the review's understanding before any diff is judged, and `calibrate_review` measures whether the review would have written the client's comments: concerns are sealed (and hashed) first, the client's comments are revealed afterwards, and the report counts derived, partial and missed. A review that has already seen the answers must say so; the figure is then an upper bound.

**Three evidence helpers sharpen the pessimistic mode.** `check_entity_impact` takes `flags` (fields that identify ownership or status, like `defaultUser`) and flags every use of one next to an authorization decision as **authority coupling**, then ranks the consumers **Critical / Medium / Low** (a rule copied across services appears once with its copies listed, because copies drift). `check_invariant_enforcement` rates the field behind an "exactly one" or "never zero" invariant as `DB_ENFORCED`, `LOCK_PROTECTED`, `CHECK_THEN_ACT` or `CODE_ONLY`, per writing method, so a check-then-act race (two owners, zero owners) is named with its write sites instead of guessed. And **a review covers only the code it saw**: when the verdict is APPROVED the server records a hash of every changed file; a file that changes afterwards makes the review **stale**, `spec_status` says so, and `manage_task complete` is refused until the delta is reviewed and a fresh verdict is recorded. Committing the reviewed work never makes it stale.

**The reviewer is not a maintainer.** It detects, explains and reports. It never deletes or restores code, removes methods, chooses develop (or any branch) automatically, or rewrites files without a request. When it is unsure it reports a **DEVELOPER DECISION REQUIRED** with its evidence and rationale, and the developer decides. A missing method is a *possible merge regression*, never "dead code".

The governance rule carries over from the knowledge layer: **the reviewer never invents a product rule.** Every product finding names its `Source` and its `Basis` (`FACT`, `INFERENCE`, `ASSUMPTION`, `UNKNOWN`). Only a `FACT` can block; an `INFERENCE` is a question; a rule nobody recorded is reported as **UNVERIFIED** and listed under *Knowledge gaps*, with an offer to record the answer in `.mcp/` so the next review does not have to ask. Maintainability alone never blocks.

`check_diff_quality` measures the diff that **would be committed** (respecting `core.autocrlf` and `.gitattributes`) against the real change and explains the gap:

| Finding | Meaning |
|---|---|
| `LINE_ENDING_CHANGE` | Line endings flipped; churn far larger than the real change |
| `MIXED_LINE_ENDINGS` | CRLF and LF in one file (introduced by this change vs already there) |
| `WHITESPACE_CHURN`, `FORMAT_REWRITE`, `REORDERING` | Re-indentation, re-wrapped code with the same tokens, or the same lines in a different order |
| `ENCODING_CHANGE`, `EOF_NEWLINE_CHANGE`, `FILE_MODE_CHANGE` | BOM / encoding, final newline, executable bit |
| `SHEBANG_WITH_CRLF` | A script with a shebang saved as CRLF: a real defect |
| `CONFIG_DISAGREES_WITH_FILE_HISTORY`, `CONVENTION_SOURCES_DISAGREE` | The repository's own settings conflict with its files, or with each other. Reported, never silently resolved |

**"When in Rome, do as the Romans do."** The existing file and repository style is the expected style. Consistent CRLF is not a defect; consistent LF is not a defect. Mixed endings, unexplained churn and deviation from convention are. The reviewer never demands normalization to its own taste, and recommends it only when there is evidence it is required. The convention is read from `.gitattributes`, `.editorconfig`, prettier/eslint config, then the file's own history, then its tracked siblings; if those disagree, the conflict is reported.

When a file needs restoring, `normalize_line_endings` converts it back to **its own** style, changing only line terminators. It previews by default and writes only with your confirmation.

Generated, vendor, binary and lock files are excluded, files over 2 MB are skipped and reported, and outside a git repository the check says it cannot measure churn.

---

## Knowledge Management

The MCP must not turn its own assumptions into architectural truth. Every piece of project knowledge carries its trust level and its origin.

| Status | Meaning | How agents treat it |
|---|---|---|
| **`proposed`** | Recorded, not yet reviewed by a person | Shown and labelled *unreviewed*. A hint to look harder; never grounds for a blocker |
| **`accepted`** | A person confirmed it is true | Authoritative. An accepted exception is not flagged as a defect; a change that contradicts an accepted decision is a finding |
| **`superseded`** | Replaced by a newer entry | Hidden from retrieval unless asked for |
| **`deprecated`** | No longer applies | Hidden from retrieval unless asked for |

- **Source is mandatory.** Every entry says where it came from (ticket, PR, incident, person, file). Knowledge without provenance is refused.
- **An agent cannot accept its own claim.** Recording as `proposed` is the default; `accepted` requires your words (`user_statement`). `set_knowledge_status` accepts, deprecates or supersedes an existing entry.
- **No match is not "nothing intentional".** If retrieval finds nothing, it says nothing is *recorded*, and invites you to record what you discover.
- **Knowledge is easy to add** (see [Contributing knowledge](#contributing-knowledge)) and **validated** when loaded.

### How project knowledge is preserved over time

Knowledge that is recorded but not kept alive rots. The design makes it durable:

- **It lives in git.** Entries have history, blame and pull-request review, exactly like code. A wrong entry is a reviewable diff, not a lost conversation.
- **Supersede, don't rewrite history.** A changed decision is a new entry that `supersedes` the old one. The old entry is marked superseded and stays readable, so the reasoning chain survives.
- **Trust and origin travel with the text.** Every entry keeps its `status`, `source` and `date`, so a future reader knows how far to trust it and where to verify it.
- **Rot is detected.** Loading validates the layer: dangling `supersedes`, duplicate ids, missing sources and unreviewed (`proposed`) entries are reported at `/sfn-init`.
- **It is used, which keeps it honest.** Relevant entries are pulled into `/sfn-spec` and `/sfn-review` automatically, so stale or wrong knowledge gets noticed by the people it affects.
- **History is versioned too.** Release notes and the snapshots they compare against live in `.mcp/release-history/`, so the evolution of the project is itself recorded.
- **It is independent of any tool.** Entries are plain markdown with frontmatter, readable without this MCP. A different MCP instance, a different AI tool or a new engineer can read them unchanged.
- **The agent file stays thin.** Because `AGENTS.md` holds only how to think, project history is never trapped in a prompt that can be replaced.

---

## Lessons Learned

Lessons from production incidents, reviews, investigations and historical discoveries are stored in `.mcp/lessons-learned/`, so the next engineer (or agent) does not pay for them again.

**Recorded today**

- **Device vs Machine terminology.** "Device" is a *browser installation*; "Machine" is a *physical endpoint*. Naming inconsistency is not automatically a bug. (Stored in `architecture/`, because it is also how the domain is modelled.)
- **Review diff-noise incident.** The 3-line change that became a 1,100-line diff (`lessons-learned/line-ending-diff-noise.md`).

**What belongs here as the project learns**

- Historical production findings, and root causes that were not obvious.
- Common false positives: things that look wrong and are intentional.
- Investigation outcomes: what was ruled out, and why.

A good lesson states what happened, what it taught, what to do differently, and the common way people misread it.

---

## Architectural Decisions

Important architectural decisions belong in `.mcp/adr/`, **not** in `AGENTS.md`. An ADR answers four questions:

1. **What decision was made?**
2. **Why was it made?**
3. **What alternatives were rejected?**
4. **What constraints existed?**

ADR ids are numbered automatically (`adr-0001-…`, `adr-0002-…`). When a decision changes, write a new ADR that `supersedes` the old one rather than editing history; the old entry is marked superseded and stays readable.

---

## Work-Item Identity

A ticket reference such as `BUG-1230`, `TASK-1230`, `STORY-1230`, `FEATURE-1230` or `EPIC-1230` is metadata. It must read the same in Azure Boards, task folders, intent files, branches, commits and PRs.

- The type you give is preserved exactly. It is never replaced by a default ("task") and never overridden by the classification's `task_type`. If no type was given, none is invented.
- `resolve_work_item_ref` returns the canonical reference, folder name, branch suffix, commit prefix and PR-title prefix, to be used verbatim.
- Ticket numbers are unique, so registering a second type for the same number returns `IDENTITY CONFLICT` instead of silently changing it.

---

## What's New in 4.9.0

A minor release: three new tools (77 in all) and no breaking changes to commands or existing tools. `/sfn-review` gains three lanes that run in every review, a strict role boundary, and story-scope classification.

**Three lanes in every review** (each reported in its own section)
- **Merge regressions** (`check_merge_regressions`): functionality accidentally lost while a merge was resolved, found from the merge commit, both parents and the merge base, using git's three-way logic. Reported as POSSIBLE MERGE REGRESSION with severity HIGH / MEDIUM / LOW. It never changes approval unless a finding directly impacts an acceptance criterion.
- **Silent behavior changes** (`check_behavior_changes`): authorization, validation, query predicates, filtering, defaults, feature flags, conditionals and time calculations that moved while the code compiled and tests passed. Each real change becomes a BEHAVIOR CHANGE block (old and new behavior, affected users, acceptance-criteria impact, risk, intent explicitly confirmed). Before "intent not confirmed" the reviewer must search the acceptance criteria, story text, ADRs, product decisions and the user's instructions; with the work item, the tool searches the first four and lists possible support. An unconfirmed HIGH change is an in-scope blocker, MEDIUM a warning.
- **Scope drift** (`check_scope_drift`): files classified as core, indirectly related or unrelated to the story; the unrelated ones become SCOPE DRIFT blocks with the recommendation to move them to a separate story or explain why they are included. **Report only: it never fails a review.**

**The reviewer is not a maintainer.** It detects, explains and reports; it never deletes or restores code, removes methods, chooses develop automatically or rewrites files without a request. When unsure it reports DEVELOPER DECISION REQUIRED with evidence and rationale.

**Review stays inside the story.** Every finding is Class A (in scope), B (adjacent) or C (future); only Class A decides the verdict. Files outside the plan are now scope drift, not blocking out-of-scope changes.

---

## What's New in 4.8.0

A minor release: no new tools and no breaking changes to commands or parameters.

**ADRs are design narratives, not database records**
- An ADR opens with `# ADR-NNNN: <Decision Title>` and a one-sentence summary, never with metadata. The required structure (Decision Snapshot, Executive Summary, Context, Problem Statement, Investigation Summary, Options Considered, Decision, Consequences, Verification, References) makes the first page answer: what problem, why it mattered, what was chosen, why.
- The machine metadata moves to a trailing `<!-- mcp:entry ... -->` comment, invisible when rendered. The loader reads both forms, so every existing entry keeps working; only ADRs use the trailing form.
- `record_project_knowledge` refuses an ADR that begins with metadata or lacks the structure, and lists what is missing. `set_knowledge_status` keeps the readable **Status** line in the Decision Snapshot in step with the recorded status.

**Device vs Machine is recorded by default**
- `/sfn-init` calls `load_project_knowledge(seed_defaults: true)`, which records the MCP-shipped Device vs Machine terminology into `.mcp/architecture/` as a `proposed` entry with its source. It is skipped when the project already records an equivalent entry, never overwrites or demotes an accepted one, and needs `.mcp/` to exist.

---

## What's New in 4.7.0

A minor release: one new tool (`generate_pr_summary`, 74 tools in all) and no breaking changes to commands or parameters.

**The PR summary is an engineering change summary, not a file list**
- `pr-summary.md` used to be built from four lists (acceptance criteria, files, decisions, test scenarios). It now has twelve sections that a reviewer who has never seen the work item can follow: the problem, how it was investigated, the root cause, the options evaluated, why the design was selected, how it works, the issues resolved, behavior before and after (including multi-instance behavior), tests executed and results, remaining risks and release considerations, business impact, and the files changed last, as a reference.
- It is assembled from recorded state (requirement facts and root cause, the options put to the user, the plan, decisions with rationale, scenarios, recorded test runs, the gate ledger and review verdict). What the record lacks says **Not recorded**; nothing is invented.
- `generate_pr_summary` accepts a `narrative` for what only the author knows (options weighed and why each was accepted or rejected, behavior before and after, tests actually run, remaining risks, business impact). It is saved beside the task (`pr-narrative.json`), shown as **Author notes**, and kept when `manage_task action=complete` re-renders the summary.
- `/sfn-review` writes the summary before completing a task. `pr-summary.md` has a new layout, so anything that parses its old headings needs updating.

**The philosophy gate shows its evidence**
- The verdict has a new `reasoning` field: points that each name the service, topic, entity, golden rule or rejected pattern they rest on. It is required for `ADVISORY`, `FAIL` and `BLOCKED` (optional for `PASS`) and shown in the gate's report.

---

## What's New in 4.6.0

A minor release: no breaking changes, no new tools. It extends the documents `/sfn-review` offers after an approved review.

**The post-review documents** (offered as option A, each only when it applies, in this order)
- **ADO comment** and **PR description**, as before (`ado-comment.draft.md`, `pr-comment.draft.md` in the task folder).
- **ADR**, when the work made an architecture decision. It is recorded once in `.mcp/adr/` through `record_project_knowledge` (saved `proposed`), after searching for an existing one; a changed decision supersedes it instead of forking a copy.
- **Design investigation record** (`investigation.draft.md`), new. A permanent document for a future engineer who was not involved: the problem discovered, how it was investigated, assumptions proven wrong, the requirements that followed, the original architecture, failure scenarios, the analyses actually performed, the options evaluated and why each was accepted or rejected, the final architecture and its rationale, remaining risks and release blockers.
- The investigation record never duplicates the PR summary or the ADR (it links to them), is built only from recorded evidence (anything not captured is written as "not recorded"), and follows the placement rule if a repository path is requested.

---

## What's New in 4.5.0

A minor release: no breaking changes, no new tools. It adds a rule to the shared agent instructions so that every document has exactly one home.

**Artifact placement, one home per document** (in `AGENTS.md`; `/sfn-spec`, `/sfn-code` and `/sfn-review` point at it)
- **Knowledge** (ADRs, lessons learned, known exceptions, patterns, operational constraints) lives in `.mcp/` through `record_project_knowledge`, saved `proposed`. **Work-item artifacts** (spec, review notes, PR summary, ADO comment, investigation record, test-run notes) live in `.secufusion/tasks/<ref-folder>/`. **Repository files** are only the source, tests and migrations the specification lists; documents, configuration, CI and environment files need an explicit instruction.
- **Search before you create.** If a document already covers the decision, update it in place; a changed decision becomes a new entry with `supersedes`, never a forked copy. A decision is stated in full in one place and linked everywhere else.
- **Never write a file an MCP tool generates** (`spec.md`, `pr-summary.md`, `spec.json`, `decisions.json`, `progress.json`, `files-touched.json`, `scenarios.json`). Hand-written task documents carry a `.draft` suffix.
- **When a path does not name a repo** (the workspace has several, or its root is not one), the agent asks instead of choosing. On a move or rename it updates every reference and reports that none of the old path is left.
- **Every write is announced** (`path | home | why | new or overwrite`), every file is logged with `log_file_touched` so the PR summary is complete, and a turn that created files ends with `path | home | committed? | referenced by`.

---

## What's New in 4.4.0

A minor release: no breaking changes, no new tools. `/sfn-review` now reviews against what was **agreed to be built** as well as against the product.

**Spec-aware review**
- Before it reads the code, the review loads the specification the change was built against: gates passed (`spec_status`), the Implementation Specification (`spec.md`), requirement, plan, intent and recorded decisions. With no work item given it looks for one (branch name, recent commits, task search) and offers the match; with no specification it says so and never invents one.
- PASS 6 now checks conformance to the whole specification, not only the acceptance criteria: files outside scope (`6C`), recorded decisions (`6D`; a contradicted user decision is a BLOCKER), assumptions the spec carried that the code now treats as settled (`6E`), and whether the spec's root cause and impacted services are supported by the code.
- It also asks whether **the specification itself** contradicts recorded product knowledge. A spec can be followed perfectly and still be wrong for the product.

**Experience-aware review**
- Lessons from earlier tasks (`get_engineering_experience`) are now read by the review. Before this release they were recorded but never consulted. They are the lowest-trust memory: a hint about where to look, never a rule, and never able to override a current `.mcp/` entry.

**Three memories, three authorities.** Product knowledge is fact about the product; the specification is fact about intent; engineering experience is a hint. The report names the specification reviewed and the experience consulted.

---

## What's New in 4.3.0

A minor release: no breaking changes, no new tools. It fixes a gap in the release file that `/sfn-init` writes.

**The release file now says what the new MCP version brings**
- `v<version>.md` used to describe only what changed in the project (services, topics, rules, migrations). It now also has a **What this MCP version brings** section right after the Executive Summary: the summary, added, changed, fixed, breaking changes and new tools of **every MCP version after the project's previous one, up to the new one**, newest first. A team that skips versions still sees everything it missed.
- The information comes from `release-notes/vX.Y.Z.md`, shipped in the package for 4.0.0, 4.1.0, 4.2.0 and 4.3.0. If a version has no bundled notes, the file says so instead of omitting the section.
- A release cannot be cut without it: a test fails if `release-notes/v<package version>.md` is missing or has an empty section.
- `generate_release_notes` has an optional `mcp_release_info` (default true) to switch the section off.

---

## What's New in 4.2.0

A minor release: no breaking changes, no new tools. It rewrites one command, `/sfn-review`, so that it reviews the **product** and not only the code.

**`/sfn-review` is now a standalone, product-aware review engine**
- **Builds its own context.** Step 0 assembles a Product Knowledge Brief from `.mcp/`, the project spec, the DNA graph and, failing that, the source itself. It needs no earlier session and accepts a work item (`BUG-1230` stays `BUG-1230`), file, folder, service or git diff.
- **Eight review dimensions:** code quality, product behavior and feature contracts, service boundaries, deployment model, tenant hierarchy, privacy, operational resilience and future maintainability. PASS 0 to 10 are unchanged; PASS 11 to 18 are new.
- **PASS 11, Product & Privacy Fit:** answers five questions with evidence (does it match actual product behavior, will it work in the production deployment model, does it subtly break the tenant hierarchy, will it be hard to maintain in six months, does it violate the privacy model) as `FITS`, `DOES NOT FIT`, `CONCERN` or `UNVERIFIED`.
- **An investigation, not a checklist.** The reviewer models the change and its blast radius, forms specific hypotheses about how it could harm the product, investigates each until it is confirmed or dismissed, and shows the trail in a *Reasoning trace*. The passes are lenses, reported as `NOT APPLICABLE` when they do not apply, and findings the lenses miss are still reported.
- **It never invents product rules.** Every product finding states a `Source` and a `Basis`; only a `FACT` can block; a rule nobody recorded is **UNVERIFIED** and listed under *Knowledge gaps* with an offer to record it in `.mcp/`. Maintainability alone never blocks.
- **New report sections:** Product knowledge used, Review dimensions, Product & privacy fit, Reasoning trace, Knowledge gaps.

**Also in this release**
- The repository's `.agents/reviewer.md` is re-aligned with the shipped persona, which now describes the investigative method.
- Seven documentation tests pin the review contract (every pass 0 to 18 once and in order, the five questions, the evidence rule, the report sections).

**Note.** These are instructions the model follows, so how well the product dimensions answer depends on what the project has recorded in `.mcp/`. Until the tenant hierarchy, privacy model and deployment model are written down there, expect `UNVERIFIED` answers and questions to the developer. Recording them is the quickest way to improve reviews.

---

## What's New in 4.1.0

A minor release: no breaking changes. It adds the first three roadmap items, presents DNA and Project Intelligence as one Unified Project Knowledge System, and fixes defects found by running 4.0.0 on a real repository.

**Unified Project Knowledge System** (DNA = *what exists*, Project Intelligence = *why it exists*)
- `load_project_knowledge` (and so `/sfn-init`) now prints both layers side by side: DNA counts from `.secufusion/dna.json` (services, APIs, topics, domain classes, tables, frontend) next to the `.mcp/` entry counts. If either layer is missing, it says which and what to run.
- The README, `/sfn-init`, the agent router and the generated `.mcp/README.md` all describe the same model. DNA is regenerable from code; Project Intelligence is not, which is why it must be recorded.

**Project Intelligence health report** (`get_knowledge_health`, also shown by `/sfn-init`)
- Coverage is **documented vs discovered entities**, per dimension: services, topics, golden rules, domain concepts and platform decisions, discovered from the project spec. An entity is *documented* when an `accepted` entry names it, *proposed-only* when only unreviewed entries do, and *undocumented* otherwise. It is a ratio of counts with the definition printed beside it, never a score.
- Anomalies the spec exposes (a topic nobody consumes, a table owned by four services, an unresolved `CONFLICT`, a manual-review flag) are listed as **known-exception candidates**. They are unconfirmed and are not part of the coverage line.
- It also lists **tribal-knowledge candidates**: project-specific sections still inside the agent file. Names that exist only in the knowledge graph (duplicates, code constants) are shown as *unreconciled*, not counted.

**Starter templates and opt-in auto-scaffold**
- Scaffolding now writes one template per category to `.mcp/templates/` (each says what a good entry of that kind answers) and never overwrites a customised one.
- When `.mcp/` is missing, `/sfn-init` explains why it matters. Creating it automatically is **off by default**; enable it with `_meta.auto_scaffold_knowledge: true` in the project spec or `SECUFUSION_AUTO_SCAFFOLD=1`. Scaffolding creates structure only, never knowledge.

**Knowledge suggestion engine** (`suggest_project_knowledge`)
- Lookups through `get_project_knowledge` and `investigate_entity` are remembered locally (`.secufusion/knowledge-lookups.json`, not committed). A topic looked up three or more times without accepted knowledge answering it triggers *"Repeated investigation detected. Consider recording this as project knowledge"*, and clears once accepted knowledge exists.
- Suggestions cite their evidence and give a prefilled `record_project_knowledge` call **without a body**: only verified content gets recorded. Similar anomalies are grouped (40 tables owned by several services is one question, not 40).

**Knowledge governance**
- Tribal-knowledge detection now scans **every** agent-facing file (`AGENTS.md`, `CLAUDE.md`, `.agents/`, skill-bundled copies), not only the first one found, and reports a section copied into several files once. Any agent file over 250 lines gets a warning.
- The first real migration followed the intended model: a terminology section (*Device vs Machine*) moved out of an `AGENTS.md` into `.mcp/architecture/` **verbatim**, with the original section replaced by a pointer, the source noted, and a backup taken first. `AGENTS.md` stays about behaviour, workflow and engineering philosophy.
- The repository's own `.agents/` persona files had drifted from the shipped plugin copies (they lacked the work-item identity rule and the `/sfn-code` step); they are re-aligned, and a test now fails if they diverge again.

**Fixes found by the first real run**
- The server reported version `1.0.0` to MCP clients regardless of the release. It now reports the package version.
- Release notes now read the migrations format this MCP itself writes (`microservices`); before, migration changes were invisible and a release could say "no migration changed" when two services had moved. When one side has no migration or graph data, the notes say **"Not compared"** instead.
- Scans rewrote `.secufusion-migrations.json` and destroyed its previous state. A scan now keeps a timestamped backup when the file changes and preserves its line endings. `/sfn-init` backs up the spec and migrations before scanning and passes `previous_migrations_path`.
- `scan_repository_stack` only looked at the workspace root and reported "Node.js" for a Spring Boot ecosystem; it now inspects service folders.
- Snapshot tables drop an all-empty language column; paths in tool output use forward slashes.

**New tools (2):** `get_knowledge_health`, `suggest_project_knowledge`.

---

## What's New in 4.0.0

4.0.0 is a breaking release. The changes since 3.3.1:

**Workflow**
- `/sfn-explore` and `/sfn-plan` are replaced by one command, **`/sfn-spec`**. The workflow is `init → spec → code → review`. The architecture map now comes from `/sfn-init`; blast radius is part of `/sfn-spec` (`calculate_blast_radius`).
- `/sfn-spec` ends in a generated **Implementation Specification** (`generate_spec_document`); `/sfn-code` refuses to start without it.
- **Hard gates** (`philosophy → intent → classification → requirement → plan → review`) are enforced by the server. Judgment calls are recorded as validated verdicts, and decisions only a person can make stop the work until they answer.

**Project Intelligence Layer**
- Project knowledge lives in the repository under `.mcp/` (`load_project_knowledge`, `get_project_knowledge`, `record_project_knowledge`, `set_knowledge_status`), with `proposed` vs `accepted` trust and a mandatory source. *Device vs Machine* is the first entry migrated out of `AGENTS.md`.
- Release notes are **change-driven** (`generate_release_notes`): delta first, snapshot second, written to `.mcp/release-history/`.

**Review**
- `/sfn-review` PASS 10 (`check_diff_quality`): line-ending conversions, mixed endings, whitespace and formatting rewrites, reordering, encoding changes, files outside the specification. A HIGH finding blocks approval. `normalize_line_endings` restores a file to its own style.

**Correctness and hygiene**
- **Ticket identity is preserved** (`BUG-1230` stays `BUG-1230`) in folders, intent files and the names the agent uses; `resolve_work_item_ref` provides them.
- Interactive exploration with static, clearly-marked UI references (`manage_exploration`, `get_design_context`, `discover_ui_patterns`, `generate_static_ui_reference`).
- The package no longer ships `scripts/.secufusion-*.json` or developer benchmark scripts.

**New tools (15, none removed):** `check_diff_quality`, `discover_ui_patterns`, `generate_release_notes`, `generate_spec_document`, `generate_static_ui_reference`, `get_design_context`, `get_project_knowledge`, `load_project_knowledge`, `manage_exploration`, `normalize_line_endings`, `record_project_knowledge`, `resolve_work_item_ref`, `set_knowledge_status`, `spec_status`, `verify_against_spec`.

---

## Upgrading from 3.x

**What breaks**
- `/sfn-explore` and `/sfn-plan` no longer exist. Use `/sfn-spec`.
- Tools now refuse out-of-order calls (`⛔ SPEC GATE`). Requirements, plans and tasks created under 3.x have **no gate ledger**, so they must pass the gates again (`spec_status <ref>` shows what is missing) before they can be planned, verified or completed.
- `manage_requirement` will not set `CONFIRMED` without a UI-impact assessment and a fresh READY assessment.
- `philosophy_check`, `classify_task` and the other judged tools answer `🧠 JUDGMENT REQUIRED` in clients without MCP sampling; call the tool again with your `judgment`.
- Task folders and intent files use the ticket's exact reference (`BUG-1230-…`, `0001-BUG-1230-…`). Folders and intents written by 3.x (`Task-1230-…`, `0001-WI-…`) are still found.
- `verify_against_spec` will not return `APPROVED` while a HIGH diff-quality finding is unaccepted.

**How to upgrade**

```bash
npm install -g secufusion-mcp@latest          # the package (the plugin's server)
claude plugin marketplace update <marketplace> # refresh the marketplace entry
claude plugin update secufusion-mcp@<marketplace>
# then restart Claude Code
```

If your plugin is installed from a local marketplace that points at the global npm install, update the global package first (the marketplace then tracks it). A running session keeps the old server until it is restarted.

To adopt the new knowledge model in an existing project, run `/sfn-init`; it offers to scaffold `.mcp/`, and warns if your `agents.md` has grown into a knowledge dump.

---

## Getting Started

**Requirements:** Node.js ≥ 18, and an MCP-capable client (Claude Code / Claude Desktop, Cursor, Cline, …).

### As a Claude plugin

The plugin manifest is in `secufusion-mcp/.claude-plugin/plugin.json` and the server is wired in `.mcp.json` (`node ${CLAUDE_PLUGIN_ROOT}/mcp/dist/server.js --root .`), so the server reads whichever repository the session is in. The four commands (`/sfn-init`, `/sfn-spec`, `/sfn-code`, `/sfn-review`), the agent personas and a session-start knowledge-drift hook ship with the plugin.

### From source

```bash
cd secufusion-mcp
npm install
npm run build
```

Then register the server with your MCP client:

```json
{
  "mcpServers": {
    "secufusion-mcp": {
      "command": "node",
      "args": ["<absolute path>/secufusion-mcp/mcp/dist/server.js", "--root", "<your project>"],
      "type": "stdio"
    }
  }
}
```

A published package is also available: `npx -y secufusion-mcp` or `npm install -g secufusion-mcp` (current version **4.1.0**; see [Upgrading from 3.x](#upgrading-from-3x) if you are on an older release).

### First run

```
/sfn-init                      # build project understanding (scaffolds .mcp/ if you want it)
/sfn-spec BUG-1230 <summary>   # investigate and design; answer the decisions it asks you
/sfn-code BUG-1230             # implement the approved specification
/sfn-review BUG-1230           # verify the change and the diff
```

---

## New Contributor Guide

1. **Clone the repository** and open it in your MCP-enabled client.
2. **Run initialization:** `/sfn-init`. It builds or merges the project spec and knowledge graph.
3. **Load project intelligence.** `/sfn-init` runs `load_project_knowledge`; read the index it prints. If `.mcp/` is missing it offers to scaffold it.
4. **Read the relevant architecture knowledge** in `.mcp/architecture/` for the area you will touch, and the terminology entries first.
5. **Review the ADRs** in `.mcp/adr/` to learn which decisions are deliberate and why.
6. **Generate a specification:** `/sfn-spec <TICKET-REF>`. Answer the decisions it puts to you; review any reference design; approve `spec.md`.
7. **Implement:** `/sfn-code <TICKET-REF>`. Stay inside the specification and the file's existing style.
8. **Run the review workflow:** `/sfn-review <TICKET-REF>`. Fix findings, including diff-quality ones, until it is approved.
9. **Update project knowledge if you discovered something new:** a trap, an exception, a decision, a lesson. Record it (below). Do this *before* you forget.
10. **Generate release notes when applicable:** when the spec version changes, `/sfn-init` produces the change-driven notes; add the `why` and any fixes only you know.

---

## Contributing Knowledge

Knowledge is only valuable if it is easy to add and stays with the repository. Contribute whenever you find:

- a **new architectural discovery** (who really owns a table, what a topic's real topology is)
- a **historical finding** or the root cause of an incident
- a **known exception**: something intentional that looks wrong
- a **review lesson** or a common false positive
- a **terminology correction**
- a **design decision** and the alternatives you rejected

**Two ways to add it:**

1. Ask the agent: it calls `record_project_knowledge` with a category, title, body, tags, `applies_to` and a mandatory `source`. It is saved as `proposed`.
2. Copy the entry template from `.mcp/README.md` into the right folder.

Then **commit it with the code**. A reviewer (a person) marks it `accepted` by editing `status:` or via `set_knowledge_status`. Superseding an entry marks the old one superseded and keeps it readable.

Good entries say what is true, why, and **what must not be "fixed"**; cite `file:line` where possible; and use `applies_to` globs and terms so the entry surfaces when someone touches the relevant code.

`AGENTS.md` should stay lightweight. If it grows past a few hundred lines, `/sfn-init` warns you; move project-specific history, terminology and exceptions into `.mcp/`.

---

## Release Notes Philosophy

**Every `/sfn-init` release file also says what the new MCP version brings.** The MCP ships one release-notes file per version (`release-notes/vX.Y.Z.md`: summary, added, changed, fixed, breaking changes, new tools). `generate_release_notes` includes *What this MCP version brings* for every version between the project's previous MCP version and the new one, right after the Executive Summary, so a team that skipped versions sees everything it missed. A version cannot be released without that file: a test fails if `release-notes/v<package version>.md` is missing or incomplete.

**Delta first. Snapshot second.** A release is a changelog, not a repository scan. Release notes exist to answer a short list of questions, in this order:

1. **What changed?**
2. **What was added?**
3. **What was fixed?**
4. **What was removed?**
5. **What risks changed?**

They tell the story of the version (why it exists, what moved, why it matters) instead of dumping repository metadata. A reader should understand what changed within the first few sections; the current state of the repository comes last, for reference.


The most important question a reader has is *what changed in this release?* so notes lead with the delta from the previous version and put the state of the repository last.

`generate_release_notes` snapshots the recorded state (project spec, migrations, knowledge-graph counts), diffs it against the previous release's snapshot, and renders:

```
# Version X.Y.Z
## Executive Summary                 why the release exists + a quantified, itemised delta
## Added                             new rules, terminology, mappings, configuration
## Changed                           behavioural, topology, configuration changes
## Fixed                             resolved ambiguities and author-reported fixes
## Removed / Deprecated              services, topics, rules, mappings that no longer apply
## Risks                             introduced vs resolved
## Repository Intelligence Updates   new services, topics, relationships, table ownership
## Rule Changes                      added / modified (before → after) / removed / unchanged
## Detailed Snapshot                 optional, compact, last, labelled "not a list of changes"
```

- **Detected, not written.** Everything code can know is computed from the two snapshots. The author supplies only what code cannot (`why` the release exists, fixes, deprecations, discoveries); those appear as labelled *Author notes*. A missing rationale is shown as "not stated", never guessed.
- **Honest about nothing.** An unchanged release says *No significant changes since vX*, and empty sections say "None". A first release is a baseline and claims no delta.
- **One event, one place.** A fixed ambiguity appears once, not three times.
- **Quantified.** Section headings carry counts; the summary says *what* changed, not just how many things.
- **Version-controlled.** Notes and the snapshots they compare against are written to `.mcp/release-history/` when the layer exists.

---

## Tool Reference

The server exposes the tools below. Most workflow tools record state under `.secufusion/`. Tools that can write anywhere else (your source files or `.mcp/`) are marked **writes**, and each one is guarded: previewed by default, or gated on the user's own words. Detailed parameters are in each tool's description.

**Workflow and gates**

| Tool | Purpose |
|---|---|
| `philosophy_check` | WHY / WHO / WHAT / RISK check of a ticket before any planning (judged, recorded) |
| `spec_create_intent`, `spec_read_intent`, `spec_next_number` | The business intent (WHY layer) and its acceptance criteria |
| `classify_task` | Which layers a change touches and what it can break (judged; regex score is only a hint) |
| `manage_requirement` | The requirement lifecycle: facts, root cause, decisions, clarifications, assessment, `CONFIRMED` |
| `manage_exploration` | UI impact, questions only the user can answer, UI-reference feedback, exploration readiness |
| `manage_implementation_plan`, `validate_implementation_plan` | Create and validate the plan against the requirement (judged) |
| `generate_spec_document` | Assemble the Implementation Specification from recorded state |
| `generate_pr_summary` | Write `pr-summary.md` as an engineering change summary (problem, investigation, root cause, options, design, before/after, tests, risks, impact) from recorded state plus the author's narrative |
| `verify_against_spec` | Adversarial review verdict; blocked by unaccepted HIGH diff noise |
| `spec_status` | The gate ledger and the next step |
| `manage_task`, `get_task_history`, `search_tasks`, `get_pattern_from_task`, `record_retrospective` | Task records and cross-task memory |
| `resolve_work_item_ref` | Canonical identity strings for a ticket |
| `manage_project_spec`, `prime_session`, `log_rejected_pattern` | Project spec access, token-efficient session start, rejected patterns |

**Investigation and evidence**

| Tool | Purpose |
|---|---|
| `investigate_entity`, `investigate_relationship`, `query_knowledge_graph` | Query the repository evidence graph |
| `calculate_blast_radius`, `analyze_impact`, `score_change_risk`, `get_change_context` | Impact and risk of a change |
| `smart_search` | Search with context |
| `scan_repository_stack`, `extract_domain_models`, `extract_api_endpoints`, `extract_event_topics`, `refresh_repository_knowledge` | Build the knowledge graph from the code |
| `discover_secufusion_workspace`, `inspect_workspace_repositories`, `get_workspace_status`, `get_evidence_completeness` | Workspace and evidence completeness |
| `start_dna_watcher`, `load_external_env_file` | Keep the graph fresh; load an external env file |

**Traceability and tests**

| Tool | Purpose |
|---|---|
| `create_traceability_link`, `trace_requirement`, `find_traceability_gaps` | Requirement → design → code → tests |
| `generate_test_obligations`, `suggest_test_scenarios` | What must be tested |
| `discover_tests`, `execute_tests`, `ingest_test_results`, `get_test_results`, `correlate_test_failure` | Run and correlate tests |

**Engineering experience**

| Tool | Purpose |
|---|---|
| `record_engineering_experience`, `get_engineering_experience`, `get_experience_context`, `validate_experience`, `find_experience_conflicts`, `find_repeated_outcomes`, `mark_experience_stale`, `retire_experience`, `link_experience`, `get_learning_feedback`, `skill_recommend` | Validated historical lessons linked to components, with staleness and conflict handling |

**UI design reference**

| Tool | Purpose |
|---|---|
| `get_design_context`, `discover_ui_patterns` | Existing frontend evidence |
| `generate_static_ui_reference` | A bounded, self-contained static HTML reference: `REFERENCE_ONLY`, `NOT_IMPLEMENTED`, no network or storage, never touches source (writes under `.secufusion/designs/`) |

**Review quality**

| Tool | Purpose |
|---|---|
| `check_diff_quality` | Deterministic diff-quality and line-ending findings (PASS 10) |
| `check_merge_regressions` | Functionality lost during a merge: methods, endpoints, queries, security checks, tests, config, translations (own report lane) |
| `check_behavior_changes` | Evidence of silent behavior changes: authorization, validation, predicates, filters, defaults, flags, conditionals, time calculations |
| `check_scope_drift` | Classify changed files as core, indirectly related or unrelated to the story; report only |
| `check_entity_impact` | Platform-wide inventory of what depends on an entity (ownership, admin, role, status checks, audit fields, write paths, caches, events, jobs), with authority coupling flagged and consumers ranked Critical / Medium / Low, for the pessimistic review |
| `check_invariant_enforcement` | How the field behind an invariant is protected: database constraint, lock per writing method, or only a check before the write (zombie-state risk) |
| `get_relevant_invariants` | Invariant catalog lookup: the recorded invariants relevant to this change, each CONFIRMED / PROPOSED / VIOLATED / NOT DEMONSTRATED with source, write paths and enforcement type; candidates are suggestions only |
| `check_decision_alignment` | Decision registry check: recorded decisions (UD-n) this change touches, with signals (guardrail removed, new writer, unconfirmed assumption); the reviewer judges ALIGNS / VIOLATES / PARTIALLY ALIGNS / UNVERIFIED |
| `build_feature_model` | The feature model before the diff: work item family, entities, lifecycle transitions that exist (with file:line, and whether each method mentions the flag), transitions with no path, capability dependencies, cross-service graph, and a transition-by-contract review matrix |
| `build_field_impact` | Field impact model: every consumer of a field across the workspace (read or write), classified as authority, API, UI, persistence, event, audit, report or logic, with the question that turns each dependency into a business consequence |
| `calibrate_review` | Client-parity calibration with a blind protocol: seal your derived concerns, then reveal the client's comments; reports derived / partial / missed, blocking recall and extras |
| `score_review_confidence` | HIGH / MEDIUM / LOW confidence from the evidence the review has, with hard caps (stale review, no cross-service scan, open decisions); separates "no findings" from "trustworthy" |
| `normalize_line_endings` | Convert a file back to its own style (preview by default; **writes** only with `apply` and the user's words) |

**Project intelligence and releases**

| Tool | Purpose |
|---|---|
| `load_project_knowledge` | Build the memory model from `.mcp/` (**writes** only with `scaffold`) |
| `get_project_knowledge` | Knowledge that applies to the terms and files you give |
| `record_project_knowledge`, `set_knowledge_status` | **Write** one entry / change an entry's status (the latter requires the user's words) |
| `get_knowledge_health` | Documented vs discovered entities per dimension, gaps, tribal-knowledge candidates |
| `suggest_project_knowledge` | Evidence-backed suggestions for knowledge worth recording (creates nothing) |
| `generate_release_notes` | Change-driven release notes and snapshot (**writes** unless `dry_run`) |

---

## Repository Layout and Where State Lives

```
.
├── .mcp/                         the Project Intelligence Layer (commit this)
├── .agents/                      agent instructions for this repository (being slimmed as knowledge moves to .mcp/)
├── .secufusion-project-spec.json project DNA: services, topics, rules, patterns
├── .secufusion/                  working state (see below)
└── secufusion-mcp/               the plugin and server
    ├── .claude-plugin/ .mcp.json plugin manifest and server wiring
    ├── commands/                 sfn-init, sfn-spec, sfn-code, sfn-review
    ├── agents/                   planner, coder, reviewer personas and the workflow router
    ├── hooks/                    session-start knowledge-drift hook
    ├── mcp/src/                  the server (TypeScript) → mcp/dist
    └── tests/                    end-to-end and documentation-consistency tests
```

| Location | What | Commit? |
|---|---|---|
| `.mcp/` | Project-owned knowledge and release history | **Yes, always** |
| `.secufusion-project-spec.json`, `.secufusion-migrations.json` | Project DNA and migration state | Yes |
| `.secufusion/requirements`, `plans`, `tasks`, `judgments`, `gates`, `designs` | The audit trail of how each change was specified, judged and approved | Your choice. Commit it if you want that audit trail |
| `.secufusion/dna.json`, `registry.json`, caches | Regenerable working state | Usually no |
| `.secufusion-tokens.json` | Local token accounting | No |

The server is organised as: `server.ts` (entry) · `shared.ts` (helpers) · `tools_*.ts` (one `register…` function per tool group) · pure libraries (`diff_quality`, `line_ending_fix`, `release_notes`, `project_knowledge`, `exploration`, `requirement_manager`, `work_item_ref`, `spec_document`, `judge`, `gates`, `verdicts`) that hold the logic so it can be tested without the protocol.

---

## Development

```bash
cd secufusion-mcp
npm install
npm run build        # tsc → mcp/dist
npm test             # build + 12 suites
```

`npm test` runs deterministic benchmarks (state machines, diff quality against real temporary git repositories, work-item identity, release notes, project knowledge) and end-to-end suites that drive the real server over stdio (full lifecycle, exploration, identity, release, knowledge), plus a **documentation-consistency test** that fails if a command or agent document references a tool that does not exist, or if the README's tool reference drifts from the server.

Conventions for contributors:

- **Logic goes in a pure library with tests; the tool is a thin wrapper.** Tests use real temporary git repositories and the real server, not mocks.
- **The documents are the product's interface to the model.** When behaviour changes, update the command or agent document in the same change, and keep the README honest.
- **Preserve the file's existing style and line endings.** Run `/sfn-review` on your own change; it checks its own diff.
- **No tool writes without a guard.** Writes are previewed by default or require the user's own words.

---

## Status and Known Limitations

- **Judgments depend on the model.** In clients without MCP sampling, the model that did the work also judges it. Schemas force evidence, but for an independent review use a sampling-capable client or review in a separate session.
- **`user_statement` cannot prove a quote is genuine.** It stops silent self-approval; review the transcript for destructive decisions.
- **Retrieval is keyword and glob based, not semantic.** A differently worded ticket can miss a relevant entry. "No match" means "nothing recorded".
- **`autocrlf` hides history.** With `core.autocrlf=true` git stores the normalized form, so a file that was mixed on disk before cannot be seen as mixed at base; pre-existing mixed files may be reported as introduced.
- **Gate ledgers are keyed by the reference string.** `BUG-1230` and `1230` have separate ledgers; always pass the reference exactly as written.
- **Migration of project knowledge out of `AGENTS.md` is gradual.** Device vs Machine is migrated; other project-specific sections (migration guardrails, platform and service architecture) are candidates.
- **Phase 7 regression functions** exist as library code but are not exposed as tools; regression context is assembled from blast radius, traceability gaps, experience and test results.
- **Licence:** ISC (see `package.json`).

---

## Roadmap: Next Evolution of the Project Intelligence Layer

The layer has been implemented and validated in a real repository run. That first run produced seven evolution areas. They are future work, recorded here (and as a proposed ADR in `.mcp/adr/`) so the plan travels with the project. "Status" is checked against the code, not aspirational.

| # | Area | Status today | What exists | What is missing |
|---|---|---|---|---|
| 1 | **Auto-scaffold** project intelligence | **Done in 4.1.0** | Missing `.mcp/` is detected and explained; `scaffold=true` creates folders, README and a template per category; auto-creation is opt-in (`_meta.auto_scaffold_knowledge` or `SECUFUSION_AUTO_SCAFFOLD=1`), off by default | Example entries seeded from the project (deliberately not done: scaffolding never invents knowledge) |
| 2 | **Knowledge suggestion engine** | **Done in 4.1.0 (first form)** | Lookups are remembered locally; repeated investigation without accepted knowledge triggers the nudge and a prefilled suggestion; undocumented entities, anomalies and tribal sections are suggested with evidence | Learning from review findings and incident write-ups, which the server does not see today |
| 3 | **Project intelligence health report** | **Done in 4.1.0** | Coverage as documented vs discovered entities (definition printed), gaps, known-exception candidates, tribal-knowledge candidates, repeatedly investigated areas | Trend over time (is coverage improving?) |
| 4 | **Semantic retrieval** | Not started | Keyword, tag and path-glob matching with generic-word filtering; `applies_to` lets authors add terms by hand | Conceptual matches (*endpoint* → *machine*, *browser installation* → *device*, *tenant authorization* → *impersonation*) without exact wording |
| 5 | **Release intelligence** | Partial | Notes are change-driven: services, topics, rules, terminology, configuration, migrations and risks are diffed, with knowledge-graph node counts by type when both snapshots have a graph | Knowledge changes (new ADRs, patterns, exceptions, lessons) are not part of the delta; named counts such as *Domain Models 501 → 510* and *Controllers 82 → 84* come from extraction output and are not persisted, so they cannot be diffed yet (the graph's generic types are `CLASS`, `API`, …) |
| 6 | **Knowledge-aware reviewing** | Partial (model-mediated) | `verify_against_spec` receives the entries that apply to the changed files; the rubric and reviewer persona say an *accepted* exception is not a defect and a change contradicting an *accepted* decision is a finding | The deterministic checks (`check_diff_quality`, mechanical passes) do not consult knowledge; regression against accepted patterns is judged by the model, not detected |
| 7 | **Project-owned intelligence** | Structure in place | Knowledge lives in `.mcp/`, is version-controlled, is plain markdown, carries source and trust level, and is loaded by `/sfn-init` | Adoption: a fresh `.mcp/` is empty, so "clone, run `/sfn-init`, inherit years of decisions" only holds once the repository has recorded them. Items 1-3 are what close this gap |

**Suggested order, and why**

1. ~~Health report (3)~~, ~~auto-scaffold with templates (1)~~ and ~~suggestion engine (2)~~: done in 4.1.0.
2. **Release intelligence (5)**: persist extraction counts in the snapshot and add knowledge changes to the delta.
3. **Deterministic knowledge in review (6)**: let accepted exceptions annotate or downgrade the mechanical findings they explain, with the reason shown.
4. **Semantic retrieval (4)**: last, and in stages (see below), because it is the only item that cannot stay fully deterministic.

**Design constraints and open questions**

- *Coverage (3)* is defined and shown as documented vs discovered counts. A percentage with no stated definition would be exactly the unverified claim this project avoids.
- *Auto-scaffold (1)* creates structure and templates only. It must never invent knowledge; entries stay `proposed` until a person accepts them.
- *The suggestion engine (2)* needs somewhere to keep lookup history (local working state, not committed) and a threshold for "repeated".
- *Semantic retrieval (4)* options, in order of cost: explicit `aliases` in entry frontmatter (deterministic); query expansion by the client model when sampling is available (cached); embeddings (adds a dependency and non-determinism). The first is a natural start.
- *Everything stays honest:* a coverage score, a suggestion or a semantic match must say why it exists, and "no match" must never be presented as "nothing intentional."

---

## Long-Term Vision

The goal is a **self-documenting engineering ecosystem**: one where architecture decisions, lessons learned, implementation patterns, review findings and domain knowledge become **durable project assets** rather than things people remember.

That knowledge should survive:

- **Team changes**
- **Engineer turnover**
- **MCP instance replacement**
- **AI tooling changes**

When any of those happen, nothing needs to be re-explained: the project itself is the source of truth, and a new engineer or a new agent learns the system by reading it.

**Where this stands today.** The structure, validation, relevance-based retrieval, trust model, review integration and release history exist and are tested. Recording a discovery is still prompted by an engineer or the agent; nothing yet captures lessons automatically from every review or incident, and retrieval is keyword-based rather than semantic. Those are the gaps between the current system and the vision, and the Project Intelligence Layer is the foundation both would build on.

The intelligence of the project should travel with the project itself.

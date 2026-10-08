# SecuFusion MCP

A project-aware engineering assistant, delivered as a [Model Context Protocol](https://modelcontextprotocol.io) server and Claude plugin, built to behave like a disciplined senior engineer.

It does not just answer questions about your code. It runs a **workflow** (understand, specify, build, verify) with hard gates between the steps, keeps what the project has learned **inside the repository**, and refuses to let an assumption quietly become an architectural fact.

> **Agent remembers project → OLD.  Project teaches the agent → NEW.**

## Contents

1. [Core Philosophy](#core-philosophy)
2. [Why This Exists](#why-this-exists)
3. [Major Revamp: Project Intelligence Layer](#major-revamp-project-intelligence-layer)
4. [Project Intelligence Layer](#project-intelligence-layer)
5. [MCP Workflow](#mcp-workflow)
6. [Commands](#commands)
7. [How the MCP Thinks](#how-the-mcp-thinks)
8. [Review Philosophy](#review-philosophy)
9. [Knowledge Management](#knowledge-management)
10. [Lessons Learned](#lessons-learned)
11. [Architectural Decisions](#architectural-decisions)
12. [Work-Item Identity](#work-item-identity)
13. [Getting Started](#getting-started)
14. [New Contributor Guide](#new-contributor-guide)
15. [Contributing Knowledge](#contributing-knowledge)
16. [Release Notes Philosophy](#release-notes-philosophy)
17. [Tool Reference](#tool-reference)
18. [Repository Layout and Where State Lives](#repository-layout-and-where-state-lives)
19. [Development](#development)
20. [Status and Known Limitations](#status-and-known-limitations)
21. [Long-Term Vision](#long-term-vision)

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

Entries are validated on load: missing fields, a wrong folder, a bad status, duplicate ids, dangling `supersedes` and empty bodies are reported, never silently ignored.

**It is retrieved by relevance, not dumped.** `/sfn-init` builds a compact index of the whole layer; during a task, `get_project_knowledge` returns only the entries that apply, ranked by the ticket's terms, the files involved and tags, with the reason each matched. Generic words in a free-text ticket do not drag in unrelated entries.

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

A published package (`npx -y secufusion-mcp`) is also supported where it is available to your registry.

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
| `normalize_line_endings` | Convert a file back to its own style (preview by default; **writes** only with `apply` and the user's words) |

**Project intelligence and releases**

| Tool | Purpose |
|---|---|
| `load_project_knowledge` | Build the memory model from `.mcp/` (**writes** only with `scaffold`) |
| `get_project_knowledge` | Knowledge that applies to the terms and files you give |
| `record_project_knowledge`, `set_knowledge_status` | **Write** one entry / change an entry's status (the latter requires the user's words) |
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
npm test             # build + 11 suites
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

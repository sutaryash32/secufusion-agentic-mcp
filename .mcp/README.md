# Project Intelligence Layer

This folder is the project's own memory. It is version-controlled with the code so that any engineer,
reviewer or AI agent can understand **why** the system is the way it is, without tribal knowledge.

The code explains WHAT the system does. This folder explains:
WHY it was designed this way, WHICH decisions are intentional, WHICH patterns are preferred,
WHICH inconsistencies are legacy, WHICH behaviours must not change, WHICH mistakes were already
found, and WHICH assumptions are dangerous.

| Folder | Holds |
|---|---|
| `architecture/` | System design, service relationships, domain terminology, entity ownership, data flow |
| `adr/` | Architecture decisions: decision, rejected alternatives, reasoning, constraints, tradeoffs |
| `patterns/` | Coding conventions, API / Kafka / repository patterns, naming standards |
| `known-exceptions/` | Intentional inconsistencies, legacy constraints, accepted technical debt |
| `lessons-learned/` | Incidents, review findings, historical bugs, common false positives |
| `operational/` | Deployment constraints, migration knowledge, environment behaviour, risk areas |
| `release-history/` | Change-driven release notes and the snapshots they compare against |

`agents.md` (if present) stays lightweight: workflow rules and engineering philosophy only.

## Adding knowledge

Found a terminology trap, a decision, an exception, a lesson? Add one file. Either ask the agent
(`record_project_knowledge`) or copy this template into the right folder:

```markdown
---
id: "short-unique-id"
title: "Human readable title"
category: known-exceptions        # must match the folder
status: proposed                  # proposed | accepted | superseded | deprecated
tags: ["terminology", "device"]
applies_to: ["sfn-iam-api/**", "device"]   # path globs and/or terms; used to surface it when relevant
source: "Ticket / PR / incident / person: where this came from"
date: 2026-10-08
supersedes: []
---
What is true, and why. Say what must NOT be "fixed".
```

`proposed` entries are shown to agents but labelled unreviewed. A person marks an entry `accepted`
(by editing `status:` or via `set_knowledge_status`) once they agree it is true.

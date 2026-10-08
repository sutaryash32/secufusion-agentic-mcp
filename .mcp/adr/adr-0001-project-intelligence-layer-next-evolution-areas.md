---
id: "adr-0001-project-intelligence-layer-next-evolution-areas"
title: "Project Intelligence Layer: next evolution areas"
category: adr
status: proposed
tags: ["roadmap","project-intelligence","knowledge","evolution"]
applies_to: ["project intelligence","knowledge","roadmap",".mcp/**"]
source: "Project owner's evolution list from the first production-style /sfn-init run (2026-10-08); status assessed against the code"
date: 2026-10-08
supersedes: []
---

# Project Intelligence Layer: next evolution areas

## Decision
Treat seven improvement areas, identified in the first production-style run of `/sfn-init` against a real repository, as the planned evolution of the Project Intelligence Layer, and pursue them in this order:

1. **Health report**: coverage with a stated definition, knowledge gaps, tribal-knowledge candidates.
2. **Auto-scaffold**: starter templates and an opt-in auto-create setting (default off).
3. **Suggestion engine**: detect repeated investigation from a local record of lookups that found nothing.
4. **Release intelligence**: persist extraction counts (models, controllers) in the snapshot and add knowledge changes (new ADRs, patterns, exceptions, lessons) to the release delta.
5. **Deterministic knowledge in review**: accepted exceptions annotate or downgrade the mechanical findings they explain, showing the reason.
6. **Semantic retrieval**: staged, last.

The seventh area, **project-owned intelligence**, is the governing principle rather than a task: knowledge belongs to the repository, not to developers, MCP instances, prompts or AI tools; a new engineer clones, runs `/sfn-init`, and inherits the project's decisions.

## Why
The layer works (validated end to end), but a fresh `.mcp/` is empty, so the principle only pays off once knowledge has been recorded. Items 1-3 attack that adoption gap and make knowledge debt visible; 4-5 make releases and reviews use the knowledge; 6 reduces dependence on exact wording.

## Alternatives considered
- **Build semantic retrieval first.** Rejected: it is the only item that cannot stay deterministic, and it is most useful once there is knowledge worth retrieving.
- **Auto-create entries from what the agent observes.** Rejected: it would turn assumptions into recorded truth. Auto-scaffold creates structure and templates only; entries stay `proposed` until a person accepts them.
- **Show a coverage percentage immediately.** Rejected until "coverage" is defined (candidate: the share of services, topics and golden rules in the project spec referred to by at least one accepted entry). An undefined percentage is an unverified claim.

## Constraints
- The server stays deterministic; model judgment is recorded, not assumed.
- Every score, suggestion or match must say why it exists. "No match" is never presented as "nothing intentional."
- Lookup history is local working state, not committed.
- Semantic options in order of cost: explicit `aliases` in frontmatter (deterministic); query expansion by the client model when sampling is available (cached); embeddings (adds a dependency and non-determinism).

## Current status (2026-10-08, checked against the code)
Done in 4.1.0: 1 (auto-scaffold with templates, opt-in auto-create), 2 (suggestion engine, first form), 3 (health report: coverage as documented vs discovered entities, anomalies kept out of the headline as unconfirmed candidates). Partial: 5, 6. Not started: 4. Structure in place: 7. Details are in the README section "Roadmap: Next Evolution of the Project Intelligence Layer".

Coverage was defined as documented vs discovered entities (services, topics, golden rules, domain concepts, platform decisions) from the curated project spec, not from the knowledge graph (which holds duplicate and code-constant names). Anomalies are reported separately as known-exception candidates.

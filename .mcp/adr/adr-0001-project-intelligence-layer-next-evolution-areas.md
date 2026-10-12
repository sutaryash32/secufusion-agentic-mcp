# ADR-0001: Project Intelligence Layer: next evolution areas

> A fresh `.mcp/` is empty, so we will make knowledge debt visible and easy to pay down first (health report, templates, suggestions), then make releases and reviews use the knowledge, and add semantic retrieval last.

## Decision Snapshot

**Problem**

The Project Intelligence Layer works end to end, but a newly created `.mcp/` holds no knowledge, so the principle that the repository owns its understanding only pays off once knowledge has been recorded. The first production-style `/sfn-init` run against a real repository surfaced seven improvement areas without an agreed order.

**Decision**

Treat the seven areas as the planned evolution of the layer and pursue them in this order: the health report, auto-scaffold with templates, the suggestion engine, release intelligence, deterministic knowledge in review, and semantic retrieval last. The seventh area, project-owned intelligence, is the governing principle rather than a task: knowledge belongs to the repository, not to developers, MCP instances, prompts or AI tools.

**Outcome**

The first three areas make the adoption gap visible and cheap to close; the next two make releases and reviews consume the knowledge; semantic retrieval reduces dependence on exact wording once there is knowledge worth retrieving. The server stays deterministic and every score, suggestion or match states why it exists.

**Status**

Proposed

**Related Work**

- README section "Roadmap: Next Evolution of the Project Intelligence Layer"
- `/sfn-init` first production-style run (2026-10-08)
- Release 4.1.0 (health report, auto-scaffold, suggestion engine)

---

## Executive Summary

The layer is validated, but it only delivers value once a project has recorded its decisions, exceptions and lessons. We chose to attack the adoption gap first, because an empty `.mcp/` makes every later feature moot, and to defer semantic retrieval, the only item that cannot stay deterministic, until there is knowledge to retrieve. Nothing in this plan lets the agent invent knowledge: structure and templates are created automatically, entries stay `proposed` until a person accepts them.

---

## Context

The layer stores project knowledge in `.mcp/` as plain, version-controlled markdown with a source and a trust level (`proposed` or `accepted`). `/sfn-init` loads it, retrieval is by relevance (terms, files, tags), and the review consults it. The first production-style run showed the layer working, and showed that a fresh repository starts with nothing in it.

---

## Problem Statement

How do we get from "the layer works" to "a repository that actually carries its own understanding", without letting the agent assert things nobody has verified, and without making the server depend on non-deterministic components before there is a need?

---

## Investigation Summary

- The run validated the layer end to end but left an empty `.mcp/`, so the value of the principle depends on adoption.
- "Coverage" had no definition, so any percentage would have been an unverified claim. It was later defined as documented versus discovered entities (services, topics, golden rules, domain concepts, platform decisions) from the curated project spec, not from the knowledge graph, which holds duplicate and code-constant names. Anomalies are reported separately as known-exception candidates.
- Semantic matching is the only area that cannot stay fully deterministic, and it is most useful once knowledge exists.

---

## Options Considered

| Option | Verdict | Why |
|---|---|---|
| Build semantic retrieval first | Rejected | It is the only item that cannot stay deterministic, and it is most useful once there is knowledge worth retrieving. |
| Auto-create entries from what the agent observes | Rejected | It would turn assumptions into recorded truth. Auto-scaffold creates structure and templates only; entries stay `proposed` until a person accepts them. |
| Show a coverage percentage immediately | Rejected until defined | An undefined percentage is an unverified claim. Coverage is shown as documented versus discovered counts with its definition printed. |
| Adoption first, then consumption, then semantics | **Selected** | It closes the gap that makes everything else pointless, keeps the server deterministic, and defers the costly item. |

---

## Decision

Pursue the areas in this order:

1. **Health report**: coverage with a stated definition, knowledge gaps, tribal-knowledge candidates.
2. **Auto-scaffold**: starter templates and an opt-in auto-create setting (default off).
3. **Suggestion engine**: detect repeated investigation from a local record of lookups that found nothing.
4. **Release intelligence**: persist extraction counts (models, controllers) in the snapshot and add knowledge changes (new ADRs, patterns, exceptions, lessons) to the release delta.
5. **Deterministic knowledge in review**: accepted exceptions annotate or downgrade the mechanical findings they explain, showing the reason.
6. **Semantic retrieval**: staged, last.

Constraints that apply throughout: the server stays deterministic and model judgment is recorded, not assumed; every score, suggestion or match says why it exists, and "no match" is never presented as "nothing intentional"; lookup history is local working state, not committed. Semantic options, in order of cost: explicit `aliases` in front matter (deterministic); query expansion by the client model when sampling is available (cached); embeddings (adds a dependency and non-determinism).

---

## Consequences

### Benefits

- Knowledge debt becomes visible and cheap to pay down, so the principle can start paying off.
- The server remains deterministic through the adoption and consumption phases.
- Nothing recorded as knowledge was invented by the agent.

### Trade-Offs

- The layer is only as useful as what people record, and the first items improve visibility, not content.
- Semantic retrieval waits, so conceptual matches (for example *endpoint* to *machine*) still need exact wording or hand-written `applies_to` terms for now.

### Risks

- Adoption may stay low if recording knowledge is not part of the team's routine.
- A suggestion or coverage figure can be read as more authoritative than it is; each must keep stating why it exists.

### Future Reconsideration Criteria

Revisit the order if adoption proves not to be the bottleneck, if retrieval misses become the main complaint (which would move semantic retrieval earlier, starting with explicit `aliases`), or if a deterministic way to downgrade mechanical review findings turns out to be cheap enough to do before release intelligence.

---

## Verification

Status checked against the code on 2026-10-08. Done in 4.1.0: the health report, auto-scaffold with templates, and the first form of the suggestion engine. Partial: release intelligence (change-driven notes exist; knowledge changes are not yet part of the delta) and knowledge-aware reviewing (model-mediated: the review receives the entries that apply to the changed files; the deterministic checks do not yet use them). Not started: semantic retrieval. In place: the structure for project-owned intelligence. The documentation tests and the end-to-end knowledge tests cover the implemented parts.

---

## References

- README, "Roadmap: Next Evolution of the Project Intelligence Layer"
- Release notes for 4.1.0 (`release-notes/v4.1.0.md`)
- Project owner's evolution list from the first production-style `/sfn-init` run (2026-10-08)

<!-- mcp:entry
Machine-readable metadata for the MCP project knowledge layer. Change the status with set_knowledge_status.
id: "adr-0001-project-intelligence-layer-next-evolution-areas"
title: "Project Intelligence Layer: next evolution areas"
category: adr
status: proposed
tags: ["roadmap","project-intelligence","knowledge","evolution"]
applies_to: ["project intelligence","knowledge","roadmap",".mcp/**"]
source: "Project owner's evolution list from the first production-style /sfn-init run (2026-10-08); status assessed against the code"
date: 2026-10-08
supersedes: []
-->

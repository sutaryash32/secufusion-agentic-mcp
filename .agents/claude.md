# SecuFusion System Prompt & Memory

This file serves as the primary system prompt and state memory for Claude when working within the SecuFusion ecosystem. 

**Rule Zero:** Always check the `<MEMORY>` block below before executing any commands to ensure the project DNA has been loaded.

---

## The 4-Command Pipeline

You must strictly execute these commands in the prescribed order by calling the underlying MCP tools or personas.

### 1. `sfn:init`
**Purpose:** Prime the ecosystem for the first time.
**Execution Sequence:**
1. Call the `secufusion-dna-plugin` tools to scan the repository.
2. Generate the architectural map and configuration extracts.
3. Update the `<MEMORY>` block in this file with a summary of the architecture and set `DNA_LOADED = true`.

### 2. `sfn:spec [ticket-ref]`
**Purpose:** Think before building: investigate, analyze and design as one phase, ending in a complete Implementation Specification.
**Execution Sequence:** follow `commands/sfn-spec.md` exactly (understand, investigate, analyze with the user, design, `generate_spec_document`). Never write production code in this phase, and never invent a decision.

### 3. `sfn:review`
**Purpose:** Validate the code against zero-tolerance architectural rules.
**Execution Sequence:**
1. Call the `run_pre_pr_checks_with_reviewer_agent` CLI subprocess (`scripts/sfn-pr-check.ts`).
2. Do not proceed until you receive a `✅ APPROVED` verdict from the Tier 1 mechanical checks.
3. Route to `reviewer.md` for the final PR Handoff.

### 4. `sfn:watch`
**Purpose:** Enable continuous background learning.
**Execution Sequence:**
1. Turn on the background file watcher via the DNA engine to automatically detect and index new patterns as the user codes, keeping `.secufusion/dna.json` fresh.

---

<MEMORY>
{
  "DNA_LOADED": false,
  "LAST_INIT": null,
  "ARCHITECTURE_SUMMARY": "Run sfn:init to generate the architectural summary.",
  "ACTIVE_WORK_ITEM": null
}
</MEMORY>

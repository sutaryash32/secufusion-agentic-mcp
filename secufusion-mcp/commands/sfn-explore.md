---
description: Architecture utilities. `map` renders the service graph; `impact <component>` runs a blast-radius analysis. Ticket investigation moved to /sfn-spec (this command redirects there).
argument-hint: map | impact <component-or-file>   (tickets: use /sfn-spec)
---

You are executing the **sfn-explore** command for the SecuFusion ecosystem.

Argument: **$ARGUMENTS**

---

## Mode Detection

Read `$ARGUMENTS` and decide the mode:

- Empty or `map` → **Mode A — Architecture Map**
- Starts with `impact ` (or is a single token that is clearly a service/file such as `sfn-events-api`, `TenantEntity.java`) → **Mode B — Blast Radius**
- Anything else (a ticket id, a bug, a feature description) → **Mode C** → run `/sfn-spec` instead

---

## Mode C — Requirement Exploration (moved)

Investigating a ticket and designing the change are now ONE phase: **`/sfn-spec`**. Do not explore a ticket here.
Read `commands/sfn-spec.md` and execute it in full with the same argument (`$ARGUMENTS`), telling the user once that `/sfn-explore <ticket>` is now `/sfn-spec <ticket>`.

---

## Mode A — Architecture Map

> Use this when: you want a bird's-eye view of the entire ecosystem (e.g. onboarding a new dev, auditing dependencies).

1. Call `prime_session` or read `.secufusion/dna.json` to load the current knowledge graph.
2. Generate a comprehensive **Mermaid diagram** (`graph TD`) that shows:
   - All microservices grouped by bounded context
   - REST API call graph (which service calls which)
   - Kafka topic flow (producer → topic → consumer)
   - Frontend (`sfn-web-ui`) and extension (`snf-browser-extn`) connections to backend services
3. Render the Mermaid diagram in the response.
4. Below the diagram, print a service inventory table:

   | Service | Port | Stack | Owns Tables | Produces Topics | Consumes Topics |
   |---|---|---|---|---|---|

---

## Mode B — Blast Radius

> Use this when: you are about to refactor a shared entity, change an API contract, or modify a Kafka topic and need to know the full downstream impact.

1. Call `prime_session` or read `.secufusion/dna.json` to load the knowledge graph.
2. Search for all references to `$ARGUMENTS` across:
   - Microservice API consumers (who calls this endpoint?)
   - Database entity consumers (which repos query this table/column?)
   - Kafka consumers (which services consume this topic?)
   - Frontend and `snf-browser-extn` (does the UI or extension directly consume this contract?)
3. Present a **Cross-Repo Blast Radius Report**:

   ```
   🎯 Component: $ARGUMENTS

   Impacted Microservices:
     - sfn-X-api  →  [why impacted]

   Impacted APIs:
     - GET /v1/...  →  [consumers]

   Impacted Events / Consumers:
     - topic-name  →  [consumer services]

   Impacted Databases:
     - table_name  →  [services querying this]

   Impacted Frontend / Extension:
     - sfn-web-ui  →  [pages / components]
     - snf-browser-extn  →  [content scripts / background workers]

   Risk Level: 🟢 LOW | 🟡 MEDIUM | 🔴 HIGH
   ```

4. If risk is 🔴 HIGH, add a warning:
   > ⚠️ High blast radius detected. Consider running `/sfn-spec` with this context before making changes.

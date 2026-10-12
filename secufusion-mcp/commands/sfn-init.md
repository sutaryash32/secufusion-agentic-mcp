---
description: "Bootstrap the SecuFusion workspace. Generates .secufusion-project-spec.json and .secufusion-migrations.json on first run. On re-run, performs a version-aware merge — updates MCP-owned rules and terminology while preserving workspace-discovered data. Safe to run at any time."
argument-hint: "(no args) — run from the repo root. Safe to re-run after MCP updates."
---

You are executing the **sfn-init** bootstrap command.

This command is safe to re-run at any time. It never blindly overwrites.
On re-run it detects what changed and merges intelligently.

---

## STEP 0 — Check what already exists and whether it is current

### 0.1 — Locate all three files

```
.secufusion-project-spec.json
  → Check workspace root first
  → Check up to 3 parent directories
  → Check same directory as the MCP server binary

.secufusion-migrations.json
  → Check workspace root
  → Check scripts/ subfolder

.secufusion/dna.json
  → Check .secufusion/ in workspace root
```

### 0.2 — For .secufusion-project-spec.json: version check

If the file exists, read its `_meta.mcp_spec_version` field.

**Read the currently installed MCP version** from the `package.json` of the
`secufusion-mcp` npm package. Locate it using this priority:

```
1. package.json in the same directory as the MCP server binary (most reliable)
2. npm list -g secufusion-mcp  → parse the version from output (e.g. "secufusion-mcp@2.1.9")
3. The "version" field in the nearest package.json walking up from server binary location
```

This installed version IS the MCP canonical version. It changes automatically when the
developer publishes a new npm version (`npm publish`). No manual version tracking required.

**Version decision table:**

| Workspace file exists? | `mcp_spec_version` matches? | Action |
|---|---|---|
| NO | — | Fresh install → generate from scratch (Phase 1 + 2) |
| YES | YES (up to date) | No changes needed → skip Phase 2, load and report |
| YES | NO (stale) | Merge required → run Phase 1 scan + Phase 2 MERGE |
| YES | field missing (very old) | Treat as stale → run merge |

### 0.3 — For .secufusion-migrations.json

If exists: check if any new `.sql` files exist in migration folders that are NOT
recorded in this file → if yes, trigger migration refresh in Phase 3.
If not exists: generate it.

### 0.4 — For .secufusion/dna.json

If exists and `scannedAt` is less than 7 days ago: use existing, skip Phase 4 scan.
If exists and older than 7 days: offer refresh — ask user: "DNA is X days old. Refresh? (Y/n)"
If not exists: generate it.

### 0.5 — Report what will happen

Before doing any work, tell the user:

```
📋 Init plan for this workspace:

  .secufusion-project-spec.json  → {FRESH INSTALL | UP TO DATE | MERGE REQUIRED (v{old} → v{new})}
  .secufusion-migrations.json    → {GENERATE | UP TO DATE | REFRESH (new SQL files detected)}
  .secufusion/dna.json           → {GENERATE | UP TO DATE | REFRESH OFFERED (X days old)}

Proceeding...
```

Do not ask for confirmation before proceeding — just report the plan and execute.
The user can interrupt if they disagree.

---

## PHASE 1 — Scan the repository (runs on fresh install OR merge)

**First, preserve the "before" state.** The scan tools below **rewrite `.secufusion-migrations.json`**. If you scan first, the previous migration state is gone and the release notes cannot show what moved. So, *before calling any scan tool*, copy both files you will later compare against:

```
cp .secufusion-project-spec.json  .secufusion-project-spec.json.backup-{timestamp}
cp .secufusion-migrations.json    .secufusion-migrations.json.backup-{timestamp}
```

(The server also keeps a `.secufusion-migrations.json.backup-<timestamp>` whenever a scan changes that file, but your own copy taken now is the authoritative baseline.) Do not skip this for a "quick" re-init.

Run all 4 tools **concurrently in a single message**:

1. `scan_repository_stack(workspace_root: <workspace_root>)`
   → Identifies language, framework, package manager, services, build/test commands
   → Detects if this is a monorepo

2. `extract_domain_models(workspace_root: <workspace_root>)`
   → Maps all domain entities, their fields, and relationships
   → Identifies @Entity classes, their columns, and inter-entity relationships
   → Note: "Device" in older code may mean a Browser install, not a physical machine

3. `extract_api_endpoints(workspace_root: <workspace_root>)`
   → Maps all REST endpoints, HTTP methods, and owning services
   → Identifies gateway routes vs direct service-to-service calls

4. `extract_event_topics(workspace_root: <workspace_root>)`
   → Maps all Kafka topics, producers, and consumers per service
   → Flag any topics with no confirmed consumer (dead topic risk)

**While scans run, note:**
- Which services have a `src/main/resources/db/migration/` folder → these have manual migrations
- Which services have NO migration folder → these are schema-free
- Any service making direct REST calls that bypass the gateway
- Any Kafka topics with producers but no consumers (dead topics)
- Any inconsistency between "Device" and "Machine" naming in entity classes

---

## PHASE 2 — Generate or merge the spec file

After scans complete, write or update `.secufusion-project-spec.json` at the workspace root.

This file is the **permanent memory of the project**. Every MCP tool reads it.

### If FRESH INSTALL (file did not exist)

Generate from scratch using the structure below. Proceed to Required structure.

### If MERGE REQUIRED (file exists but is stale)

The spec has two kinds of sections with different owners:

```
MCP-OWNED sections (always updated from MCP defaults when stale):
  _meta              — version, timestamps, warnings
  terminology        — Device vs Machine rules (you defined these)
  golden_rules       — the non-negotiable rules (you defined these)
  coding_style       — naming conventions (you defined these)
  platform           — auth provider, event bus, migration strategy

WORKSPACE-OWNED sections (preserved from scan, updated with new scan results):
  microservices      — discovered from actual source code
  kafka_topics       — discovered from actual @KafkaListener / @KafkaProducer
  cross_service_call_graph — discovered from actual RestTemplate / WebClient calls
  services_with_migrations    — discovered from actual migration folders
  services_without_migrations — discovered from actual source structure
  frontend           — discovered from package.json / framework detection
  chrome_extension   — discovered from actual source
```

**Merge procedure (in order):**

1. **Backup first**
   Copy existing file to `.secufusion-project-spec.json.backup-{YYYYMMDD-HHMMSS}`
   Never lose the old state. Confirm backup written.

2. **Preserve workspace-owned data**
   Read all WORKSPACE-OWNED sections from the existing file.
   Hold them in memory — they will survive the merge.

3. **Re-scan workspace-owned sections**
   Run Phase 1 scans to refresh: microservices, kafka_topics, call graph, migration lists.
   Merge scan results with preserved data:
   - If a service exists in both: keep existing config, update `kafka_produces` / `kafka_consumes` from scan
   - If a service is new in scan: add it
   - If a service was in old file but scan found it no longer exists: flag it with `"status": "NOT_FOUND_IN_LAST_SCAN"` — do NOT silently delete it

4. **Overwrite MCP-owned sections**
   Replace `_meta`, `terminology`, `golden_rules`, `coding_style`, `platform` entirely
   with the current MCP defaults. These are the sections you update when you push
   a new version of the MCP. They propagate to every coworker on next init.

5. **Update `_meta.mcp_spec_version` and append to `_changelog`**

   Read the installed npm version from `package.json` — this is the new `mcp_spec_version`.
   Set `_meta.mcp_spec_version` to this value.
   Set `_meta.generated_at` to now (ISO timestamp).

   Then **append a new entry** to the `_changelog` array in the spec file.
   The `mcp_spec_version` in this entry is the npm package version that ran init:

   ```json
   {
     "mcp_spec_version": "{npm package version — e.g. 2.2.0}",
     "date": "{YYYY-MM-DD}",
     "author": "sfn-init auto-merge",
     "summary": "Spec merged: secufusion-mcp@{old_version} → secufusion-mcp@{new_version}",
     "sections_changed": ["{MCP-owned sections overwritten}"],
     "added": [
       "{new golden rule id}: {what it enforces}",
       "{new terminology key}: {what it means}"
     ],
     "modified": [
       "{rule id}: {what changed — e.g. severity WARNING → BLOCKER}"
     ],
     "removed": [
       "{anything removed from golden_rules or terminology}"
     ],
     "workspace_changes": [
       "{any service flagged NOT_FOUND_IN_LAST_SCAN}",
       "{any new kafka topic discovered by scan}"
     ],
     "merge_impact": "MERGE — MCP-owned sections overwritten, workspace sections preserved",
     "previous_mcp_version": "{old npm version}",
     "backup_file": ".secufusion-project-spec.json.backup-{timestamp}"
   }
   ```

   **Rule:** `_changelog` is append-only. Never delete an entry. Never modify a past entry.
   The full history must be preserved so any developer can audit exactly what changed
   on their machine and when.

6. **Generate Release Notes (change-driven)**
   Release notes are a **changelog, not a repository scan**. After the merged spec is written (the next step), call `generate_release_notes` instead of writing the Markdown yourself:

   ```
   generate_release_notes(
     workspace_root,
     version:            "{new_version}",
     previous_version:   "{old npm version}",
     previous_spec_path: ".secufusion-project-spec.json.backup-{timestamp}",   # the backup made in step 1
     previous_migrations_path: ".secufusion-migrations.json.backup-{timestamp}", # the copy taken BEFORE the scan (Phase 1)
     why:                "{one or two sentences: why this version exists, from the _changelog entry or the work that prompted it}",
     fixed:              ["{defects, false positives or wrong mappings corrected, if you know of any}"],
     removed:            ["{removed or deprecated behaviour the diff cannot show}"],
     discoveries:        ["{notable things the scan found}"]
   )
   ```

   The tool computes the delta against the previous version (services, topics, mappings, rules, terminology, configuration, migrations, risks, knowledge-graph counts)
   and writes `.secufusion/releases/v{new_version}.md` plus a snapshot the next release will compare against. It leads with the changes (Executive Summary, Added, Changed,
   Fixed, Removed / Deprecated, Risks, Repository Intelligence Updates, Rule Changes) and puts the Detailed Snapshot last.

   **The file also carries what the new MCP version itself brings.** Right after the Executive Summary the tool adds *What this MCP version brings*, read from the release notes bundled with the MCP
   (summary, added, changed, fixed, breaking changes and new tools) for **every version after `previous_version` up to `version`**, so skipping versions loses nothing. Keep `previous_version` accurate
   (the old MCP version from the spec's `_meta`); do not summarise or rewrite that section yourself. If it says no release information is bundled, report that to the user as is.

   Rules for you:
   - **Pass `previous_migrations_path`.** Without it the tool cannot compare migrations and will say "Not compared: migrations" rather than guess. Never tell the user "no changes" about something it reported as not compared.
   - **Supply `why`** (and only things you actually know for `fixed` / `removed` / `discoveries`). Never pad them; an omitted `why` is shown as "not stated", which is better than a guess.
   - **Do not write boilerplate** such as "No new Kafka topics discovered": the tool states "None." or "No significant changes" itself when that is true.
   - **Do not paste inventories** (service lists, topic lists) into the notes; the delta is the story and the snapshot is reference.
   - On a **fresh install** call it too (without `previous_*`): it records a baseline, so the next merge has something to compare against.

6. **Write merged file**
   Write the final merged JSON to workspace root — with the updated `_changelog` included.
   Report what changed:

```
✅ Spec merged: v{old} → v{new}

Updated (MCP-owned):
  • golden_rules: {n} rules (was {m})
  • terminology: Device/Machine rules refreshed
  • coding_style: updated
  • platform: updated

Preserved + refreshed (workspace-owned):
  • microservices: {n} services ({m} newly discovered)
  • kafka_topics: {n} topics ({m} newly discovered)
  • {service}: flagged NOT_FOUND_IN_LAST_SCAN — verify if service was removed

Changelog entry appended: v{new} — {date}
Backup: .secufusion-project-spec.json.backup-{timestamp}
```



### If UP TO DATE (version matches)

Do not rewrite the file. Load it and proceed directly to Phase 5.
Report:
```
✅ .secufusion-project-spec.json is current (v{version}) — no changes needed.
```



### Required structure

Write a JSON file with this exact top-level shape:

```json
{
  "_meta": {
    "version": "1.0",
    "generated_at": "<ISO timestamp>",
    "generation_source": "/sfn:init scan",
    "warning": "Do not edit manually. Use manage_project_spec(action: update) to modify fields."
  },
  "platform": {
    "name": "<project name>",
    "type": "<platform type from scan>",
    "tenancy_model": "<single-tenant | multi-tenant>",
    "auth_provider": "<Keycloak | Auth0 | etc>",
    "event_bus": "<Kafka | RabbitMQ | none>",
    "database": "<PostgreSQL | MySQL | etc>",
    "migration_strategy": "<MANUAL | Flyway auto | Liquibase>"
  },
  "terminology": {
    "_critical": "Read before touching any entity named Device or Machine.",
    "Device": "A BROWSER INSTALLATION — Chrome, Edge, Firefox on a machine. NOT a physical machine.",
    "Machine": "A PHYSICAL ENDPOINT — laptop, desktop, workstation.",
    "history": "The platform originally used Device to mean physical endpoint. Terminology was corrected in backend services and data models. Older code may still use legacy Device naming for what is now a Machine.",
    "rules": [
      "Before declaring a bug involving 'device': confirm whether it is a Browser (Device) or Physical Endpoint (Machine).",
      "Naming inconsistency does NOT equal a bug — verify which entity is actually referenced.",
      "Frontend labels do NOT map 1:1 to backend entity names."
    ]
  },
  "microservices": {
    "<service-name>": {
      "language": "<Java | TypeScript | Go | ...>",
      "framework": "<Spring Boot | Express | ...>",
      "responsibility": "<one sentence>",
      "gateway_route": "<route pattern or NOT_CONFIRMED>",
      "has_database": true,
      "has_migrations": true,
      "migration_path": "src/main/resources/db/migration",
      "migration_notes": "<version gaps or other notes>",
      "kafka_produces": ["<topic-name>"],
      "kafka_consumes": ["<topic-name>"],
      "direct_rest_calls": {
        "<target-service>": "<description and risk>"
      }
    }
  },
  "frontend": {
    "repo": "<repo name>",
    "language": "<TypeScript | JavaScript>",
    "framework": "<React | Vue | Angular | ...>",
    "gateway_connection": "<how it connects to backend>",
    "terminology_note": "<UX normalization note if applicable>"
  },
  "chrome_extension": {
    "repo": "<repo name>",
    "language": "<Node + Go | ...>",
    "gateway_connection": "<how it connects>",
    "deployment": "<deployment mechanism>"
  },
  "kafka_topics": {
    "<topic-name>": {
      "producers": ["<service>"],
      "consumers": ["<service>"],
      "risk": "<normal | fan-out | two-producers | DEAD TOPIC>"
    }
  },
  "cross_service_call_graph": {
    "<caller> -> <callee>": "<mechanism and risk>"
  },
  "golden_rules": {
    "<rule-id>": {
      "rule": "<the rule>",
      "severity": "<BLOCKER | WARNING>",
      "reason": "<why it exists>"
    }
  },
  "coding_style": {
    "comments": "Explain WHY, never WHAT.",
    "naming": "<casing conventions>",
    "migration_naming": "<pattern>",
    "constraint_naming": "<pattern>"
  },
  "services_with_migrations": ["<service-name>"],
  "services_without_migrations": ["<service-name>"]
}
```

### Mandatory golden rules to always include

Regardless of what the scan finds, always write these rules into `golden_rules`.
These are non-negotiable on SecuFusion:

```json
"tenant_isolation":      { "rule": "Every *Repository.java query method MUST filter by tenantId.", "severity": "BLOCKER" },
"kafka_no_blocking":     { "rule": "@KafkaListener MUST NOT make synchronous HTTP calls or blocking DB writes.", "severity": "BLOCKER" },
"migration_before_deploy": { "rule": "Every migration script MUST be run via psql BEFORE deploying code that depends on it.", "severity": "BLOCKER" },
"no_flyway_auto_exec":   { "rule": "No spring.flyway.* config. No auto-execution on boot.", "severity": "BLOCKER" },
"cross_service_timeout": { "rule": "Every RestTemplate/WebClient call MUST have explicit timeout + fallback.", "severity": "BLOCKER" },
"no_hardcoded_env":      { "rule": "No hardcoded IPs, hostnames, ports, URLs, or credentials.", "severity": "BLOCKER" },
"auth_required":         { "rule": "Every non-public controller method MUST have @PreAuthorize.", "severity": "BLOCKER" },
"no_n_plus_one":         { "rule": "No repository calls inside loops.", "severity": "BLOCKER" },
"index_with_migration":  { "rule": "New query columns MUST have CREATE INDEX in the same migration file.", "severity": "BLOCKER" },
"no_swallowed_exceptions": { "rule": "Empty catch blocks are forbidden. Log, re-throw, or convert.", "severity": "BLOCKER" },
"device_machine_terminology": { "rule": "Device = Browser. Machine = Physical endpoint. Confirm which entity before touching any code with these names.", "severity": "WARNING" }
```

### After writing the spec

Confirm:
```
✅ .secufusion-project-spec.json written to {path}
   Services mapped: {count}
   Kafka topics mapped: {count}
   Golden rules written: {count}
   Migration services: {list}
```

---

## PHASE 3 — Generate migration spec (only if it does not exist)

If `.secufusion-migrations.json` does not exist:

For each service in `services_with_migrations`:
1. Read all `.sql` files in `src/main/resources/db/migration/`
2. Parse the version numbers (`V{n}__description.sql`)
3. Identify the highest version number
4. Identify any gaps in the version sequence (e.g. V1, V2, V4 → gap at V3)
5. Determine the next suggested version

Write `.secufusion-migrations.json` at the workspace root with this structure:

```json
{
  "services": {
    "<service-name>": {
      "has_migrations": true,
      "migration_path": "src/main/resources/db/migration",
      "naming_convention": {
        "pattern": "V{n}__description.sql",
        "examples_spread": ["V1__initial_schema.sql", "V2__add_tenant_id.sql"]
      },
      "content_conventions": {
        "comment_style": "-- ===\n-- V{n}: Description\n-- WHY: Reason\n-- NOTE: Applied MANUALLY\n-- ===",
        "constraint_naming": "chk_{table}_{field} for checks, idx_{table}_{column} for indexes"
      },
      "current_state": {
        "highest_version_number": 5,
        "next_suggested": "V6",
        "all_versions": [1, 2, 3, 4, 5]
      },
      "organization": {
        "version_gaps": [],
        "notes": "No gaps — sequence is clean"
      }
    }
  },
  "mcp_guardrails": {
    "naming_pattern_to_enforce": "^V\\d+__[a-z][a-z0-9_]*\\.sql$",
    "never_reuse_gap_versions": true,
    "manual_execution_only": true,
    "execution_command": "psql -U <user> -d <database> -f <filename>"
  }
}
```

Confirm:
```
✅ .secufusion-migrations.json written to {path}
   Services with migrations: {list}
   Version gaps found: {list per service}
```

---

## PHASE 4 — Generate dna.json (always — or refresh if asked)

Write `.secufusion/dna.json` with the combined scan output:

```json
{
  "scannedAt": "<ISO timestamp>",
  "services": [ /* from scan_repository_stack */ ],
  "domainModels": [ /* from extract_domain_models */ ],
  "apiEndpoints": [ /* from extract_api_endpoints */ ],
  "eventTopics": [ /* from extract_event_topics */ ],
  "architectureSummary": "<2-3 sentence human-readable summary of the architecture>"
}
```

---

## PHASE 4.5 — Build project understanding (Project Intelligence Layer)

The project's knowledge has two complementary layers, and `/sfn-init` loads both: **DNA** (Phases 1-4: *what exists*: services, APIs, topics, models, topology) and **Project Intelligence** (this phase: *why it exists*: decisions, exceptions, terminology, lessons). Together they are the **Unified Project Knowledge System**. DNA tells the MCP what the system is; Project Intelligence tells it why the system became that way. `load_project_knowledge` prints a *Unified project knowledge* block that puts the two side by side. Relay it, and treat DNA anomalies as questions for `.mcp/` before treating them as defects.

`/sfn-init` is not only metadata loading: it constructs the project's understanding. Project knowledge (architecture, ADRs, patterns, intentional exceptions,
lessons learned, operational constraints) belongs to the **repository**, under `.mcp/`, not to this agent file or to anyone's memory.

1. Call `load_project_knowledge(workspace_root)`. It builds the unified memory model and returns a compact index per category, validation problems, whether the agents file
   has grown into a knowledge dump, and a **health report**. Read the index; do **not** read every entry. Entries are pulled on demand with `get_project_knowledge`.
2. **If `.mcp/` does not exist,** the tool explains why the layer matters and what scaffolding creates. Relay that briefly, then offer `load_project_knowledge(scaffold: true)`
   (it creates the folders, a README and one starter template per category in `.mcp/templates/`). It never creates knowledge. If the project has opted in
   (`_meta.auto_scaffold_knowledge: true` in `.secufusion-project-spec.json`, or `SECUFUSION_AUTO_SCAFFOLD=1`) the tool scaffolds by itself and says so; otherwise ask first.
3. **Present the health report as returned**, without rounding it into a score:
   - *Coverage* is documented vs discovered entities (services, topics, golden rules, domain concepts, platform decisions) with the definition of "documented" stated.
     Quote the counts; never turn them into a percentage or a grade.
   - *Known-exception candidates* are anomalies the spec exposes. They are unconfirmed, some may be benign, and they are not part of the coverage line.
   - List the **knowledge gaps**, the **repeatedly investigated** areas, and the **tribal-knowledge candidates** (project-specific sections still inside the agent file).
4. **Offer the suggestions** (`suggest_project_knowledge`): the top few, with their evidence. Do not record anything on your own. Record only what is verified, with a `source`;
   it is saved `proposed`, and only a person (their words) accepts it.
5. **Keep agents.md lightweight.** It teaches how to think (workflow, investigation and review philosophy, engineering principles). For each tribal-knowledge candidate, offer to
   move it into `.mcp/` with `record_project_knowledge`, and only after the user agrees replace the section with a pointer; do not move anything silently. Back up a file that is not under version control first.
6. Report: entries per category, `proposed` (unreviewed hints) vs `accepted` (project decisions), any problems, and any `agents.md` warning.

Adding knowledge must be easy. Whenever a terminology trap, a decision, an intentional exception, a lesson or an operational constraint comes up during any command, offer
to record it with `record_project_knowledge` (saved as `proposed` with its `source`; a person accepts it with `set_knowledge_status`).

---

## PHASE 5 — Update session state

Update `.agents/claude.md` MEMORY block:

```json
{
  "DNA_LOADED": true,
  "LAST_INIT": "<ISO timestamp>",
  "ARCHITECTURE_SUMMARY": "<2-3 sentences from architectureSummary above>",
  "ACTIVE_WORK_ITEM": null
}
```

---

## PHASE 6 — Report and diagram

### Summary report

```
══════════════════════════════════════════════════════
  SecuFusion Init Complete
══════════════════════════════════════════════════════

Files generated (or already existed):
  ✅ .secufusion-project-spec.json  — {path}
  ✅ .secufusion-migrations.json    — {path}
  ✅ .secufusion/dna.json           — {path}
  ✅ .agents/claude.md              — DNA_LOADED: true

Discovered:
  Services:       {count} ({list})
  Domain models:  {count} entities
  API endpoints:  {count}
  Kafka topics:   {count} ({list dead topics with ⚠️})
  Migrations:     {services with migrations}

Warnings:
  {any inferred routes or unconfirmed connections}
  {any dead Kafka topics}
  {any missing repos per spec expectations}

══════════════════════════════════════════════════════
```

### Architecture diagram

Generate a Mermaid `graph TD` diagram showing:
- All microservices and their bounded contexts
- REST API call graph (which service calls which, including direct bypass calls)
- Kafka topic flow (producer → topic → consumer, flag dead topics with ⚠️)
- Frontend and extension connections to backend

Render the diagram in your response.

---

## PHASE 7 — Handover instructions for new developers

After generating everything, output this exactly:

```
══════════════════════════════════════════════════════
  WORKSPACE READY

  All memory files generated. This workspace is now
  fully primed for SecuFusion MCP tooling.

  Important files created:
  • .secufusion-project-spec.json  — permanent project memory
  • .secufusion-migrations.json    — migration version tracking
  • .secufusion/dna.json           — architectural scan results

  These files are generated from your local source code.
  They are safe to commit to the repo so teammates get
  them pre-populated on clone.

  Next steps:
  • To start a task: /sfn:spec <ticket-ref>
  • To review code:  /sfn:review <WI-ID>
  • To refresh DNA:  /sfn:init (safe — will not overwrite existing spec)

  If you cloned this repo and these files already exist:
  • You do not need to run /sfn:init
  • The MCP is already primed and ready
  • Run /sfn:spec <your-ticket> to start working
══════════════════════════════════════════════════════
```

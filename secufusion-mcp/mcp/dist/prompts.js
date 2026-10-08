import { z } from "zod";
export function registerPrompts(server) {
    // ─── MCP Prompts (appear as slash commands in Claude IDE picker) ──────────────
    server.prompt("sfn-init", "Prime the SecuFusion ecosystem — scan the entire codebase, map the architectural DNA (services, models, APIs, events), and write it to .secufusion/dna.json. Run this once when you first open a new project.", {
        workspace_root: z.string().describe("Absolute path to the project root. Leave blank to use the current working directory.")
    }, ({ workspace_root }) => ({
        messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: `You are executing **sfn:init** — the SecuFusion DNA bootstrap command.

Workspace root: ${workspace_root || process.cwd()}

**This is a learn-first command. Do NOT write implementation code. Study THIS project and produce real findings.**

## Phase 1 — SCAN (run all 4 tool calls concurrently in a single message)
1. Call \`scan_repository_stack\` — identify language, framework, microservices, build/test commands. Flag monorepos.
2. Call \`extract_domain_models\` — map all domain entities, fields, and relationships.
3. Call \`extract_api_endpoints\` — map all REST/GraphQL endpoints, methods, and owning services.
4. Call \`extract_event_topics\` — map all Kafka/event-bus topics, producers, and consumers.

## Phase 2 — WRITE DNA
- Write combined findings to \`.secufusion/dna.json\` at the workspace root.
- Update the \`<MEMORY>\` block in \`agents/claude.md\`: set \`DNA_LOADED = true\`, \`LAST_INIT\` = now, and \`ARCHITECTURE_SUMMARY\` = a 2-3 sentence human-readable summary.

## Phase 3 — REPORT
- Count: services, domain models, API endpoints, event topics found.
- Flag anything marked \`(inferred)\` that the human should verify.
- Confirm \`.secufusion/dna.json\` was written successfully.

**Next step:** Run \`/sfn-spec\` with a ticket ID to start your first task.`
                }
            }]
    }));
    server.prompt("sfn-watch", "Enable continuous background DNA learning — starts a file watcher that automatically re-syncs .secufusion/dna.json whenever source files change.", {
        workspace_root: z.string().describe("Absolute path to the project root to watch.")
    }, ({ workspace_root }) => ({
        messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: `You are executing **sfn:watch** — the SecuFusion continuous DNA watcher.

Workspace root: ${workspace_root || process.cwd()}

Call \`start_dna_watcher\` with workspace_root = "${workspace_root || process.cwd()}".

This will start a background file watcher that automatically re-scans and updates \`.secufusion/dna.json\` whenever source files are modified, keeping the architectural knowledge graph fresh without manual re-runs of \`/sfn-init\`.

Confirm to the user when the watcher is active and which directory is being watched.`
                }
            }]
    }));
}

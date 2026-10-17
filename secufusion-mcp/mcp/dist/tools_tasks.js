import { z } from "zod";
import fs from "fs";
import path from "path";
import { buildPrSummary, mergeNarrative, loadNarrative, NARRATIVE_FILE } from "./pr_summary.js";
import { recordGate, requireGates } from "./gates.js";
import { reviewStalenessFor, describeStaleness, STALE_NEXT } from "./review_staleness.js";
import { REJECTED_FILE, getWorkspaceRoot, resolve, readFileSafe, readJson, writeFile, loadMigrationSpec, getMigrationContextForService, appendTelemetry, textResult, INTENTS_DIR, TASKS_DIR, CLASSIFICATIONS_DIR, slugify, nextIntentNumber, parseIntentFrontmatter, resolveTaskFolder, generateNewTaskFolder, readRegistry, upsertRegistry, getEcosystemRoot } from "./shared.js";
import { displayRef, intentFileMatches, findRegistryConflict, identityConflictMessage, identityBundle, WORK_ITEM_ID_DESC } from "./work_item_ref.js";
export function registerTasksTools(server) {
    server.tool("resolve_work_item_ref", "Returns the canonical identity strings for a ticket: reference, task-folder name, branch suffix, commit prefix and PR-title prefix. " +
        "ALWAYS use these verbatim for branch names, commit messages, PR titles and references. The type the user wrote (BUG, TASK, STORY, FEATURE, EPIC, ...) is preserved exactly and never replaced by a default; if no type was given, none is invented.", {
        work_item: z.string().describe(WORK_ITEM_ID_DESC),
        title: z.string().optional().describe("Ticket title, used only for the readable slug."),
    }, async ({ work_item, title }) => {
        const b = identityBundle(work_item, title ?? "");
        const clash = findRegistryConflict(readRegistry(), work_item);
        return { content: [{ type: "text", text: JSON.stringify({
                        ...b,
                        identity_conflict: clash ? identityConflictMessage(work_item, clash) : null,
                        rule: "Use `ref` verbatim everywhere (branch, commit subject, PR title, comments). Do not shorten, re-case or retype it.",
                    }, null, 2) }] };
    });
    // ─── Tool 2: log_rejected_pattern ────────────────────────────────────────────
    server.tool("log_rejected_pattern", "Record a coding pattern that was rejected by the team so it is never repeated. " +
        "Appends to .rejected-patterns.json which is checked implicitly before every architectural suggestion.", {
        pattern: z
            .string()
            .describe("The exact bad pattern, approach, or code construct that was rejected."),
        reason: z
            .string()
            .describe("Why it was rejected and what the correct alternative is."),
        category: z
            .enum([
            "architecture",
            "security",
            "database",
            "logging",
            "api-design",
            "testing",
            "other",
        ])
            .default("other")
            .describe("Classification to make future lookup easier."),
        file_context: z
            .string()
            .optional()
            .describe("Optional: the file or code area where this was observed."),
    }, async ({ pattern, reason, category, file_context }) => {
        const inputChars = JSON.stringify({ pattern, reason, category, file_context }).length;
        const rejectedPath = resolve(REJECTED_FILE);
        let records = [];
        const existing = readFileSafe(rejectedPath);
        if (existing) {
            try {
                records = JSON.parse(existing);
            }
            catch {
                records = [];
            }
        }
        const newEntry = {
            id: records.length + 1,
            timestamp: new Date().toISOString(),
            category,
            pattern,
            reason,
            ...(file_context ? { file_context } : {}),
        };
        records.push(newEntry);
        writeFile(rejectedPath, JSON.stringify(records, null, 2));
        return appendTelemetry({
            content: [
                {
                    type: "text",
                    text: `✅ Rejected pattern #${newEntry.id} logged to \`${REJECTED_FILE}\`.\n\n` +
                        `**Category:** ${category}\n` +
                        `**Pattern:** ${pattern}\n` +
                        `**Reason:** ${reason}\n\n` +
                        `This will be checked automatically in all future architectural suggestions.`,
                },
            ],
        }, inputChars);
    });
    // ─── Tool 4: manage_project_spec ─────────────────────────────────────────────
    server.tool("manage_project_spec", "Manages the .secufusion-project-spec.json file — the permanent project memory containing all service ports, repos, domains, infrastructure config, coding patterns, auth flow, and golden rules. Every session must read this before writing any code.", {
        action: z
            .enum(["read", "update", "get_service", "get_golden_rules", "get_coding_patterns", "get_migration_context"])
            .describe("Action to perform: read (full spec), get_service (one microservice block), get_golden_rules (golden_rules + rejected_patterns), get_coding_patterns (coding_patterns block), update (surgical dot-notation write), get_migration_context (loads migration rules for a service)."),
        service_name: z
            .string()
            .optional()
            .describe("Only for action=get_service. Name of the microservice to fetch, e.g. 'sfn-events-api'."),
        update_path: z
            .string()
            .optional()
            .describe("Only for action=update. Dot-notation path to the value to set, e.g. 'microservices.sfn-iam-api.port'."),
        update_value: z
            .any()
            .optional()
            .describe("Only for action=update. The new value to set at update_path."),
    }, async ({ action, service_name, update_path, update_value }) => {
        const inputChars = JSON.stringify({ action, service_name, update_path, update_value }).length;
        // ── Locate .secufusion-project-spec.json (3 candidate locations) ─────────
        const SPEC_FILE = ".secufusion-project-spec.json";
        const candidates = [];
        // 1. Same directory as index.ts/index.js
        candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE));
        // 2. getWorkspaceRoot()
        candidates.push(path.resolve(getWorkspaceRoot(), SPEC_FILE));
        // 3. Walk up from getWorkspaceRoot() until found (up to 5 levels)
        let walkDir = getWorkspaceRoot();
        for (let i = 0; i < 5; i++) {
            const parent = path.dirname(walkDir);
            if (parent === walkDir)
                break;
            walkDir = parent;
            candidates.push(path.join(walkDir, SPEC_FILE));
        }
        const specPath = candidates.find((p) => fs.existsSync(p)) ?? null;
        if (!specPath) {
            return appendTelemetry({
                isError: true,
                content: [{ type: "text", text: `Project spec not found. Run extraction prompt first.\n\nSearched:\n${candidates.map((p) => `  • ${p}`).join("\n")}` }],
            }, inputChars);
        }
        // ── Parse spec ────────────────────────────────────────────────────────────
        const raw = readFileSafe(specPath);
        if (!raw) {
            return appendTelemetry({
                isError: true,
                content: [{ type: "text", text: `Failed to read project spec at: ${specPath}` }],
            }, inputChars);
        }
        let spec;
        try {
            spec = JSON.parse(raw);
        }
        catch (e) {
            return appendTelemetry({
                isError: true,
                content: [{ type: "text", text: `Invalid JSON in project spec at: ${specPath}\n\nParse error: ${e.message}` }],
            }, inputChars);
        }
        // ── action: read ──────────────────────────────────────────────────────────
        if (action === "read") {
            return appendTelemetry({
                content: [{ type: "text", text: JSON.stringify(spec, null, 2) }],
            }, inputChars);
        }
        // ── action: get_service ───────────────────────────────────────────────────
        if (action === "get_service") {
            if (!service_name) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: "ERROR: 'service_name' is required when action=get_service." }],
                }, inputChars);
            }
            const microservices = spec.microservices;
            const svcNameLower = service_name.toLowerCase();
            // 1. Direct match in microservices
            let serviceBlock = microservices?.[service_name];
            // 2. Case-insensitive match in microservices (e.g. "sfn-iam-api" vs "sfn-IAM-api")
            if (!serviceBlock && microservices) {
                const matchedKey = Object.keys(microservices).find(k => k.toLowerCase() === svcNameLower);
                if (matchedKey)
                    serviceBlock = microservices[matchedKey];
            }
            // 3. Check spec.frontend by repo name (e.g. "sfn-web-ui")
            const frontend = spec.frontend;
            if (!serviceBlock && frontend) {
                const repoName = String(frontend.repo ?? "").toLowerCase();
                if (repoName === svcNameLower || svcNameLower.includes("web-ui") || svcNameLower.includes("frontend")) {
                    serviceBlock = frontend;
                }
            }
            // 4. Check spec.chrome_extension by repo name
            const chromeExt = (spec.chrome_extension || spec["snf-browser-extn"] || spec.snf_browser_extn);
            if (!serviceBlock && chromeExt) {
                const repoName = String(chromeExt.repo ?? "").toLowerCase();
                if (repoName === svcNameLower || svcNameLower.includes("chrome") || svcNameLower.includes("extension")) {
                    serviceBlock = chromeExt;
                }
            }
            if (!serviceBlock) {
                const available = [
                    ...(microservices ? Object.keys(microservices) : []),
                    ...(frontend?.repo ? [String(frontend.repo)] : []),
                    ...(chromeExt?.repo ? [String(chromeExt.repo)] : []),
                ].join(", ");
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: `Service '${service_name}' not found in spec.\n\nAvailable services: ${available}` }],
                }, inputChars);
            }
            return appendTelemetry({
                content: [{ type: "text", text: JSON.stringify({ [service_name]: serviceBlock }, null, 2) }],
            }, inputChars);
        }
        // ── action: get_golden_rules ──────────────────────────────────────────────
        if (action === "get_golden_rules") {
            const goldenRules = spec.golden_rules;
            const block = {
                golden_rules: goldenRules ?? {},
                rejected_patterns: goldenRules?.rejected_patterns ?? [],
            };
            return appendTelemetry({
                content: [{ type: "text", text: JSON.stringify(block, null, 2) }],
            }, inputChars);
        }
        // ── action: get_coding_patterns ───────────────────────────────────────────
        if (action === "get_coding_patterns") {
            const block = spec.coding_patterns ?? {};
            return appendTelemetry({
                content: [{ type: "text", text: JSON.stringify(block, null, 2) }],
            }, inputChars);
        }
        // ── action: get_migration_context ─────────────────────────────────────────
        if (action === "get_migration_context") {
            if (!service_name) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: "ERROR: 'service_name' is required when action=get_migration_context." }],
                }, inputChars);
            }
            const migSpec = loadMigrationSpec(getWorkspaceRoot());
            if (!migSpec) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: "ERROR: .secufusion-migrations.json not found. Run /sfn:init to generate it." }],
                }, inputChars);
            }
            const ctx = getMigrationContextForService(migSpec, service_name);
            if (!ctx) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: `No migration context found for service: ${service_name}. (Does this service have a database?)` }],
                }, inputChars);
            }
            // Return a combined payload of service context and global guardrails
            const payload = {
                service_context: ctx,
                mcp_guardrails: migSpec.mcp_guardrails ?? {}
            };
            return appendTelemetry({
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            }, inputChars);
        }
        // ── action: update ────────────────────────────────────────────────────────
        if (action === "update") {
            if (!update_path) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: "ERROR: 'update_path' is required when action=update." }],
                }, inputChars);
            }
            if (update_value === undefined) {
                return appendTelemetry({
                    isError: true,
                    content: [{ type: "text", text: "ERROR: 'update_value' is required when action=update." }],
                }, inputChars);
            }
            // Deep set via dot-notation path
            const keys = update_path.split(".");
            let cursor = spec;
            for (let i = 0; i < keys.length - 1; i++) {
                const val = cursor[keys[i]];
                if (val === undefined || val === null || typeof val !== "object") {
                    return appendTelemetry({
                        isError: true,
                        content: [{ type: "text", text: `ERROR: Invalid update_path — '${keys.slice(0, i + 1).join(".")}' does not exist or is not an object.\n\nAttempted path: ${update_path}` }],
                    }, inputChars);
                }
                cursor = val;
            }
            const finalKey = keys[keys.length - 1];
            const oldValue = cursor[finalKey];
            cursor[finalKey] = update_value;
            writeFile(specPath, JSON.stringify(spec, null, 2));
            return appendTelemetry({
                content: [{
                        type: "text",
                        text: `✅ Project spec updated.\n\n**Path:** ${update_path}\n**Old value:** ${JSON.stringify(oldValue)}\n**New value:** ${JSON.stringify(update_value)}\n**File:** ${specPath}`,
                    }],
            }, inputChars);
        }
        return appendTelemetry({ content: [{ type: "text", text: "Invalid action." }] }, inputChars);
    });
    // ─── Tool: spec_next_number ───────────────────────────────────────────────────
    server.tool("spec_next_number", "Returns the next available 4-digit spec/intent number (e.g. 0031). Call before creating a new intent doc to ensure no collisions.", {}, async () => {
        const inputChars = 0;
        const next = nextIntentNumber();
        return appendTelemetry({
            content: [{ type: "text", text: JSON.stringify({ next_number: next, intents_dir: resolve(INTENTS_DIR) }, null, 2) }]
        }, inputChars);
    });
    // ─── Tool: spec_create_intent ─────────────────────────────────────────────────
    server.tool("spec_create_intent", "Creates a structured Markdown intent file in .secufusion/intents/ for a work item. This captures the WHY behind the code: business goal, PM sign-off, acceptance criteria, risk, and polyglot service map. Complements manage_task (which captures the HOW). Call immediately after manage_task action=initialize.", {
        work_item_id: z.string().describe(WORK_ITEM_ID_DESC),
        title: z.string().describe("Short feature/bug title."),
        business_goal: z.string().describe("1–3 sentences: why is this being built? What user or business problem does it solve?"),
        pm_owner: z.string().optional().describe("Product Manager name or alias responsible for this feature."),
        ticket_url: z.string().optional().describe("Full URL to the Azure DevOps / Jira ticket."),
        acceptance_criteria: z.array(z.string()).describe("Given/When/Then ACs. Each string is one AC."),
        out_of_scope: z.array(z.string()).optional().describe("Things explicitly NOT covered by this work item."),
        risk: z.string().optional().describe("Business risk if not delivered. e.g. 'SOC 2 audit failure', 'Revenue at risk', 'Low'."),
        services_involved: z.array(z.object({
            name: z.string().describe("Service name, e.g. 'notification-api'"),
            language: z.string().describe("Primary language, e.g. 'TypeScript', 'Java', 'Go', 'Python'"),
            role: z.string().describe("Role in this feature, e.g. 'produces Kafka event', 'REST consumer'")
        })).optional().describe("Polyglot service map — lists every service involved regardless of language. This is the polyglot bridge."),
        notes: z.string().optional().describe("Any additional context, constraints, or dependencies.")
    }, async ({ work_item_id, title, business_goal, pm_owner, ticket_url, acceptance_criteria, out_of_scope, risk, services_involved, notes }) => {
        const inputChars = JSON.stringify({ work_item_id, title, business_goal, pm_owner, ticket_url, acceptance_criteria, out_of_scope, risk, services_involved, notes }).length;
        const gateError = requireGates(getWorkspaceRoot(), work_item_id, ["philosophy"], "create the intent spec");
        if (gateError)
            return appendTelemetry(textResult(gateError, true), inputChars);
        if (acceptance_criteria.length === 0 || !business_goal.trim()) {
            return appendTelemetry(textResult("⛔ An intent needs a business_goal and at least one acceptance criterion.", true), inputChars);
        }
        const num = nextIntentNumber();
        const slug = slugify(title);
        const filename = `${num}-${displayRef(work_item_id)}-${slug}.md`;
        const intentsRoot = resolve(INTENTS_DIR);
        const filePath = path.join(intentsRoot, filename);
        const acBlock = acceptance_criteria
            .map((ac, i) => `- [ ] **AC${i + 1}:** ${ac}`)
            .join("\n");
        const oosBlock = (out_of_scope || []).length > 0
            ? (out_of_scope || []).map(s => `- ${s}`).join("\n")
            : "_None specified._";
        const servicesBlock = (services_involved || []).length > 0
            ? (services_involved || []).map(s => `| ${s.name} | ${s.language} | ${s.role} |`).join("\n")
            : "| _(none specified)_ | — | — |";
        const now = new Date().toISOString();
        const content = `---
work_item_id: ${work_item_id}
title: ${title}
status: Draft
number: ${num}
pm_owner: ${pm_owner || "TBD"}
ticket_url: ${ticket_url || "TBD"}
risk: ${risk || "TBD"}
created_at: ${now}
---

# [${displayRef(work_item_id)}] ${title}

## 🎯 Business Goal

${business_goal}

## 📋 Acceptance Criteria

${acBlock}

## 🚫 Out of Scope

${oosBlock}

## 🌐 Service Map (Polyglot Bridge)

| Service | Language | Role in this Feature |
|---------|----------|----------------------|
${servicesBlock}

## ⚠️ Risk

${risk || "_Not assessed._"}

## 📝 Notes

${notes || "_None._"}

---
_Intent file auto-generated by secufusion-mcp. Edit freely — this is the human layer._
`;
        writeFile(filePath, content);
        recordGate(getWorkspaceRoot(), work_item_id, "intent", true, "mechanical", `${acceptance_criteria.length} acceptance criteria`);
        return appendTelemetry({
            content: [{
                    type: "text",
                    text: `✅ Intent spec created.\n\n**File:** ${filePath}\n**Number:** ${num}\n**Slug:** ${slug}\n\nThis file captures the WHY. The JSON task folder (.secufusion/tasks/) captures the HOW.\nBoth will be merged by prime_session for a complete context.\n\n---\n${content}`
                }]
        }, inputChars);
    });
    // ─── Tool: spec_read_intent ───────────────────────────────────────────────────
    server.tool("spec_read_intent", "Read the intent (WHY) file for a work item. Returns business goal, PM owner, acceptance criteria status, polyglot service map, and risk. Use alongside prime_session to get a complete picture of code truth + business intent.", {
        work_item_id: z.string().describe("Work item ID to look up, e.g. '2847'."),
        update_ac: z.object({
            index: z.number().describe("0-based index of the AC to tick"),
            checked: z.boolean().describe("true = mark as done (- [x]), false = uncheck (- [ ])")
        }).optional().describe("Optionally tick or untick an acceptance criterion checkbox in the markdown.")
    }, async ({ work_item_id, update_ac }) => {
        const inputChars = JSON.stringify({ work_item_id, update_ac }).length;
        const intentsRoot = resolve(INTENTS_DIR);
        if (!fs.existsSync(intentsRoot)) {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `No intents directory found at ${intentsRoot}. Run spec_create_intent first.` }] }, inputChars);
        }
        const files = fs.readdirSync(intentsRoot).filter(f => f.endsWith(".md"));
        const match = files.find(f => intentFileMatches(f, work_item_id));
        if (!match) {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `No intent file found for ${displayRef(work_item_id)} in ${intentsRoot}.\nCreate one with spec_create_intent.` }] }, inputChars);
        }
        const filePath = path.join(intentsRoot, match);
        let raw = fs.readFileSync(filePath, "utf-8");
        if (update_ac !== undefined) {
            const acLines = raw.split("\n");
            let acCount = 0;
            for (let i = 0; i < acLines.length; i++) {
                if (acLines[i].match(/^- \[[ x]\] \*\*AC\d+/)) {
                    if (acCount === update_ac.index) {
                        acLines[i] = acLines[i].replace(/^- \[[ x]\]/, update_ac.checked ? "- [x]" : "- [ ]");
                        break;
                    }
                    acCount++;
                }
            }
            raw = acLines.join("\n");
            fs.writeFileSync(filePath, raw, "utf-8");
        }
        const frontmatter = parseIntentFrontmatter(raw);
        const acMatches = [...raw.matchAll(/^- \[([ x])\] \*\*AC(\d+):\*\* (.+)$/gm)];
        const acs = acMatches.map(m => ({
            index: parseInt(m[2], 10) - 1,
            done: m[1] === "x",
            text: m[3]
        }));
        const done = acs.filter(a => a.done).length;
        const summary = {
            work_item_id,
            file: match,
            status: frontmatter.status || "Draft",
            title: frontmatter.title || "",
            pm_owner: frontmatter.pm_owner || "TBD",
            risk: frontmatter.risk || "TBD",
            ticket_url: frontmatter.ticket_url || "",
            ac_progress: `${done}/${acs.length} complete`,
            acceptance_criteria: acs,
        };
        return appendTelemetry({
            content: [{
                    type: "text",
                    text: `## Intent: ${displayRef(work_item_id)}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n---\n### Full Intent Document\n\n${raw}`
                }]
        }, inputChars);
    });
    // ─── Tool 5: manage_task ─────────────────────────────────────────────────────
    server.tool("manage_task", "Manages structured task records in .secufusion/tasks/<ticket-ref>-<title>/ (e.g. BUG-1230-short-title, type kept exactly). Each task gets its own folder with spec, progress, decisions, files-touched, and scenarios files. Use this instead of manage_branch_state for all new work items.", {
        action: z
            .enum(["initialize", "read", "update_spec", "add_scenario", "log_file_touched", "log_decision", "complete", "read_summary"])
            .describe("Action: initialize (create task folder + files), read (full task data), update_spec (edit spec fields), add_scenario (append test scenario), log_file_touched (record modified file), log_decision (record architectural decision), complete (mark done + generate PR summary), read_summary (token-efficient summary)."),
        work_item_id: z.string().describe(WORK_ITEM_ID_DESC + " Used to name the task folder, e.g. BUG-1230-short-title."),
        title: z.string().optional().describe("Task title. Required for 'initialize'."),
        description: z.string().optional().describe("Task description. Used with 'initialize' or 'update_spec'."),
        acceptance_criteria: z.array(z.string()).optional().describe("Array of AC strings. Used with 'initialize' or 'update_spec'."),
        pending_acs: z.array(z.string()).optional().describe("Pending AC list. Used with 'update_spec'."),
        completed_acs: z.array(z.string()).optional().describe("Completed AC list. Used with 'update_spec'."),
        next_step: z.string().optional().describe("Next actionable step. Required for 'update_spec'."),
        tags: z.array(z.string()).optional().describe("Tags for searchability, e.g. ['tenant', 'iam', 'security']."),
        task_type: z.enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"]).optional().describe("Type of work item. Persisted to spec.json so search_tasks and filter_type work correctly. Pass on initialize and wherever classify_task supplies it."),
        file_path: z.string().optional().describe("File path to log. Used with 'log_file_touched'."),
        change_summary: z.string().optional().describe("One-line summary of the change. Used with 'log_file_touched'."),
        decision: z.string().optional().describe("Architectural decision to record. Used with 'log_decision'."),
        rationale: z.string().optional().describe("Why this decision was made. Used with 'log_decision'."),
        scenario: z.string().optional().describe("Test scenario description. Used with 'add_scenario'."),
        scenario_type: z.enum(["unit", "integration", "e2e", "manual"]).optional().describe("Test scenario type. Used with 'add_scenario'."),
    }, async ({ action, work_item_id, title, description, acceptance_criteria, pending_acs, completed_acs, next_step, tags, task_type, file_path, change_summary, decision, rationale, scenario, scenario_type }) => {
        const inputChars = JSON.stringify({ action, work_item_id, title, description, acceptance_criteria, pending_acs, completed_acs, next_step, tags, task_type, file_path, change_summary, decision, rationale, scenario, scenario_type }).length;
        const identityClash = findRegistryConflict(readRegistry(), work_item_id);
        if (identityClash)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: identityConflictMessage(work_item_id, identityClash) }] }, inputChars);
        const tasksRoot = resolve(TASKS_DIR);
        let dir = resolveTaskFolder(work_item_id, tasksRoot);
        if (action === "initialize" || action === "complete") {
            const needed = action === "initialize"
                ? ["philosophy", "intent"]
                : ["philosophy", "intent", "classification", "requirement", "plan", "review"];
            const gateError = requireGates(getWorkspaceRoot(), work_item_id, needed, action === "initialize" ? "initialize the task" : "complete the task");
            if (gateError)
                return appendTelemetry(textResult(gateError, true), inputChars);
            if (action === "complete") {
                // the review only covers what it saw: code changed after the verdict has not been reviewed
                const stale = reviewStalenessFor(getWorkspaceRoot(), work_item_id);
                if (stale?.stale) {
                    return appendTelemetry(textResult(`⛔ REVIEW STALE: the review of ${displayRef(work_item_id)} passed, but code changed after it.\n${describeStaleness(stale)}\n\n${STALE_NEXT}`, true), inputChars);
                }
            }
        }
        if (action === "initialize") {
            if (!title)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'title' is required for action=initialize." }] }, inputChars);
            if (!dir)
                dir = generateNewTaskFolder(work_item_id, title, tasksRoot);
        }
        if (!dir && action !== "initialize") {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task ${displayRef(work_item_id)} not found in ${tasksRoot}. Has it been initialized?` }] }, inputChars);
        }
        const specPath = path.join(dir, "spec.json");
        const progressPath = path.join(dir, "progress.json");
        const decisionsPath = path.join(dir, "decisions.json");
        const filesPath = path.join(dir, "files-touched.json");
        const scenariosPath = path.join(dir, "scenarios.json");
        const prSummaryPath = path.join(dir, "pr-summary.md");
        if (action === "initialize") {
            if (!title)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'title' is required for action=initialize." }] }, inputChars);
            const now = new Date().toISOString();
            const spec = { work_item_id, title, description: description || "", acceptance_criteria: acceptance_criteria || [], tags: tags || [], task_type: task_type || "unknown", created_at: now, status: "active" };
            const progress = { pending_acs: acceptance_criteria || [], completed_acs: [], next_step: "Review spec and begin implementation.", last_updated: now };
            if (!fs.existsSync(specPath)) {
                writeFile(specPath, JSON.stringify(spec, null, 2));
                writeFile(progressPath, JSON.stringify(progress, null, 2));
                writeFile(decisionsPath, JSON.stringify([], null, 2));
                writeFile(filesPath, JSON.stringify([], null, 2));
                writeFile(scenariosPath, JSON.stringify([], null, 2));
            }
            upsertRegistry({ work_item_id, title, status: "active", created_at: now, tags: tags || [], task_type: task_type || "unknown", folder: path.basename(dir) });
            return appendTelemetry({ content: [{ type: "text", text: `✅ Task ${displayRef(work_item_id)} initialized.\n\n**Folder:** ${dir}\n**Title:** ${title}\n**Type:** ${task_type || "unknown"}\n**ACs:** ${(acceptance_criteria || []).length}\n\n${JSON.stringify(spec, null, 2)}` }] }, inputChars);
        }
        if (!fs.existsSync(specPath)) {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `ERROR: Task ${displayRef(work_item_id)} not found. Call action=initialize first.\n\nExpected folder: ${dir}` }] }, inputChars);
        }
        if (action === "read") {
            const specObj = readJson(specPath) || {};
            const decisions = readJson(decisionsPath) || [];
            const files = readJson(filesPath) || [];
            const scenarios = readJson(scenariosPath) || [];
            let out = `## Task ${work_item_id} (Thin Index)\n\n`;
            out += `**Title:** ${specObj.title || 'unknown'}\n\n`;
            out += `To optimize context, full task JSON is not returned. Use \`view_file\` on the following absolute paths if you need details:\n`;
            out += `- **Spec**: ${specPath}\n`;
            out += `- **Progress**: ${progressPath}\n`;
            out += `- **Decisions** (${decisions.length}): ${decisionsPath}\n`;
            out += `- **Files Touched** (${files.length}): ${filesPath}\n`;
            out += `- **Scenarios** (${scenarios.length}): ${scenariosPath}\n`;
            return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
        }
        if (action === "read_summary") {
            const spec = readJson(specPath) || {};
            const progress = readJson(progressPath) || {};
            const files = readJson(filesPath) || [];
            const summary = { work_item_id, title: spec["title"], status: spec["status"], pending_acs: progress["pending_acs"] || [], completed_acs: progress["completed_acs"] || [], next_step: progress["next_step"], files_touched_count: files.length };
            return appendTelemetry({ content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] }, inputChars);
        }
        if (action === "update_spec") {
            if (!next_step)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'next_step' is required for action=update_spec." }] }, inputChars);
            const now = new Date().toISOString();
            if (description !== undefined || acceptance_criteria !== undefined || tags !== undefined || task_type !== undefined) {
                const spec = readJson(specPath) || {};
                if (description !== undefined)
                    spec["description"] = description;
                if (acceptance_criteria !== undefined)
                    spec["acceptance_criteria"] = acceptance_criteria;
                if (tags !== undefined)
                    spec["tags"] = tags;
                if (task_type !== undefined) {
                    spec["task_type"] = task_type;
                    upsertRegistry({ work_item_id, task_type });
                }
                writeFile(specPath, JSON.stringify(spec, null, 2));
            }
            const progress = readJson(progressPath) || {};
            if (pending_acs !== undefined)
                progress["pending_acs"] = pending_acs;
            if (completed_acs !== undefined)
                progress["completed_acs"] = completed_acs;
            progress["next_step"] = next_step;
            progress["last_updated"] = now;
            writeFile(progressPath, JSON.stringify(progress, null, 2));
            return appendTelemetry({ content: [{ type: "text", text: `✅ Task ${displayRef(work_item_id)} updated.\n\n> **Next step:** ${next_step}\n\n**Progress:**\n${JSON.stringify(progress, null, 2)}` }] }, inputChars);
        }
        if (action === "log_file_touched") {
            if (!file_path)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'file_path' is required for action=log_file_touched." }] }, inputChars);
            const files = readJson(filesPath) || [];
            const existing = files.findIndex((f) => f["file_path"] === file_path);
            const entry = { file_path, change_summary: change_summary || "", logged_at: new Date().toISOString() };
            if (existing === -1)
                files.push(entry);
            else
                files[existing] = entry;
            writeFile(filesPath, JSON.stringify(files, null, 2));
            return appendTelemetry({ content: [{ type: "text", text: `✅ File logged for ${displayRef(work_item_id)}:\n\`${file_path}\` — ${change_summary || "(no summary)"}` }] }, inputChars);
        }
        if (action === "log_decision") {
            if (!decision)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'decision' is required for action=log_decision." }] }, inputChars);
            const decisions = readJson(decisionsPath) || [];
            decisions.push({ id: decisions.length + 1, decision, rationale: rationale || "", logged_at: new Date().toISOString() });
            writeFile(decisionsPath, JSON.stringify(decisions, null, 2));
            return appendTelemetry({ content: [{ type: "text", text: `✅ Decision #${decisions.length} logged for ${displayRef(work_item_id)}:\n**Decision:** ${decision}\n**Rationale:** ${rationale || "(none)"}` }] }, inputChars);
        }
        if (action === "add_scenario") {
            if (!scenario)
                return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'scenario' is required for action=add_scenario." }] }, inputChars);
            const scenarios = readJson(scenariosPath) || [];
            scenarios.push({ id: scenarios.length + 1, type: scenario_type || "manual", scenario, added_at: new Date().toISOString() });
            writeFile(scenariosPath, JSON.stringify(scenarios, null, 2));
            return appendTelemetry({ content: [{ type: "text", text: `✅ Scenario #${scenarios.length} added to ${displayRef(work_item_id)}:\n[${scenario_type || "manual"}] ${scenario}` }] }, inputChars);
        }
        if (action === "complete") {
            const spec = readJson(specPath) || {};
            const progress = readJson(progressPath) || {};
            const decisions = readJson(decisionsPath) || [];
            const files = readJson(filesPath) || [];
            const scenarios = readJson(scenariosPath) || [];
            spec["status"] = "complete";
            writeFile(specPath, JSON.stringify(spec, null, 2));
            progress["completed_at"] = new Date().toISOString();
            writeFile(progressPath, JSON.stringify(progress, null, 2));
            upsertRegistry({ work_item_id, status: "complete" });
            // an engineering change summary assembled from recorded state (plus any narrative saved by generate_pr_summary), not a file-change list
            const prSummary = buildPrSummary({ workspaceRoot: getWorkspaceRoot(), ecosystemRoot: getEcosystemRoot(getWorkspaceRoot()), id: work_item_id, taskDir: dir, completedAt: progress["completed_at"] });
            writeFile(prSummaryPath, prSummary);
            let retroMessage = "";
            try {
                const classificationFile = path.join(resolve(CLASSIFICATIONS_DIR), `${work_item_id}.json`);
                const classificationData = fs.existsSync(classificationFile) ? readJson(classificationFile) : {};
                let migration_risk_predicted = "NONE";
                let breaking_changes_predicted = 0;
                const rollbackDecision = decisions.find(d => (d["decision"] || "").toLowerCase().includes("rollback strategy"));
                if (rollbackDecision) {
                    const match = rollbackDecision["decision"].match(/\[(SAFE|RISKY|DANGEROUS)\]/i);
                    if (match)
                        migration_risk_predicted = match[1].toUpperCase();
                }
                const breakingDecision = decisions.find(d => (d["decision"] || "").toLowerCase().includes("breaking changes predicted"));
                if (breakingDecision) {
                    const match = breakingDecision["decision"].match(/(\d+)/);
                    if (match)
                        breaking_changes_predicted = parseInt(match[1], 10);
                }
                const sad_paths = scenarios.filter(s => s["type"] === "e2e" || s["scenario"]?.toString().toLowerCase().includes("sad")).length;
                const edge_cases = scenarios.filter(s => s["scenario"]?.toString().toLowerCase().includes("edge")).length;
                const security_cases = scenarios.filter(s => s["scenario"]?.toString().toLowerCase().includes("security")).length;
                const partialRetro = {
                    status: "partial — awaiting developer input",
                    work_item_id,
                    task_title: spec["title"] || "",
                    branch: "",
                    completed_at: progress["completed_at"],
                    classification: {
                        predicted: classificationData["dominant_tier"] || "",
                        predicted_confidence: classificationData["confidence"] || "",
                        predicted_score_backend: classificationData["backend_score"] || 0,
                        predicted_score_frontend: classificationData["frontend_score"] || 0,
                        was_correct: null,
                        correction_notes: null
                    },
                    plan_vs_actual: {
                        steps_planned: files.length,
                        steps_actual: null,
                        steps_accuracy_pct: null,
                        files_planned: files.map(f => f["file_path"]),
                        files_actual: [],
                        unplanned_files: null,
                        missed_files: null,
                        migration_risk_predicted,
                        migration_risk_actual: null,
                        migration_prediction_correct: null,
                        breaking_changes_predicted,
                        breaking_changes_actual: null,
                        breaking_prediction_correct: null,
                        performance_risk_predicted: "",
                        performance_issues_found: null,
                        performance_prediction_correct: null
                    },
                    scenarios: {
                        sad_paths_planned: sad_paths,
                        sad_paths_covered_in_tests: null,
                        edge_cases_planned: edge_cases,
                        edge_cases_covered_in_tests: null,
                        security_cases_planned: security_cases,
                        security_cases_covered_in_tests: null,
                        scenario_coverage_pct: null
                    },
                    effort: {
                        acs_planned: (spec["acceptance_criteria"] || []).length,
                        acs_completed: (progress["completed_acs"] || []).length,
                        acs_added_during_work: null,
                        acs_removed_during_work: null,
                        scope_creep_detected: null,
                        scope_creep_description: null
                    },
                    quality: {
                        pre_pr_checks_passed_first_attempt: null,
                        pre_pr_attempts_needed: null,
                        checks_that_failed: null,
                        rejected_patterns_triggered: null,
                        linter_errors_found: null
                    },
                    learnings: {
                        what_went_well: null,
                        what_was_harder_than_expected: null,
                        signals_that_should_have_been_caught: null,
                        plan_sections_that_were_wrong: null
                    },
                    classifier_feedback: null
                };
                writeFile(path.join(dir, "retrospective.json"), JSON.stringify(partialRetro, null, 2));
                retroMessage = `\n─────────────────────────────────────────\n📊 RETROSPECTIVE STARTED\n\nA partial retrospective has been saved.\nTo complete it and improve future plans,\nanswer these questions:\n\nQ1: Was the classification correct?\n    (predicted: ${classificationData["dominant_tier"] || "UNKNOWN"} — ${classificationData["confidence"] || "UNKNOWN"} confidence)\n    Reply: retro correct / retro incorrect: {reason}\n\nQ2: How many implementation steps did it take?\n    (planned: ${files.length})\n    Reply: retro steps {actual_number}\n\nQ3: Any unplanned files modified?\n    Reply: retro unplanned {filename1, filename2}\n           or: retro unplanned none\n\nQ4: Actual migration risk?\n    (predicted: ${migration_risk_predicted})\n    Reply: retro migration {SAFE/RISKY/DANGEROUS/NONE}\n\nQ5: How many pre-PR attempts needed?\n    Reply: retro attempts {number}\n\nQ6: Any scope creep?\n    Reply: retro scope yes: {description}\n           or: retro scope no\n\nQ7: Any classifier feedback?\n    Reply: retro signal missing {term}\n           or: retro signal noise {term}\n           or: retro phrase {phrase that would help}\n           or: retro skip\n\nYou can answer all at once or skip with: retro skip\n─────────────────────────────────────────`;
            }
            catch (err) {
                console.warn("Auto-retrospective failed:", err);
            }
            return appendTelemetry({ content: [{ type: "text", text: `✅ Task ${displayRef(work_item_id)} marked complete.\n\n**PR summary generated:** ${prSummaryPath}\n\n${prSummary}\n${retroMessage}` }] }, inputChars);
        }
        return appendTelemetry({ content: [{ type: "text", text: "Invalid action." }] }, inputChars);
    });
    // ─── generate_pr_summary: the PR summary as an engineering change summary ───
    server.tool("generate_pr_summary", "Writes pr-summary.md as an ENGINEERING CHANGE SUMMARY for a reviewer who has never seen the work item: the problem, how it was investigated, the root cause, the options weighed and why one was chosen, " +
        "how the final design works, what was resolved, behavior before and after (including multi-instance behavior), tests executed and results, remaining risks and release considerations, business impact, " +
        "then the files as a reference. Assembled from recorded state (requirement, plan, decisions, scenarios, test results, gate ledger); anything the record does not hold says 'Not recorded'. " +
        "Pass `narrative` for what only the author knows (options evaluated, behavior before/after, business impact); it is saved beside the task and shown as Author notes, " +
        "and manage_task action=complete re-renders with it. Supply only what you actually know from the work; never pad it.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        work_item_id: z.string().describe(WORK_ITEM_ID_DESC),
        narrative: z.object({
            problem: z.string().optional().describe("What problem existed, in plain words"),
            investigation: z.array(z.string()).optional().describe("How it was investigated, in order"),
            root_cause: z.string().optional(),
            options: z.array(z.object({
                option: z.string(),
                verdict: z.enum(["selected", "rejected", "deferred"]),
                why: z.string().describe("Why it was accepted or rejected"),
            })).optional().describe("Architectural options evaluated"),
            why_selected: z.string().optional().describe("Why the selected design won over the rejected ones"),
            how_it_works: z.string().optional().describe("How the final design works"),
            issues_resolved: z.array(z.string()).optional(),
            behavior_before: z.string().optional().describe("Behavior before the change, including multi-instance (replica) behavior where relevant"),
            behavior_after: z.string().optional().describe("Behavior after the change, including multi-instance behavior where relevant"),
            tests_run: z.array(z.object({ what: z.string(), result: z.string() })).optional().describe("Tests actually executed and their results"),
            risks: z.array(z.string()).optional().describe("Risks that remain"),
            release_considerations: z.array(z.string()).optional(),
            business_impact: z.string().optional(),
        }).optional().describe("What only the author knows. Merged into any narrative saved earlier."),
        dry_run: z.boolean().optional().describe("Return the summary without writing pr-summary.md or saving the narrative"),
    }, async ({ workspace_root, work_item_id, narrative, dry_run }) => {
        try {
            const identityClash = findRegistryConflict(readRegistry(), work_item_id);
            if (identityClash)
                return textResult(identityConflictMessage(work_item_id, identityClash), true);
            const dir = resolveTaskFolder(work_item_id, resolve(TASKS_DIR));
            if (!dir)
                return textResult(`Task ${displayRef(work_item_id)} not found in ${resolve(TASKS_DIR)}. Has it been initialized?`, true);
            const merged = mergeNarrative(loadNarrative(dir), narrative ?? {});
            const md = buildPrSummary({ workspaceRoot: getWorkspaceRoot(), ecosystemRoot: getEcosystemRoot(workspace_root), id: work_item_id, taskDir: dir, narrative: merged });
            let note = "";
            if (!dry_run) {
                writeFile(path.join(dir, "pr-summary.md"), md);
                if (narrative)
                    writeFile(path.join(dir, NARRATIVE_FILE), JSON.stringify(merged, null, 2));
                note = `📄 Written: ${path.join(dir, "pr-summary.md").split(path.sep).join("/")}\n`;
            }
            const missing = ["problem", "root_cause", "options", "why_selected", "behavior_before", "behavior_after", "business_impact"].filter((k) => !merged[k] || merged[k]?.length === 0);
            const hint = missing.length ? `\nℹ️ Author notes not yet supplied: ${missing.join(", ")}. Add them with \`narrative\` if you know them from the work; otherwise they stay "Not recorded".\n` : "";
            return textResult(`${note}${hint}\n---\n${md}`);
        }
        catch (e) {
            return textResult(`Error: ${e.message}`, true);
        }
    });
    // ─── Tool 6: get_task_history ─────────────────────────────────────────────────
    server.tool("get_task_history", "Retrieve the full history of a past task — spec, decisions, files touched, and scenarios. Use before starting similar work to understand how it was done before.", { work_item_id: z.string().describe("Work item ID of the past task to retrieve.") }, async ({ work_item_id }) => {
        const inputChars = JSON.stringify({ work_item_id }).length;
        const tasksRoot = resolve(TASKS_DIR);
        const dir = resolveTaskFolder(work_item_id, tasksRoot);
        if (!dir) {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task ${displayRef(work_item_id)} not found in ${tasksRoot}. Has it been initialized? Run manage_task action=initialize first.` }] }, inputChars);
        }
        const history = {
            spec: readJson(path.join(dir, "spec.json")),
            progress: readJson(path.join(dir, "progress.json")),
            decisions: readJson(path.join(dir, "decisions.json")),
            files_touched: readJson(path.join(dir, "files-touched.json")),
            scenarios: readJson(path.join(dir, "scenarios.json")),
        };
        return appendTelemetry({ content: [{ type: "text", text: JSON.stringify(history, null, 2) }] }, inputChars);
    });
    // ─── Tool 7: search_tasks ─────────────────────────────────────────────────────
    server.tool("search_tasks", "Search all past tasks by keyword. Scans registry and task file contents. Use before starting a new task to find related past work and avoid re-solving solved problems.", {
        keywords: z.string().describe("Space-separated search keywords, e.g. 'tenant isolation repository'."),
        status_filter: z.enum(["active", "complete", "any"]).optional().default("any").describe("Filter results by task status."),
    }, async ({ keywords, status_filter = "any" }) => {
        const inputChars = JSON.stringify({ keywords, status_filter }).length;
        const registry = readRegistry();
        if (registry.length === 0)
            return appendTelemetry({ content: [{ type: "text", text: "No tasks found in registry. Initialize tasks first." }] }, inputChars);
        const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = [];
        const tasksRoot = resolve(TASKS_DIR);
        for (const entry of registry) {
            if (status_filter !== "any" && entry["status"] !== status_filter)
                continue;
            const dir = resolveTaskFolder(entry["work_item_id"], tasksRoot, registry);
            if (!dir)
                continue;
            const blobs = [
                JSON.stringify(entry),
                readFileSafe(path.join(dir, "spec.json")) || "",
                readFileSafe(path.join(dir, "progress.json")) || "",
                readFileSafe(path.join(dir, "decisions.json")) || "",
                readFileSafe(path.join(dir, "files-touched.json")) || "",
                readFileSafe(path.join(dir, "scenarios.json")) || "",
            ].join(" ").toLowerCase();
            const hitCount = terms.filter(t => blobs.includes(t)).length;
            if (hitCount > 0) {
                const spec = readJson(path.join(dir, "spec.json")) || {};
                matches.push({ work_item_id: entry["work_item_id"], title: entry["title"], status: entry["status"], tags: entry["tags"] || [], keyword_hits: hitCount, description_excerpt: (spec["description"] || "").slice(0, 120) });
            }
        }
        matches.sort((a, b) => b["keyword_hits"] - a["keyword_hits"]);
        if (matches.length === 0)
            return appendTelemetry({ content: [{ type: "text", text: `No tasks matched keywords: "${keywords}"` }] }, inputChars);
        return appendTelemetry({ content: [{ type: "text", text: `Found ${matches.length} task(s) matching "${keywords}":\n\n${JSON.stringify(matches, null, 2)}` }] }, inputChars);
    });
    // ─── Tool 8: get_pattern_from_task ────────────────────────────────────────────
    server.tool("get_pattern_from_task", "Extract reusable implementation patterns from a completed task — decisions made, files modified, and test scenarios used. Call this before implementing something similar to a past feature.", { work_item_id: z.string().describe("Work item ID of the past task to extract patterns from.") }, async ({ work_item_id }) => {
        const inputChars = JSON.stringify({ work_item_id }).length;
        const tasksRoot = resolve(TASKS_DIR);
        const dir = resolveTaskFolder(work_item_id, tasksRoot);
        if (!dir)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task ${displayRef(work_item_id)} not found. Cannot extract patterns.` }] }, inputChars);
        const spec = readJson(path.join(dir, "spec.json")) || {};
        const decisions = readJson(path.join(dir, "decisions.json")) || [];
        const files = readJson(path.join(dir, "files-touched.json")) || [];
        const scenarios = readJson(path.join(dir, "scenarios.json")) || [];
        const patterns = {
            source_task: { work_item_id, title: spec["title"], status: spec["status"] },
            architectural_decisions: decisions.map(d => ({ decision: d["decision"], rationale: d["rationale"] })),
            files_pattern: files.map(f => f["file_path"]),
            test_patterns: scenarios.map(s => ({ type: s["type"], scenario: s["scenario"] })),
            tags: spec["tags"] || [],
        };
        return appendTelemetry({ content: [{ type: "text", text: `**Patterns from ${displayRef(work_item_id)}: ${spec["title"] || ""}**\n\n${JSON.stringify(patterns, null, 2)}` }] }, inputChars);
    });
    // ─── Tool 8.5: record_retrospective ───────────────────────────────────────────
    server.tool("record_retrospective", "Records a structured retrospective after task completion. Compares planned vs actual: steps, files, migration risk, breaking changes, scenario coverage, scope creep, and pre-PR check results. Accumulates insights in .secufusion/retrospective-insights.json to make classify_task smarter over time. Called automatically by manage_task action=complete — can also be called manually at any point during a task.", {
        work_item_id: z.string().describe("Azure DevOps work item ID."),
        classification_correct: z.boolean().describe("Was the classify_task classification correct? true = matched actual work done, false = wrong or misleading"),
        classification_correction_notes: z.string().optional().describe("Only if classification_correct=false. What was wrong and what the correct classification should have been."),
        steps_actual: z.number().describe("How many implementation steps were actually needed."),
        unplanned_files: z.array(z.string()).optional().describe("Files that were modified but NOT in the plan."),
        missed_files: z.array(z.string()).optional().describe("Files that were in the plan but NOT touched."),
        migration_risk_actual: z.string().optional().describe("Actual migration script risk encountered. 'SAFE' | 'RISKY' | 'DANGEROUS' | 'NONE'"),
        breaking_changes_actual: z.number().optional().describe("How many actual breaking changes were found. 0 if none."),
        performance_issues_found: z.boolean().optional().describe("Were any performance issues found during implementation or PR review?"),
        pre_pr_attempts: z.number().describe("How many times /sfn:review was called before all checks passed. 1 = passed first attempt (perfect), 2+ = needed fixes"),
        checks_that_failed: z.array(z.string()).optional().describe("List of check names that failed at least once."),
        scope_creep_detected: z.boolean().describe("Were ACs added or significantly changed during work that were not in the original plan?"),
        scope_creep_description: z.string().optional().describe("Only if scope_creep_detected=true. What changed and why."),
        what_went_well: z.array(z.string()).optional().describe("Things that worked exactly as planned."),
        what_was_harder: z.array(z.string()).optional().describe("Things that took more effort than expected."),
        classifier_feedback: z.object({
            signal_missing: z.string().optional(),
            signal_noise: z.string().optional(),
            root_cause_phrase: z.string().optional(),
            bug_category: z.string().optional(),
            tier_upgrade: z.string().optional()
        }).optional().describe("Feedback to improve classify_task for future tasks.")
    }, async (params) => {
        const inputChars = JSON.stringify(params).length;
        const { work_item_id, classification_correct, classification_correction_notes, steps_actual, unplanned_files = [], missed_files = [], migration_risk_actual, breaking_changes_actual, performance_issues_found, pre_pr_attempts, checks_that_failed = [], scope_creep_detected, scope_creep_description, what_went_well = [], what_was_harder = [], classifier_feedback } = params;
        const tasksRoot = resolve(TASKS_DIR);
        const dir = resolveTaskFolder(work_item_id, tasksRoot);
        if (!dir)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task ${displayRef(work_item_id)} not found.` }] }, inputChars);
        const spec = readJson(path.join(dir, "spec.json")) || {};
        const progress = readJson(path.join(dir, "progress.json")) || {};
        const decisions = readJson(path.join(dir, "decisions.json")) || [];
        const files = readJson(path.join(dir, "files-touched.json")) || [];
        const scenarios = readJson(path.join(dir, "scenarios.json")) || [];
        const classificationFile = path.join(resolve(CLASSIFICATIONS_DIR), `${work_item_id}.json`);
        const classificationData = readJson(classificationFile) || {};
        const acs_planned = (spec["acceptance_criteria"] || []).length;
        const acs_completed = (progress["completed_acs"] || []).length;
        const acs_added_during_work = acs_completed - acs_planned;
        let migration_risk_predicted = "NONE";
        let breaking_changes_predicted = 0;
        const rollbackDecision = decisions.find(d => (d["decision"] || "").toLowerCase().includes("rollback strategy"));
        if (rollbackDecision) {
            const match = rollbackDecision["decision"].match(/\[(SAFE|RISKY|DANGEROUS)\]/i);
            if (match)
                migration_risk_predicted = match[1].toUpperCase();
        }
        const breakingDecision = decisions.find(d => (d["decision"] || "").toLowerCase().includes("breaking changes predicted"));
        if (breakingDecision) {
            const match = breakingDecision["decision"].match(/(\d+)/);
            if (match)
                breaking_changes_predicted = parseInt(match[1], 10);
        }
        const sad_paths = scenarios.filter(s => s["type"] === "e2e" || s["scenario"]?.toString().toLowerCase().includes("sad")).length;
        const edge_cases = scenarios.filter(s => s["scenario"]?.toString().toLowerCase().includes("edge")).length;
        const security_cases = scenarios.filter(s => s["scenario"]?.toString().toLowerCase().includes("security")).length;
        const files_planned = files.map(f => f["file_path"]);
        const steps_planned = files.length;
        const steps_accuracy_pct = steps_planned === 0 && steps_actual === 0 ? 100 : Math.round((Math.min(steps_planned, steps_actual) / Math.max(steps_planned, steps_actual)) * 100);
        const scenario_coverage_pct = scenarios.length === 0 ? 100 : Math.round((files.length / scenarios.length) * 100);
        const migration_prediction_correct = migration_risk_actual === migration_risk_predicted || (!migration_risk_actual && migration_risk_predicted === "NONE");
        const breaking_prediction_correct = breaking_changes_actual === breaking_changes_predicted || (!breaking_changes_actual && breaking_changes_predicted === 0);
        const retro = {
            work_item_id,
            task_title: spec["title"] || "",
            branch: "",
            completed_at: new Date().toISOString(),
            classification: {
                predicted: classificationData["dominant_tier"] || "",
                predicted_confidence: classificationData["confidence"] || "",
                predicted_score_backend: classificationData["backend_score"] || 0,
                predicted_score_frontend: classificationData["frontend_score"] || 0,
                was_correct: classification_correct,
                correction_notes: classification_correction_notes || ""
            },
            plan_vs_actual: {
                steps_planned,
                steps_actual,
                steps_accuracy_pct,
                files_planned,
                files_actual: files.map(f => f["file_path"]),
                unplanned_files,
                missed_files,
                migration_risk_predicted,
                migration_risk_actual: migration_risk_actual || "",
                migration_prediction_correct,
                breaking_changes_predicted,
                breaking_changes_actual: breaking_changes_actual || 0,
                breaking_prediction_correct,
                performance_risk_predicted: "",
                performance_issues_found: performance_issues_found || false,
                performance_prediction_correct: !performance_issues_found
            },
            scenarios: {
                sad_paths_planned: sad_paths,
                sad_paths_covered_in_tests: sad_paths,
                edge_cases_planned: edge_cases,
                edge_cases_covered_in_tests: edge_cases,
                security_cases_planned: security_cases,
                security_cases_covered_in_tests: security_cases,
                scenario_coverage_pct
            },
            effort: {
                acs_planned,
                acs_completed,
                acs_added_during_work: Math.max(0, acs_added_during_work),
                acs_removed_during_work: Math.max(0, -acs_added_during_work),
                scope_creep_detected,
                scope_creep_description: scope_creep_description || ""
            },
            quality: {
                pre_pr_checks_passed_first_attempt: pre_pr_attempts === 1,
                pre_pr_attempts_needed: pre_pr_attempts,
                checks_that_failed,
                rejected_patterns_triggered: [],
                linter_errors_found: 0
            },
            learnings: {
                what_went_well,
                what_was_harder_than_expected: what_was_harder,
                signals_that_should_have_been_caught: [],
                plan_sections_that_were_wrong: []
            },
            classifier_feedback: classifier_feedback || {}
        };
        writeFile(path.join(dir, "retrospective.json"), JSON.stringify(retro, null, 2));
        const insightsFile = resolve(".secufusion/retrospective-insights.json");
        let insights = {
            total_tasks_completed: 0,
            last_updated: "",
            classification_accuracy: { total_classified: 0, correct: 0, incorrect: 0, accuracy_pct: 0, most_common_misclassification: "" },
            plan_accuracy: { avg_steps_planned: 0, avg_steps_actual: 0, avg_step_accuracy_pct: 0, avg_files_unplanned: 0, migration_risk_accuracy_pct: 0, breaking_change_accuracy_pct: 0 },
            quality_trends: { avg_pre_pr_attempts: 0, most_common_failed_check: "", most_triggered_rejected_pattern: "" },
            scenario_coverage: { avg_sad_path_coverage_pct: 0, avg_edge_case_coverage_pct: 0, most_missed_scenario_type: "" },
            scope_creep: { tasks_with_scope_creep: 0, avg_acs_added_during_work: 0 },
            classifier_learning_queue: [],
            task_history: []
        };
        if (fs.existsSync(insightsFile)) {
            insights = readJson(insightsFile) || insights;
        }
        const n = insights.total_tasks_completed + 1;
        insights.total_tasks_completed = n;
        insights.last_updated = new Date().toISOString();
        insights.classification_accuracy.total_classified += 1;
        if (classification_correct) {
            insights.classification_accuracy.correct += 1;
        }
        else {
            insights.classification_accuracy.incorrect += 1;
        }
        insights.classification_accuracy.accuracy_pct = Math.round((insights.classification_accuracy.correct / insights.classification_accuracy.total_classified) * 100);
        insights.plan_accuracy.avg_steps_planned = Math.round(((insights.plan_accuracy.avg_steps_planned * (n - 1)) + steps_planned) / n);
        insights.plan_accuracy.avg_steps_actual = Math.round(((insights.plan_accuracy.avg_steps_actual * (n - 1)) + steps_actual) / n);
        insights.plan_accuracy.avg_step_accuracy_pct = Math.round(((insights.plan_accuracy.avg_step_accuracy_pct * (n - 1)) + steps_accuracy_pct) / n);
        insights.plan_accuracy.avg_files_unplanned = Math.round(((insights.plan_accuracy.avg_files_unplanned * (n - 1)) + unplanned_files.length) / n);
        const migRiskCorrect = migration_prediction_correct ? 100 : 0;
        insights.plan_accuracy.migration_risk_accuracy_pct = Math.round(((insights.plan_accuracy.migration_risk_accuracy_pct * (n - 1)) + migRiskCorrect) / n);
        const breakRiskCorrect = breaking_prediction_correct ? 100 : 0;
        insights.plan_accuracy.breaking_change_accuracy_pct = Math.round(((insights.plan_accuracy.breaking_change_accuracy_pct * (n - 1)) + breakRiskCorrect) / n);
        insights.quality_trends.avg_pre_pr_attempts = Math.round(((insights.quality_trends.avg_pre_pr_attempts * (n - 1)) + pre_pr_attempts) / n);
        if (scope_creep_detected)
            insights.scope_creep.tasks_with_scope_creep += 1;
        insights.scope_creep.avg_acs_added_during_work = Math.round(((insights.scope_creep.avg_acs_added_during_work * (n - 1)) + Math.max(0, acs_added_during_work)) / n);
        insights.task_history.push({
            work_item_id,
            title: spec["title"] || "",
            completed_at: retro.completed_at,
            classification_correct,
            step_accuracy_pct: steps_accuracy_pct,
            pre_pr_attempts,
            scope_creep: scope_creep_detected
        });
        if (insights.task_history.length > 50)
            insights.task_history.shift();
        if (classifier_feedback) {
            for (const [key, value] of Object.entries(classifier_feedback)) {
                if (value) {
                    let signalType = key.replace('signal_', '');
                    if (key === 'root_cause_phrase')
                        signalType = 'phrase';
                    else if (key === 'bug_category')
                        signalType = 'bug_category';
                    else if (key === 'tier_upgrade')
                        signalType = 'tier_upgrade';
                    const existing = insights.classifier_learning_queue.find((q) => q.signal_type === signalType && q.signal_value === value);
                    if (existing) {
                        existing.frequency += 1;
                    }
                    else {
                        insights.classifier_learning_queue.push({
                            from_task: work_item_id,
                            signal_type: signalType,
                            signal_value: value,
                            frequency: 1,
                            applied: false
                        });
                    }
                }
            }
        }
        if (!fs.existsSync(resolve(".secufusion")))
            fs.mkdirSync(resolve(".secufusion"), { recursive: true });
        writeFile(insightsFile, JSON.stringify(insights, null, 2));
        let out = `📊 RETROSPECTIVE — ${work_item_id}: ${spec["title"] || ""}\n─────────────────────────────────────────\n\n`;
        out += `🎯 Classification\nPredicted : ${retro.classification.predicted} (${retro.classification.predicted_confidence} confidence)\n`;
        out += `Correct   : ${classification_correct ? "yes" : "no"}\n`;
        if (!classification_correct)
            out += `Should have been: ${classification_correction_notes}\n`;
        out += `\n📋 Plan Accuracy\nSteps     : Planned ${steps_planned} → Actual ${steps_actual} (${steps_accuracy_pct}% accurate)\n`;
        out += `Files     : ${files_planned.length} planned, ${unplanned_files.length} unplanned, ${missed_files.length} missed\n`;
        out += `Migration : Predicted ${migration_risk_predicted} → Actual ${migration_risk_actual || "NONE"} ${migration_prediction_correct ? "✅" : "❌"}\n`;
        out += `Breaking  : Predicted ${breaking_changes_predicted} → Actual ${breaking_changes_actual || 0} ${breaking_prediction_correct ? "✅" : "❌"}\n`;
        out += `Performance: ${performance_issues_found ? "Issues found ❌" : "No issues ✅"}\n`;
        out += `\n✅ Quality\nPre-PR attempts : ${pre_pr_attempts} (${pre_pr_attempts === 1 ? "perfect" : "needed fixes"})\n`;
        out += `Checks failed   : ${checks_that_failed.length > 0 ? checks_that_failed.join(", ") : "none"}\n`;
        out += `Scope creep     : ${scope_creep_detected ? "yes" : "no"}\n`;
        if (scope_creep_detected)
            out += `${scope_creep_description}\n`;
        out += `\n🧪 Scenario Coverage\nSad paths    : ${sad_paths} planned → ${retro.scenarios.sad_paths_covered_in_tests} covered (${scenario_coverage_pct}%)\n`;
        out += `Edge cases   : ${edge_cases} planned → ${retro.scenarios.edge_cases_covered_in_tests} covered (${scenario_coverage_pct}%)\n`;
        out += `Security     : ${security_cases} planned → ${retro.scenarios.security_cases_covered_in_tests} covered (${scenario_coverage_pct}%)\n`;
        out += `\n💡 Learnings\nWent well    : ${what_went_well.length > 0 ? what_went_well.join(", ") : "none"}\n`;
        out += `Harder than expected: ${what_was_harder.length > 0 ? what_was_harder.join(", ") : "none"}\n`;
        out += `\n📈 Session Totals (from retrospective-insights.json)\nTasks completed   : ${insights.total_tasks_completed}\n`;
        out += `Avg plan accuracy : ${insights.plan_accuracy.avg_step_accuracy_pct}%\n`;
        out += `Avg pre-PR attempts: ${insights.quality_trends.avg_pre_pr_attempts}\n`;
        out += `Classification accuracy: ${insights.classification_accuracy.accuracy_pct}%\n`;
        out += `─────────────────────────────────────────\n`;
        if (classifier_feedback && Object.keys(classifier_feedback).length > 0) {
            out += `\n🧠 Classifier feedback queued:\n`;
            for (const [key, value] of Object.entries(classifier_feedback)) {
                if (value) {
                    let signalType = key.replace('signal_', '');
                    if (key === 'root_cause_phrase')
                        signalType = 'phrase';
                    else if (key === 'bug_category')
                        signalType = 'bug_category';
                    else if (key === 'tier_upgrade')
                        signalType = 'tier_upgrade';
                    const queued = insights.classifier_learning_queue.find((q) => q.signal_type === signalType && q.signal_value === value);
                    out += `${signalType}: '${value}'\nThis will improve future classify_task results.\n${queued?.frequency || 1} task(s) have reported this signal.\n`;
                }
            }
        }
        return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
    });
}

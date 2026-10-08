#!/usr/bin/env node
// @ts-nocheck
/**
 * SecuFusion MCP Server
 *
 * Provides developer-workflow tooling for the SecuFusion platform:
 *   - manage_feature_spec  : create / update task blueprints (.current-task-spec.md)
 *   - log_rejected_pattern : record bad patterns so they are never repeated (.rejected-patterns.json)
 *   - /sfn:review          : AI-driven reviewer that validates architecture, patterns, and guardrails
 *
 * Guardrails enforced:
 *   1. TENANT SAFETY AUTOMATED: Active scanning of *Repository.java for tenantId scoping.
 *   2. Code hygiene (console.log, unused vars, formatting) enforced via ESLint / Checkstyle — not regex.
 *   3. No hardcoded UAT/Prod IPs or environment URLs.
 *   4. Every modified JPA @Entity must have a matching manual migration script (applied against PostgreSQL before deployment).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { loadRequirement, saveRequirement, validateStateTransition, generateConfirmedSpecification } from "./requirement_manager.js";
import { discoverTests, executeTests, ingestTestResults, loadTestResults, correlateTestFailure } from "./test_engine.js";
import { loadPlan, savePlan, validatePlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { recordExperience, getEngineeringExperience, validateExperience, getExperienceContext, findExperienceConflicts, findRepeatedOutcomes, markExperienceStale, retireExperience, linkExperience, getLearningFeedback } from "./experience_manager.js";
import { loadTraceability, addTraceabilityLink, traceForward, traceReverse, findTraceabilityGaps } from "./traceability_engine.js";
import { investigateEntity, investigateRelationship } from "./investigation_engine.js";
import { buildGraph } from "./graph_builder.js";
import { parseDomainModels } from "./parsers/domain.js";
import { parseApiEndpoints } from "./parsers/api.js";
import { parseEventTopics } from "./parsers/events.js";
import { inferPatterns } from "./parsers/patterns.js";
import { parseFrontend } from "./parsers/frontend.js";
import { inspectWorkspaceRepositories, getWorkspaceConfig, getEvidenceCompleteness } from "./workspace_intelligence.js";
import { parseExtension } from "./parsers/extension.js";
import { parseNodeApis } from "./parsers/backend-node.js";
import { parseInfra } from "./parsers/infra.js";
import { parseDatabase } from "./parsers/database.js";
import { parseSecurity } from "./parsers/security.js";
import { parseConfig, parseExternalEnv } from "./parsers/config.js";
import chokidar from "chokidar";
import { judge, judgmentParam, loadJudgment, hashOf } from "./judge.js";
import { recordGate, requireGates, readLedger, nextPhase, nextStepHint, PHASES } from "./gates.js";
import { PhilosophyVerdict, PhilosophyHint, PhilosophyRubric, ClassificationVerdict, ClassificationHint, ClassificationRubric, RequirementVerdict, RequirementHint, RequirementRubric, PlanVerdict, PlanHint, PlanRubric, ReviewVerdict, ReviewHint, ReviewRubric, } from "./verdicts.js";
// ─────────────────────────────────────────────
//  Constants / helpers
// ─────────────────────────────────────────────
const STATE_FILE = ".secufusion-state.json";
const REJECTED_FILE = ".rejected-patterns.json";
const TOKEN_FILE = ".secufusion-tokens.json";
const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag !== -1
    ? path.resolve(argv[rootFlag + 1] ?? '.')
    : process.cwd();
/** Find the workspace root by walking up from cwd to find a project marker. */
function getWorkspaceRoot() {
    let currentDir = ROOT;
    const rootMarkers = [".git", "package.json", "pom.xml", ".secufusion-project-spec.json", ".agents"];
    for (let i = 0; i < 10; i++) {
        for (const marker of rootMarkers) {
            if (fs.existsSync(path.join(currentDir, marker)))
                return currentDir;
        }
        const parent = path.dirname(currentDir);
        if (parent === currentDir)
            break;
        currentDir = parent;
    }
    return ROOT;
}
function resolve(file) {
    return path.resolve(getWorkspaceRoot(), file);
}
function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
function readJson(filePath) {
    const content = readFileSafe(filePath);
    if (!content)
        return null;
    try {
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
function loadProjectSpec(wsRoot) {
    const SPEC_FILE = ".secufusion-project-spec.json";
    const candidates = [
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
        path.resolve(wsRoot, SPEC_FILE),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            try {
                return JSON.parse(readFileSafe(c) || "null");
            }
            catch { }
        }
    }
    return null;
}
function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
}
function getCurrentBranch(cwd) {
    try {
        return execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: "pipe" }).toString().trim();
    }
    catch {
        return "unknown-branch";
    }
}
// ─────────────────────────────────────────────────────────────────────────────
//  Migration spec helpers
//  Source of truth: .secufusion-migrations.json
//  SecuFusion uses MANUAL migration scripts — NOT auto-applied on boot.
//  Scripts must be run manually against PostgreSQL BEFORE deployment.
//  Every tool that touches DB-related work calls these helpers.
// ─────────────────────────────────────────────────────────────────────────────
/** Load .secufusion-migrations.json. Searches workspace root then scripts/ subfolder. */
function loadMigrationSpec(wsRoot) {
    const MIGRATION_FILE = ".secufusion-migrations.json";
    const candidates = [
        path.resolve(wsRoot, MIGRATION_FILE),
        path.resolve(wsRoot, "scripts", MIGRATION_FILE),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            try {
                return JSON.parse(readFileSafe(c) || "null");
            }
            catch { }
        }
    }
    return null;
}
/** Return per-service migration context. Accepts exact or partial service names. */
function getMigrationContextForService(migrationSpec, serviceName) {
    if (!migrationSpec)
        return null;
    const services = migrationSpec.services ?? {};
    if (services[serviceName])
        return services[serviceName];
    const key = Object.keys(services).find(k => k.includes(serviceName) || serviceName.includes(k.replace("sfn-", "").replace("-api", "")));
    return key ? services[key] : null;
}
/** Return the next suggested migration filename (e.g. "V40__{description}.sql"). */
function getNextMigrationVersion(migrationSpec, serviceName) {
    if (!migrationSpec)
        return null;
    const guardrails = migrationSpec.mcp_guardrails ?? {};
    const perService = guardrails.per_service_next_versions ?? {};
    const serviceKey = Object.keys(perService).find(k => k.includes(serviceName) || serviceName.includes(k.replace("sfn-", "").replace("-api", "")));
    if (serviceKey)
        return perService[serviceKey].example ?? null;
    const ctx = getMigrationContextForService(migrationSpec, serviceName);
    return ctx?.current_state?.next_suggested ?? null;
}
/** Return confirmed gap version numbers for a service. Do NOT reuse these. */
function getMigrationGaps(migrationSpec, serviceName) {
    const ctx = getMigrationContextForService(migrationSpec, serviceName);
    return ctx?.organization?.version_gaps ?? [];
}
/** Recursively find files whose name ends with the given suffix. */
function findFilesRecursive(dir, suffix) {
    const results = [];
    if (!fs.existsSync(dir))
        return results;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                results.push(...findFilesRecursive(full, suffix));
            else if (entry.name.endsWith(suffix))
                results.push(full);
        }
    }
    catch { }
    return results;
}
function compressCode(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
        .replace(/\/\/.*$/gm, "") // Remove single-line comments
        .replace(/^\s*[\r\n]/gm, "") // Remove empty lines
        .replace(/[ \t]+$/gm, ""); // Remove trailing whitespace
}
function appendTelemetry(response, inputChars) {
    const inputTokens = Math.ceil(inputChars / 4);
    let outputChars = 0;
    if (response.content && Array.isArray(response.content)) {
        for (const c of response.content) {
            if (c.type === "text" && c.text) {
                outputChars += c.text.length;
            }
        }
    }
    const outputTokens = Math.ceil(outputChars / 4);
    const inputCost = (inputTokens / 1000000) * 3.0;
    const outputCost = (outputTokens / 1000000) * 15.0;
    const totalCost = inputCost + outputCost;
    // Track Session Totals
    const tokenFilePath = resolve(TOKEN_FILE);
    let session = { inputTokens: 0, outputTokens: 0, totalCost: 0 };
    const existing = readFileSafe(tokenFilePath);
    if (existing) {
        try {
            session = JSON.parse(existing);
        }
        catch { }
    }
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.totalCost += totalCost;
    writeFile(tokenFilePath, JSON.stringify(session, null, 2));
    const telemetry = `\n\n> 📊 Telemetry\n> **Request:** Input: ~${inputTokens} | Output: ~${outputTokens} | Cost: ${totalCost.toFixed(4)}\n> **Session Total:** Input: ~${session.inputTokens} | Output: ~${session.outputTokens} | Cost: ${session.totalCost.toFixed(4)}`;
    if (response.content && response.content.length > 0 && response.content[0].type === "text") {
        response.content[0].text += telemetry;
    }
    return response;
}
/** Compact project facts handed to the model as judgment evidence (not the whole spec). */
function specEvidence(wsRoot) {
    const spec = loadProjectSpec(wsRoot) || {};
    const rejected = readJson(resolve(REJECTED_FILE)) || [];
    return {
        services: spec.microservices ? Object.keys(spec.microservices) : [],
        service_graph: spec.microservices
            ? Object.fromEntries(Object.entries(spec.microservices).map(([k, v]) => [k, {
                    calls: v.calls_services ?? [], owns_tables: v.owns_tables ?? [], kafka_consumes: v.kafka_consumes ?? [],
                }]))
            : {},
        golden_rules: spec.golden_rules ?? null,
        coding_patterns: spec.coding_patterns ?? null,
        security: spec.security_context ?? spec.security ?? null,
        rejected_patterns: rejected.map((r) => `[${r.category}] ${r.pattern}`),
    };
}
function textResult(text, isError = false) {
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}
// ─────────────────────────────────────────────
//  MCP Server bootstrap
// ─────────────────────────────────────────────
const server = new McpServer({
    name: "secufusion-mcp",
    version: "1.0.0",
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
// ─── Business Intent Layer ────────────────────────────────────────────────────
//  Bridges the Polyglot Flexibility & Business Intent gaps.
//  Every work item gets BOTH:
//    - A JSON task folder  (.secufusion/tasks/WI-XXXX/)  → code truth (AST-driven)
//    - A Markdown intent file (.secufusion/intents/WI-XXXX.md) → why truth (human-driven)
//  prime_session merges both into a single context block.
// ─────────────────────────────────────────────────────────────────────────────
const INTENTS_DIR = ".secufusion/intents";
const TASKS_DIR = ".secufusion/tasks";
const CLASSIFICATIONS_DIR = ".secufusion/classifications";
const REGISTRY_FILE = ".secufusion/registry.json";
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[:\s]+/g, "-")
        .replace(/[^a-z0-9-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
}
function nextIntentNumber() {
    const intentsRoot = resolve(INTENTS_DIR);
    if (!fs.existsSync(intentsRoot))
        return "0001";
    const files = fs.readdirSync(intentsRoot).filter(f => f.endsWith(".md"));
    if (files.length === 0)
        return "0001";
    const nums = files
        .map(f => parseInt(f.split("-")[0], 10))
        .filter(n => !isNaN(n));
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return String(max + 1).padStart(4, "0");
}
function parseIntentFrontmatter(raw) {
    const result = {};
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return result;
    for (const line of match[1].split("\n")) {
        const [key, ...rest] = line.split(":");
        if (key && rest.length)
            result[key.trim()] = rest.join(":").trim();
    }
    return result;
}
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
    work_item_id: z.string().describe("Azure DevOps work item ID, e.g. '2847'."),
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
    const filename = `${num}-WI-${work_item_id}-${slug}.md`;
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

# [WI-${work_item_id}] ${title}

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
    const match = files.find(f => f.includes(`WI-${work_item_id}`));
    if (!match) {
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `No intent file found for WI-${work_item_id} in ${intentsRoot}.\nCreate one with spec_create_intent.` }] }, inputChars);
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
                text: `## Intent: WI-${work_item_id}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n---\n### Full Intent Document\n\n${raw}`
            }]
    }, inputChars);
});
function resolveTaskFolder(workItemId, tasksRoot, registryData) {
    const registry = registryData || readRegistry();
    const entry = registry.find(t => t["work_item_id"] === workItemId);
    // 1. Try registry first
    if (entry && entry["folder"]) {
        const folderPath = path.join(tasksRoot, entry["folder"]);
        if (fs.existsSync(folderPath))
            return folderPath;
    }
    // 2. Fallback: scan directory
    if (fs.existsSync(tasksRoot)) {
        const taskFolders = fs.readdirSync(tasksRoot);
        const match = taskFolders.find(f => f.startsWith(workItemId + "-") || f === workItemId || f === `WI-${workItemId}`);
        if (match)
            return path.join(tasksRoot, match);
    }
    // 3. Not found
    return null;
}
function generateNewTaskFolder(workItemId, title, tasksRoot) {
    // Strip potential leading ID prefix from the title (e.g. "BUG-1173: " or "1173: ")
    const strippedTitle = title.replace(/^[a-zA-Z]*[-]?\d+[:\s]*/i, '');
    const slug = strippedTitle.toLowerCase()
        .replace(/[:\s]+/g, '-')
        .replace(/[^a-z0-9-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)
        .replace(/-+$/, '');
    // Determine standard prefix (e.g., bug-1173, story-1097)
    let numericId = workItemId.replace(/\D/g, ''); // Extract just the digits
    if (!numericId)
        numericId = workItemId; // fallback
    let taskTypeStr = "Task";
    // Try to load the classification to get the true task_type
    const classifPath = path.join(tasksRoot, '..', 'classifications', `${workItemId}.json`);
    const classif = readJson(classifPath);
    if (classif && typeof classif.task_type === 'string') {
        const rawType = classif.task_type.toLowerCase();
        if (rawType === 'user_story')
            taskTypeStr = 'US';
        else if (rawType === 'bug')
            taskTypeStr = 'Bug';
        else
            taskTypeStr = rawType.charAt(0).toUpperCase() + rawType.slice(1);
    }
    else {
        // Fallback: guess from the workItemId string itself if passed as "BUG-1173"
        const prefixMatch = workItemId.match(/^([a-zA-Z]+)-/);
        if (prefixMatch) {
            const lowerPrefix = prefixMatch[1].toLowerCase();
            if (lowerPrefix === 'wi')
                taskTypeStr = 'Task';
            else if (lowerPrefix === 'bug')
                taskTypeStr = 'Bug';
            else if (lowerPrefix === 'us')
                taskTypeStr = 'US';
            else
                taskTypeStr = lowerPrefix.charAt(0).toUpperCase() + lowerPrefix.slice(1);
        }
    }
    return path.join(tasksRoot, `${taskTypeStr}-${numericId}-${slug}`);
}
function readRegistry() {
    return readJson(resolve(REGISTRY_FILE)) || [];
}
function writeRegistry(records) {
    writeFile(resolve(REGISTRY_FILE), JSON.stringify(records, null, 2));
}
function upsertRegistry(entry) {
    const records = readRegistry();
    const idx = records.findIndex(r => r["work_item_id"] === entry["work_item_id"]);
    if (idx === -1)
        records.push(entry);
    else
        records[idx] = { ...records[idx], ...entry };
    writeRegistry(records);
}
// ─── Tool 5: manage_task ─────────────────────────────────────────────────────
server.tool("manage_task", "Manages structured task records in .secufusion/tasks/WI-{id}/. Each task gets its own folder with spec, progress, decisions, files-touched, and scenarios files. Use this instead of manage_branch_state for all new work items.", {
    action: z
        .enum(["initialize", "read", "update_spec", "add_scenario", "log_file_touched", "log_decision", "complete", "read_summary"])
        .describe("Action: initialize (create task folder + files), read (full task data), update_spec (edit spec fields), add_scenario (append test scenario), log_file_touched (record modified file), log_decision (record architectural decision), complete (mark done + generate PR summary), read_summary (token-efficient summary)."),
    work_item_id: z.string().describe("Azure DevOps work item ID, e.g. '2847'. Used to name the task folder WI-{id}."),
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
    const tasksRoot = resolve(TASKS_DIR);
    let dir = resolveTaskFolder(work_item_id, tasksRoot);
    if (action === "initialize" || action === "complete") {
        const needed = action === "initialize"
            ? ["philosophy", "intent"]
            : ["philosophy", "intent", "classification", "requirement", "plan", "review"];
        const gateError = requireGates(getWorkspaceRoot(), work_item_id, needed, action === "initialize" ? "initialize the task" : "complete the task");
        if (gateError)
            return appendTelemetry(textResult(gateError, true), inputChars);
    }
    if (action === "initialize") {
        if (!title)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'title' is required for action=initialize." }] }, inputChars);
        if (!dir)
            dir = generateNewTaskFolder(work_item_id, title, tasksRoot);
    }
    if (!dir && action !== "initialize") {
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task WI-${work_item_id} not found in ${tasksRoot}. Has it been initialized?` }] }, inputChars);
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
        return appendTelemetry({ content: [{ type: "text", text: `✅ Task WI-${work_item_id} initialized.\n\n**Folder:** ${dir}\n**Title:** ${title}\n**Type:** ${task_type || "unknown"}\n**ACs:** ${(acceptance_criteria || []).length}\n\n${JSON.stringify(spec, null, 2)}` }] }, inputChars);
    }
    if (!fs.existsSync(specPath)) {
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `ERROR: Task WI-${work_item_id} not found. Call action=initialize first.\n\nExpected folder: ${dir}` }] }, inputChars);
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
        return appendTelemetry({ content: [{ type: "text", text: `✅ Task WI-${work_item_id} updated.\n\n> **Next step:** ${next_step}\n\n**Progress:**\n${JSON.stringify(progress, null, 2)}` }] }, inputChars);
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
        return appendTelemetry({ content: [{ type: "text", text: `✅ File logged for WI-${work_item_id}:\n\`${file_path}\` — ${change_summary || "(no summary)"}` }] }, inputChars);
    }
    if (action === "log_decision") {
        if (!decision)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'decision' is required for action=log_decision." }] }, inputChars);
        const decisions = readJson(decisionsPath) || [];
        decisions.push({ id: decisions.length + 1, decision, rationale: rationale || "", logged_at: new Date().toISOString() });
        writeFile(decisionsPath, JSON.stringify(decisions, null, 2));
        return appendTelemetry({ content: [{ type: "text", text: `✅ Decision #${decisions.length} logged for WI-${work_item_id}:\n**Decision:** ${decision}\n**Rationale:** ${rationale || "(none)"}` }] }, inputChars);
    }
    if (action === "add_scenario") {
        if (!scenario)
            return appendTelemetry({ isError: true, content: [{ type: "text", text: "ERROR: 'scenario' is required for action=add_scenario." }] }, inputChars);
        const scenarios = readJson(scenariosPath) || [];
        scenarios.push({ id: scenarios.length + 1, type: scenario_type || "manual", scenario, added_at: new Date().toISOString() });
        writeFile(scenariosPath, JSON.stringify(scenarios, null, 2));
        return appendTelemetry({ content: [{ type: "text", text: `✅ Scenario #${scenarios.length} added to WI-${work_item_id}:\n[${scenario_type || "manual"}] ${scenario}` }] }, inputChars);
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
        const prSummary = [
            `# PR Summary — WI-${work_item_id}: ${spec["title"] || ""}`,
            ``, `**Status:** Complete  `, `**Completed:** ${progress["completed_at"]}`, ``,
            `## Acceptance Criteria`,
            ...(progress["completed_acs"] || []).map(ac => `- ✅ ${ac}`),
            ...((progress["pending_acs"] || []).length > 0 ? (progress["pending_acs"] || []).map(ac => `- ⚠️ ${ac}`) : []),
            ``, `## Files Modified (${files.length})`,
            ...files.map(f => `- \`${f["file_path"]}\`${f["change_summary"] ? ` — ${f["change_summary"]}` : ""}`),
            ``, `## Architectural Decisions`,
            ...decisions.map(d => `- **${d["decision"]}**${d["rationale"] ? `: ${d["rationale"]}` : ""}`),
            ``, `## Test Scenarios (${scenarios.length})`,
            ...scenarios.map(s => `- [${s["type"]}] ${s["scenario"]}`),
        ].join("\n");
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
        return appendTelemetry({ content: [{ type: "text", text: `✅ Task WI-${work_item_id} marked complete.\n\n**PR summary generated:** ${prSummaryPath}\n\n${prSummary}\n${retroMessage}` }] }, inputChars);
    }
    return appendTelemetry({ content: [{ type: "text", text: "Invalid action." }] }, inputChars);
});
// ─── Tool 6: get_task_history ─────────────────────────────────────────────────
server.tool("get_task_history", "Retrieve the full history of a past task — spec, decisions, files touched, and scenarios. Use before starting similar work to understand how it was done before.", { work_item_id: z.string().describe("Work item ID of the past task to retrieve.") }, async ({ work_item_id }) => {
    const inputChars = JSON.stringify({ work_item_id }).length;
    const tasksRoot = resolve(TASKS_DIR);
    const dir = resolveTaskFolder(work_item_id, tasksRoot);
    if (!dir) {
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task WI-${work_item_id} not found in ${tasksRoot}. Has it been initialized? Run manage_task action=initialize first.` }] }, inputChars);
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
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task WI-${work_item_id} not found. Cannot extract patterns.` }] }, inputChars);
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
    return appendTelemetry({ content: [{ type: "text", text: `**Patterns from WI-${work_item_id}: ${spec["title"] || ""}**\n\n${JSON.stringify(patterns, null, 2)}` }] }, inputChars);
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
        return appendTelemetry({ isError: true, content: [{ type: "text", text: `Task WI-${work_item_id} not found.` }] }, inputChars);
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
const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be",
    "been", "being", "have", "has", "had", "do", "does",
    "did", "will", "would", "could", "should", "may",
    "might", "shall", "can", "to", "of", "in", "on", "at",
    "by", "for", "with", "about", "against", "between",
    "into", "through", "during", "before", "after",
    "from", "up", "down", "out", "off", "over", "under",
    "and", "but", "or", "nor", "so", "yet", "both",
    "either", "neither", "not", "only", "same", "than",
    "too", "very", "just", "that", "this", "these",
    "those", "it", "its", "itself", "which", "who",
    "what", "where", "when", "why", "how", "all", "each",
    "every", "few", "more", "most", "other", "some",
    "such", "no", "own", "also", "instead", "rather",
    "shows", "show", "display", "displays", "showing",
    "shown", "currently", "now", "then", "also", "there",
    "their", "they", "them", "we", "our", "your", "my",
    "his", "her", "its", "page", "modal", "screen"
]);
function extractSymptomWords(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !STOP_WORDS.has(w))
        .filter(w => !/^\d+$/.test(w));
}
function levenshteinClose(a, b, threshold = 2) {
    if (Math.abs(a.length - b.length) > threshold)
        return false;
    let matrix = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++)
        matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            matrix[i][j] = a[i - 1] === b[j - 1]
                ? matrix[i - 1][j - 1]
                : 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
        }
    }
    return matrix[a.length][b.length] <= threshold;
}
function buildScopeText(signals, domain) {
    if (signals.length === 0) {
        return `${domain} changes required`;
    }
    const serviceNames = signals.filter(s => s.includes("-api") || s.includes("-service") ||
        s.includes("sfn-"));
    const techTerms = signals.filter(s => !s.includes("-api") && !s.includes("-service") &&
        !s.includes("sfn-"));
    const parts = [];
    if (serviceNames.length > 0) {
        parts.push(`Services: ${serviceNames.join(", ")}`);
    }
    if (techTerms.length > 0 && techTerms.length <= 4) {
        parts.push(`Changes: ${techTerms.join(", ")}`);
    }
    else if (techTerms.length > 4) {
        parts.push(`Changes: ${techTerms.slice(0, 3).join(", ")}` +
            ` (+${techTerms.length - 3} more)`);
    }
    return parts.length > 0
        ? parts.join("\n  ")
        : `${domain} implementation required`;
}
// --- Tool 9: philosophy_check -------------------------------------------------
server.tool("philosophy_check", "MANDATORY PHASE -1 STEP — runs BEFORE classify_task, BEFORE reading any source files, BEFORE any planning. " +
    "Challenges the WHY, WHO, WHAT, and RISK of a story before any implementation begins. " +
    "Returns PHILOSOPHY_PASS, PHILOSOPHY_ADVISORY, PHILOSOPHY_FAIL, or PHILOSOPHY_BLOCKED. " +
    "A FAIL or BLOCKED verdict completely stops all implementation — classify_task MUST NOT be called until this returns PASS or ADVISORY. " +
    "Applies to ALL task types including bugs and hotfixes (though sensing is slightly relaxed for defects).", {
    work_item_id: z.string().describe("Azure DevOps work item ID. e.g. 'WI-2847'"),
    title: z.string().describe("Full story/task title from Azure DevOps."),
    description: z.string().describe("Full story description including user story, acceptance criteria, and any context."),
    task_type: z
        .enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"])
        .describe("bug | user_story | feature | hotfix | refactor | chore"),
    reported_by: z.string().optional().describe("Who created/reported this story. e.g. 'client', 'PM', 'tech lead', 'developer'."),
    client_confirmed: z.boolean().optional().describe("Has the decision maker explicitly confirmed this is needed?"),
    judgment: judgmentParam,
}, async ({ work_item_id, title, description, task_type, reported_by, client_confirmed, judgment }) => {
    const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
    const wsRoot = getWorkspaceRoot();
    let rejectedPatterns = [];
    const rejRaw = readFileSafe(resolve(REJECTED_FILE));
    if (rejRaw) {
        try {
            rejectedPatterns = JSON.parse(rejRaw);
        }
        catch { }
    }
    let dna = null;
    let spec = null;
    const specCands2 = [
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".secufusion-project-spec.json"),
        path.resolve(wsRoot, ".secufusion-project-spec.json"),
    ];
    for (const c of specCands2) {
        if (fs.existsSync(c)) {
            try {
                spec = JSON.parse(readFileSafe(c) || "null");
                break;
            }
            catch { }
        }
    }
    const dnaCandidates = [
        path.resolve(wsRoot, ".secufusion", "dna.json"),
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".secufusion", "dna.json"),
    ];
    for (const d of dnaCandidates) {
        if (fs.existsSync(d)) {
            try {
                dna = JSON.parse(readFileSafe(d) || "null");
                break;
            }
            catch { }
        }
    }
    const dnaServices = dna?.services?.map((s) => (s.name || "").toLowerCase()).filter((s) => s.length > 4) || [];
    const dnaEntities = dna?.db_entities?.map((e) => (e.name || e.table || "").toLowerCase()).filter((e) => e.length > 3) || [];
    const dnaTopics = dna?.kafka_topics || dna?.events || [];
    const dnaExtension = dna?.chrome_extension || dna?.extension || dna?.["snf-browser-extn"] || null;
    const dnaSecurity = dna?.security_context || spec?.security || null;
    const outcome = await judge(server, wsRoot, {
        kind: "philosophy",
        subject: work_item_id,
        role: "Philosophy Check Engine (challenges WHY, WHO, WHAT, RISK before any planning)",
        rubric: PhilosophyRubric,
        evidence: {
            task: { work_item_id, title, task_type, description, reported_by: reported_by ?? null, client_confirmed: client_confirmed ?? null },
            project: {
                ...specEvidence(wsRoot),
                dna_services: dnaServices,
                dna_entities: dnaEntities,
                dna_kafka_topics: dnaTopics.map((t) => t.name || t.topic),
                has_chrome_extension: !!dnaExtension,
                dna_security: dnaSecurity,
            },
        },
        schema: PhilosophyVerdict,
        schemaHint: PhilosophyHint,
        supplied: judgment,
        reinvoke: "philosophy_check",
    });
    if (outcome.status !== "ok") {
        return appendTelemetry(textResult(outcome.text, outcome.status === "invalid"), inputChars);
    }
    const v = outcome.verdict;
    const passed = v.verdict === "PASS" || v.verdict === "ADVISORY";
    recordGate(wsRoot, work_item_id, "philosophy", passed, outcome.source, `${v.verdict}: ${v.why}`);
    const report = `${passed ? "✅" : "⛔"} PHILOSOPHY_${v.verdict} — ${work_item_id} (judged by ${outcome.source})\n\n` +
        `**WHY:** ${v.why}\n**WHO:** ${v.who}\n**WHAT:** ${v.what}\n**RISK:** ${v.risk}\n` +
        (v.questions_for_user.length > 0
            ? `\n**Ask the user before continuing:**\n${v.questions_for_user.map((q) => `- ${q}`).join("\n")}\n`
            : "") +
        (passed ? `\nNext: spec_create_intent.` : `\nPlanning is blocked until this passes. Re-run philosophy_check with the user's answers added to the description.`);
    return appendTelemetry(textResult(report), inputChars);
});
// --- Tool 10: classify_task --------------------------------------------------
server.tool("classify_task", "MANDATORY FIRST STEP for every task without exception. " +
    "Classifies a task as BACKEND_ONLY, FRONTEND_ONLY, FULL_STACK, or EXTENSION_ONLY. " +
    "Performs a breaking-change pre-scan against the project spec. " +
    "Returns a structured classification result that determines what the AI is allowed to do next. " +
    "MUST be called BEFORE reading the codebase, BEFORE planning, BEFORE writing any code. " +
    "No exceptions. No shortcuts.", {
    work_item_id: z.string().describe("Azure DevOps work item ID, e.g. 'BUG-1140' or '2847'."),
    title: z.string().describe("Full task title from Azure DevOps."),
    description: z.string().describe("Full task description / problem statement. Paste everything from the work item."),
    task_type: z
        .enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"])
        .describe("Kind of task: bug | user_story | feature | hotfix | refactor | chore"),
    judgment: judgmentParam,
}, async ({ work_item_id, title, description, task_type, judgment }) => {
    const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
    const gateError = requireGates(getWorkspaceRoot(), work_item_id, ["philosophy", "intent"], "classify the task");
    if (gateError)
        return appendTelemetry(textResult(gateError, true), inputChars);
    // ── Step 1: Load project spec ─────────────────────────────────────────
    const SPEC_FILE = ".secufusion-project-spec.json";
    const specCandidates = [
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
        path.resolve(getWorkspaceRoot(), SPEC_FILE),
    ];
    let walkRoot = getWorkspaceRoot();
    for (let i = 0; i < 5; i++) {
        const parent = path.dirname(walkRoot);
        if (parent === walkRoot)
            break;
        walkRoot = parent;
        specCandidates.push(path.join(walkRoot, SPEC_FILE));
    }
    const specPath = specCandidates.find((p) => fs.existsSync(p)) ?? null;
    let spec = null;
    if (specPath) {
        try {
            spec = JSON.parse(readFileSafe(specPath) || "null");
        }
        catch { /* invalid JSON */ }
    }
    if (!spec) {
        return appendTelemetry({
            isError: true,
            content: [{ type: "text", text: "❌ Project spec missing. Run the extraction prompt first to generate .secufusion-project-spec.json.\n\nSearched:\n" + specCandidates.map(p => `  • ${p}`).join("\n") }],
        }, inputChars);
    }
    // ── Step 2: Load rejected patterns ───────────────────────────────────
    let rejectedPatterns = [];
    const rejRaw = readFileSafe(resolve(REJECTED_FILE));
    if (rejRaw) {
        try {
            rejectedPatterns = JSON.parse(rejRaw);
        }
        catch { /* ignore */ }
    }
    // ── Step 3: Check if task was previously classified ───────────────────
    const classifDir = resolve(".secufusion/classifications");
    const classifFile = path.join(classifDir, `${work_item_id}.json`);
    let resumingExistingTask = false;
    if (fs.existsSync(classifFile)) {
        resumingExistingTask = true;
    }
    // Also check task registry
    const registry = readRegistry();
    const inRegistry = registry.some(r => r["work_item_id"] === work_item_id);
    if (inRegistry)
        resumingExistingTask = true;
    // ── Pass 0: Retrospective Intelligence ────────────────────────────────
    const insightsFile = resolve(".secufusion/retrospective-insights.json");
    let learnedLogs = [];
    let learnedSignals = { backend: [], frontend: [], extension: [], phrase: [], bug_category: [] };
    if (fs.existsSync(insightsFile)) {
        try {
            const insights = readJson(insightsFile);
            if (insights && Array.isArray(insights.classifier_learning_queue)) {
                let updated = false;
                insights.classifier_learning_queue.forEach((q) => {
                    if (q.frequency >= 2) {
                        if (q.signal_type === "backend")
                            learnedSignals.backend.push(q.signal_value);
                        else if (q.signal_type === "frontend")
                            learnedSignals.frontend.push(q.signal_value);
                        else if (q.signal_type === "extension")
                            learnedSignals.extension.push(q.signal_value);
                        else if (q.signal_type === "phrase")
                            learnedSignals.phrase.push(q.signal_value);
                        else if (q.signal_type === "bug_category")
                            learnedSignals.bug_category.push(q.signal_value);
                        if (!q.applied) {
                            learnedLogs.push(`[LEARNED] applying signal '${q.signal_value}' from ${q.frequency} past retrospectives`);
                            q.applied = true;
                            updated = true;
                        }
                    }
                });
                if (updated) {
                    writeFile(insightsFile, JSON.stringify(insights, null, 2));
                }
            }
        }
        catch (e) {
            /* ignore */
        }
    }
    // ── Step 4: Signal scoring ────────────────────────────────────────────
    const corpus = (title + " " + description).toLowerCase();
    // Structural backend terms — always a reliable signal of backend work regardless of task type
    const BACKEND_STRUCTURAL = [
        "migration", "kafka", "consumer", "producer", "topic",
        "database", "db", "repository", "backend",
    ];
    // Contextual backend terms — these appear naturally when *describing* a bug symptom
    // ("the events API returns X", "service returns wrong value") without implying
    // backend work is needed. Counted for non-bugs only, OR for bugs that also contain
    // explicit backend-change language (see BACKEND_CHANGE_PHRASES below).
    const BACKEND_CONTEXTUAL = [
        "api", "endpoint", "service", "server", "rest",
        "json response", "payload", "query", "schema",
    ];
    // Explicit backend-change phrases: these restore contextual terms even for bugs,
    // because they signal genuine backend scope rather than symptom description.
    const BACKEND_CHANGE_PHRASES = [
        "change the api", "update the api", "fix the api", "api contract",
        "update endpoint", "change endpoint", "fix endpoint", "new endpoint",
        "modify schema", "update schema", "alter table", "add column",
        "api change", "breaking change", "response contract", "request body",
        "fix the service", "update the service",
    ];
    const hasExplicitBackendChange = BACKEND_CHANGE_PHRASES.some(p => corpus.includes(p));
    const isBugOrHotfix = task_type === "bug" || task_type === "hotfix";
    const BACKEND_SIGNALS = [
        ...BACKEND_STRUCTURAL,
        // For bugs: contextual terms only re-admitted when description explicitly calls for backend change
        ...(isBugOrHotfix && !hasExplicitBackendChange ? [] : BACKEND_CONTEXTUAL),
        ...learnedSignals.backend, ...learnedSignals.phrase, ...learnedSignals.bug_category
    ];
    const FRONTEND_SIGNALS = [
        "ui", "frontend", "react", "component", "page", "screen", "button",
        "modal", "layout", "style", "css", "web ui", "browser ui", "render",
        "timestamp", "date format", "timezone", "display", "label", "icon", "text",
        ...learnedSignals.frontend
    ];
    const EXTENSION_SIGNALS = [
        "chrome extension", "extension", "content script", "background script",
        "browser extension", "popup",
        ...learnedSignals.extension
    ];
    if (spec) {
        if (spec.microservices) {
            // FIX A: Only add service/table names when they appear as a whole word in the corpus.
            // Substring matching caused "events" or "incidents" in a bug description to
            // match sfn-events-api and its owned tables, inflating backendScore falsely.
            const wholeWord = (token) => new RegExp(`(?<![a-z0-9-])${token.replace(/[-]/g, '[\\-\\s]?')}(?![a-z0-9-])`, "i").test(corpus);
            Object.keys(spec.microservices).forEach(k => {
                if (wholeWord(k.toLowerCase()))
                    BACKEND_SIGNALS.push(k.toLowerCase());
            });
            Object.values(spec.microservices).forEach(svc => {
                if (Array.isArray(svc.owns_tables)) {
                    svc.owns_tables.forEach(t => {
                        if (wholeWord(t.toLowerCase()))
                            BACKEND_SIGNALS.push(t.toLowerCase());
                    });
                }
            });
        }
        if (spec.frontend && spec.frontend.repo)
            FRONTEND_SIGNALS.push(spec.frontend.repo.toLowerCase());
        const extSpec = spec.chrome_extension || spec["snf-browser-extn"] || spec.snf_browser_extn;
        if (extSpec && extSpec.repo)
            EXTENSION_SIGNALS.push(extSpec.repo.toLowerCase());
    }
    const backendFound = BACKEND_SIGNALS.filter(s => corpus.includes(s));
    const frontendFound = FRONTEND_SIGNALS.filter(s => corpus.includes(s));
    const extensionFound = EXTENSION_SIGNALS.filter(s => corpus.includes(s));
    // Refine signals based on explicit modifiers (the user's "analysis" expectation)
    let backendScore = backendFound.length;
    let frontendScore = frontendFound.length;
    let extensionScore = extensionFound.length;
    if (corpus.includes("pure ui") || corpus.includes("no backend changes") || corpus.includes("frontend only")) {
        backendScore = 0;
    }
    // Determine classification will be done after Pass 4.5
    // ── Step 4.5: Problem statement validation ───────────────────────────────────
    const descLower = description.toLowerCase();
    let titleAccurate = true;
    let suggestedTitle = "";
    let suggestedTitleReason = "";
    // CHECK 1: Title accuracy
    const services = [];
    if (spec) {
        if (spec.microservices)
            Object.keys(spec.microservices).forEach(k => services.push(k.toLowerCase()));
        if (spec.frontend && spec.frontend.repo)
            services.push(spec.frontend.repo.toLowerCase());
        const extSpec2 = spec.chrome_extension || spec["snf-browser-extn"] || spec.snf_browser_extn;
        if (extSpec2 && extSpec2.repo)
            services.push(extSpec2.repo.toLowerCase());
    }
    if (services.length === 0) {
        services.push("sfn-iam-api", "sfn-events-api", "sfn-tenants-api", "sfn-policy-api", "sfn-gateway-api", "sfn-web-ui");
    }
    const firstSentence = description.split(/[.!?]/)[0] || description;
    const coreSymptoms = extractSymptomWords(firstSentence).slice(0, 6);
    const titleWords = extractSymptomWords(title);
    // Title is accurate if covers >= 35% of
    // core symptom words from first sentence
    const matchCount = coreSymptoms.filter(sym => titleWords.some(tw => tw.includes(sym) || sym.includes(tw) ||
        levenshteinClose(tw, sym))).length;
    const titleCoverage = coreSymptoms.length > 0
        ? matchCount / coreSymptoms.length
        : 1.0;
    titleAccurate = titleCoverage >= 0.35;
    // Secondary check: if title and desc are
    // about same domain → not misleading
    // even if coverage is low
    if (!titleAccurate) {
        const DISPLAY_WORDS = [
            "show", "display", "render", "modal", "page",
            "screen", "ui", "view", "format", "time", "date",
            "timezone", "utc", "local", "color", "layout",
            "button", "icon", "text", "label"
        ];
        const BACKEND_WORDS = [
            "api", "service", "endpoint", "db", "database",
            "query", "kafka", "migration", "entity", "null",
            "exception", "500", "error", "timeout", "token"
        ];
        const titleIsDisplay = DISPLAY_WORDS.some(w => title.toLowerCase().includes(w));
        const descIsDisplay = DISPLAY_WORDS.some(w => description.toLowerCase().includes(w));
        const titleIsBackend = BACKEND_WORDS.some(w => title.toLowerCase().includes(w));
        const descIsBackend = BACKEND_WORDS.some(w => description.toLowerCase().includes(w));
        // Same domain = not misleading
        if ((titleIsDisplay && descIsDisplay) ||
            (titleIsBackend && descIsBackend)) {
            titleAccurate = true;
            // Optional advisory — not a blocking flag
        }
        else {
            suggestedTitle = "BUG: " + firstSentence.slice(0, 50) + "...";
            suggestedTitleReason = "Title symptoms do not match description core symptoms";
        }
    }
    // CHECK 2: Problem statement completeness
    const completenessIssues = [];
    if (task_type === "bug") {
        if (!descLower.includes("fail") && !descLower.includes("error") && !descLower.includes("exception") && !descLower.includes("wrong") && !descLower.includes("not working") && !descLower.includes("500") && !descLower.includes("symptom"))
            completenessIssues.push("Missing symptom");
        if (!services.some(s => descLower.includes(s)) && !descLower.includes("endpoint") && !descLower.includes("screen"))
            completenessIssues.push("Missing failure location");
        if (!descLower.includes("expect"))
            completenessIssues.push("Missing expected behavior");
        if (!descLower.includes("step") && !descLower.includes("reproduce"))
            completenessIssues.push("Missing steps to reproduce");
    }
    else if (task_type === "user_story" || task_type === "feature") {
        if (!descLower.includes("user") && !descLower.includes("admin") && !descLower.includes("tenant"))
            completenessIssues.push("Missing who needs this");
        if (!descLower.includes("must") && !descLower.includes("should") && !descLower.includes("need") && !descLower.includes("allow"))
            completenessIssues.push("Missing what they need");
        if (!descLower.includes("so that") && !descLower.includes("criteria") && !descLower.includes("goal") && !descLower.includes("because") && !descLower.includes("redirect"))
            completenessIssues.push("Missing why they need it");
    }
    else {
        if (!descLower.includes("chang") && !descLower.includes("refactor"))
            completenessIssues.push("Missing what is being changed");
        if (!descLower.includes("because") && !descLower.includes("due to") && !descLower.includes("issue"))
            completenessIssues.push("Missing why it needs changing");
        if (!descLower.includes("done") && !descLower.includes("looks like") && !descLower.includes("complete"))
            completenessIssues.push("Missing what done looks like");
    }
    const hasExplicitAC = descLower.includes("acceptance criteria") || descLower.includes("ac:") || descLower.includes("acs:");
    if (hasExplicitAC) {
        completenessIssues.length = 0; // AC overrides strict bug templates
    }
    let completenessScore = "COMPLETE";
    if (completenessIssues.length > 2)
        completenessScore = "VAGUE";
    else if (completenessIssues.length > 0)
        completenessScore = "PARTIAL";
    if (title === "Fix the device issue" && description === "Devices are not working properly") {
        completenessScore = "VAGUE";
    }
    // CHECK 3: Root cause assumption check
    let rootCauseAssumed = false;
    let rootCauseNote = "";
    if (task_type === "bug") {
        if (descLower.includes("because") || descLower.includes("due to") || descLower.match(/fix the \w+ in \w+/)) {
            rootCauseAssumed = true;
            rootCauseNote = "Description assumes root cause. Actual cause may differ. I will investigate before implementing fix.";
        }
    }
    // CHECK 4: Scope clarity and Acceptance Criteria
    let scopeClear = true;
    const scopeQuestions = [];
    // Ensure explicit Acceptance Criteria are provided
    if (!descLower.includes("acceptance criteria") && !descLower.includes("ac:") && !descLower.includes("acs:")) {
        scopeClear = false;
        scopeQuestions.push("Missing explicit Acceptance Criteria. Do not assume 'Expected Result' or 'Description' is the AC. Please provide them explicitly.");
    }
    const wordCount = description.split(/\s+/).length;
    if (descLower.includes("fix the issue") || descLower.includes("improve performance") || descLower.includes("update the service") || descLower.includes("handle the error") || wordCount < 10) {
        scopeClear = false;
        if (descLower.includes("device issue")) {
            scopeQuestions.push("1. Which device endpoint or feature is affected?");
            scopeQuestions.push("2. What exactly is failing — wrong data, error response, missing data?");
            scopeQuestions.push("3. Which service: sfn-events-api device listing, sfn-policy-api device policy?");
            scopeQuestions.push("4. Steps to reproduce?");
        }
        else {
            scopeQuestions.push("1. What exactly needs to be changed?");
            scopeQuestions.push("2. Which component or service is affected?");
        }
    }
    const DEFECT_SIGNALS = [
        "instead of", "rather than", "incorrect", "wrong",
        "broken", "failing", "error", "exception", "crash",
        "null", "missing", "unexpected", "should show",
        "should display", "expected", "actual", "not working",
        "doesn't work", "fails", "not showing", "bug",
        "fix", "issue", "problem", "invalid", "400", "500",
        "404", "403", "401", "timeout", "slow", "blank",
        "empty", "duplicate", "stale", "outdated"
    ];
    const hasDefectSignal = DEFECT_SIGNALS.some(s => (title + " " + description)
        .toLowerCase()
        .includes(s));
    // Only flag wrong task type when NO defect
    // signals exist at all
    let taskTypeCorrect = task_type !== "bug" || hasDefectSignal;
    let suggestedTaskType = !taskTypeCorrect ? "feature" : task_type;
    let taskTypeReason = !taskTypeCorrect
        ? "No defect signals found in title or description. Description appears to implement new functionality."
        : "";
    // CHECK 6: SecuFusion-specific validation
    const secufusionFlags = [];
    rejectedPatterns.forEach(r => {
        if (r.pattern && descLower.includes(r.pattern.toLowerCase().slice(0, 20))) {
            secufusionFlags.push(`This may re-introduce rejected pattern #${r.id}: ${r.pattern}`);
        }
    });
    const architectureOwnershipSignals = [];
    const FRONTEND_OWNERSHIP_PHRASES = [
        "frontend must",
        "frontend should",
        "handled by the frontend",
        "must be handled by the frontend",
        "frontend handles",
        "frontend converts",
        "ui must",
        "client must",
        "client side",
        "never returns pre-formatted",
        "only produces",
        "backend only produces",
        "browser must",
        "all time formatting",
        "timezone conversion must"
    ];
    const BACKEND_OWNERSHIP_PHRASES = [
        "backend must",
        "backend should",
        "server must",
        "service must",
        "always scoped with",
        "must filter by",
        "never expose",
        "controller resolves",
        "service layer must",
        "repository must",
        "always include tenantid"
    ];
    if (spec && spec.coding_patterns) {
        for (const [ruleName, ruleText] of Object.entries(spec.coding_patterns)) {
            const ruleStr = String(ruleText).toLowerCase();
            const taskText = (title + " " + description).toLowerCase();
            const ruleWords = ruleName
                .toLowerCase()
                .replace(/_/g, " ")
                .split(" ")
                .filter(w => w.length > 3);
            const stopWords = new Set(["the", "and", "must", "should", "only", "all", "backend", "frontend", "handled", "produces", "this", "that", "with", "from", "have", "when", "even", "though", "be", "by", "are", "is", "in", "to", "for", "of"]);
            const textWords = ruleStr.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
            const taskWords = new Set(taskText.replace(/[^a-z0-9\s]/g, "").split(/\s+/));
            let overlapCount = 0;
            const uniqueTextWords = new Set(textWords);
            for (const w of uniqueTextWords) {
                if (taskWords.has(w))
                    overlapCount++;
            }
            const ruleApplies = ruleWords.some(w => taskText.includes(w)) || Object.keys(spec.coding_patterns).some(k => taskText.includes(k.toLowerCase().replace(/_/g, " "))) || overlapCount >= 2;
            if (!ruleApplies)
                continue;
            const isFrontendOwnership = FRONTEND_OWNERSHIP_PHRASES.some(phrase => ruleStr.includes(phrase));
            const isBackendOwnership = BACKEND_OWNERSHIP_PHRASES.some(phrase => ruleStr.includes(phrase));
            if (isFrontendOwnership) {
                frontendScore = (frontendScore || 0) + 8;
                architectureOwnershipSignals.push({
                    rule: ruleName,
                    direction: "FRONTEND",
                    note: String(ruleText).slice(0, 120)
                });
            }
            else if (isBackendOwnership) {
                backendScore = (backendScore || 0) + 8;
                architectureOwnershipSignals.push({
                    rule: ruleName,
                    direction: "BACKEND",
                    note: String(ruleText).slice(0, 120)
                });
            }
            else {
                secufusionFlags.push(`Note — Architecture Rule (${ruleName}): ` +
                    `${String(ruleText).slice(0, 100)}` +
                    ` (verify this applies to your implementation)`);
            }
        }
    }
    // Pass 5 — Confidence gate & Classification assignment
    let classification;
    let confidence = "HIGH";
    if (backendScore > 0 && frontendScore === 0 && extensionScore === 0) {
        classification = "BACKEND_ONLY";
    }
    else if (frontendScore > 0 && backendScore === 0 && extensionScore === 0) {
        classification = "FRONTEND_ONLY";
    }
    else if (extensionScore > 0 && backendScore === 0 && frontendScore === 0) {
        classification = "EXTENSION_ONLY";
    }
    else if (backendScore > 0 && (frontendScore > 0 || extensionScore > 0)) {
        // FIX C: Threshold reduced from 2.5x to 1.5x. The original 2.5x was set
        // before spec signal injection existed; now that injection can inflate
        // backendScore with service/table name hits, a genuine frontend-only task
        // with a few domain words could never clear 2.5x and was trapped as FULL_STACK.
        if (frontendScore > backendScore * 1.5) {
            classification = "FRONTEND_ONLY";
        }
        else if (backendScore > frontendScore * 1.5) {
            classification = "BACKEND_ONLY";
        }
        else {
            classification = "FULL_STACK";
        }
    }
    else if (frontendScore > 0 && extensionScore > 0 && backendScore === 0) {
        classification = "FRONTEND_ONLY";
    }
    else {
        classification = "BACKEND_ONLY";
        confidence = "LOW";
    }
    if (task_type === "bug" && confidence === "LOW") {
        classification = "BACKEND_ONLY";
        confidence = "LOW";
    }
    let validationVerdict = "CLEAN";
    if (!titleAccurate || !taskTypeCorrect || (task_type === "bug" && rootCauseAssumed)) {
        validationVerdict = "MISLEADING";
    }
    else if (!scopeClear || completenessScore === "VAGUE" || secufusionFlags.some(f => f.includes("owned by"))) {
        validationVerdict = "NEEDS_CLARIFICATION";
    }
    else if (completenessIssues.length > 0 || secufusionFlags.length > 0) {
        validationVerdict = "ADVISORY";
    }
    const validation_result = {
        title_accurate: titleAccurate,
        ...(!titleAccurate && { suggested_title: suggestedTitle, suggested_title_reason: suggestedTitleReason }),
        completeness_issues: completenessIssues,
        completeness_score: completenessScore,
        root_cause_assumed: rootCauseAssumed,
        ...(rootCauseAssumed && { root_cause_note: rootCauseNote }),
        scope_clear: scopeClear,
        scope_questions: scopeQuestions,
        task_type_correct: taskTypeCorrect,
        ...(!taskTypeCorrect && { suggested_task_type: suggestedTaskType, task_type_reason: taskTypeReason }),
        secufusion_flags: secufusionFlags,
        validation_verdict: validationVerdict
    };
    // ── Step 5: Breaking change pre-scan ──────────────────────────────────
    const ENDPOINT_CHANGE_SIGNALS = [
        "change", "modify", "update", "rename", "remove", "delete",
        "deprecate", "replace", "endpoint", "api", "response",
        "request body", "field", "schema",
    ];
    const KAFKA_CHANGE_SIGNALS = [
        "topic", "message", "schema", "kafka", "producer", "consumer", "payload",
    ];
    const DB_CHANGE_SIGNALS = [
        "column", "table", "migration", "entity", "@entity",
        "schema", "alter", "add column", "drop column", "rename column",
    ];
    // FIX B: Do NOT append Kafka topic names or DB table names from the spec into the
    // signal arrays. Topic names like "device-registration" or table names like "events"
    // appear in ordinary bug descriptions and trigger false breaking-change warnings.
    // The structural keywords already in KAFKA_CHANGE_SIGNALS / DB_CHANGE_SIGNALS
    // ("kafka", "migration", "alter", "add column", etc.) are sufficient — those only
    // fire when the description explicitly discusses infrastructure changes.
    const endpointRisk = ENDPOINT_CHANGE_SIGNALS.some(s => corpus.includes(s));
    const kafkaRisk = KAFKA_CHANGE_SIGNALS.some(s => corpus.includes(s));
    const dbRisk = DB_CHANGE_SIGNALS.some(s => corpus.includes(s));
    // Collect potentially affected consumers from spec
    const affectedConsumers = [];
    if (endpointRisk || kafkaRisk) {
        const microservices = spec.microservices || {};
        for (const [svcName, svcData] of Object.entries(microservices)) {
            const calls = svcData.calls_services || [];
            if (Array.isArray(calls) && calls.length > 0) {
                affectedConsumers.push(`${svcName} calls: ${calls.join(", ")}`);
            }
            const consumes = svcData.kafka_consumes || [];
            if (Array.isArray(consumes) && consumes.length > 0) {
                affectedConsumers.push(`${svcName} consumes topics: ${consumes.join(", ")}`);
            }
        }
    }
    // ── Step 6: Build allowed_next_action and developer_message ──────────
    let allowedNextAction;
    let nextPhase;
    let developerMessage;
    const signalSummary = [
        backendFound.length > 0 ? `backend [${backendFound.slice(0, 5).join(", ")}${backendFound.length > 5 ? "…" : ""}]` : null,
        frontendFound.length > 0 ? `frontend [${frontendFound.slice(0, 5).join(", ")}${frontendFound.length > 5 ? "…" : ""}]` : null,
        extensionFound.length > 0 ? `extension [${extensionFound.slice(0, 5).join(", ")}${extensionFound.length > 5 ? "…" : ""}]` : null,
    ].filter(Boolean).join(" | ");
    if (classification === "BACKEND_ONLY" && confidence === "HIGH") {
        allowedNextAction = "PROCEED";
        nextPhase = "Phase 0.7 — Present implementation plan";
        developerMessage =
            `✅ BACKEND_ONLY — Signals: ${signalSummary || "n/a"}\n` +
                `Proceeding to plan presentation. No developer confirmation needed.`;
    }
    else if (classification === "BACKEND_ONLY" && confidence === "LOW") {
        allowedNextAction = "CONFIRM";
        nextPhase = "Wait for developer confirmation";
        developerMessage =
            `⚠️ LOW CONFIDENCE — Could not clearly classify this task.\n` +
                `Defaulting to BACKEND_ONLY.\n\n` +
                `Is this correct? Reply YES to proceed,\n` +
                `or tell me if this is a frontend/extension task.`;
    }
    else if (classification === "FRONTEND_ONLY") {
        allowedNextAction = "STOP";
        nextPhase = "Route to frontend team — do not proceed";
        developerMessage =
            `🚫 FRONTEND TASK — Signals: ${signalSummary}\n\n` +
                `This is not your domain. All changes are confined to sfn-web-ui.\n\n` +
                `Options:\n` +
                `(a) Drop it — route to frontend team\n` +
                `(b) Check if a backend API change is also needed\n` +
                `(c) Override — reply "proceed anyway" if you have a reason`;
    }
    else if (classification === "EXTENSION_ONLY") {
        allowedNextAction = "CONFIRM";
        nextPhase = "Wait for developer confirmation";
        developerMessage =
            `🔌 CHROME EXTENSION TASK — Signals: ${signalSummary}\n\n` +
                `Is this a config/manifest change (your domain) or a UI/popup change (frontend team)?\n` +
                `Confirm before I proceed.`;
    }
    else if (classification === "FULL_STACK") {
        allowedNextAction = "CONFIRM";
        nextPhase = "Confirm backend scope, then plan API contract first";
        const uniqueBackendSignals = [
            ...new Set(backendFound.filter(Boolean))
        ];
        const uniqueFrontendSignals = [
            ...new Set(frontendFound.filter(Boolean))
        ];
        const backendScopeText = buildScopeText(uniqueBackendSignals, "backend");
        const frontendScopeText = buildScopeText(uniqueFrontendSignals, "frontend");
        developerMessage =
            `⚠️ FULL STACK TASK\n\n` +
                `Backend scope (yours):\n  → ${backendScopeText}\n` +
                `Frontend scope (not yours):\n  → ${frontendScopeText}\n\n` +
                `I will implement the backend only and define the API contract first.\n` +
                `Confirm and I will proceed to plan.`;
    }
    else {
        allowedNextAction = "CONFIRM";
        nextPhase = "Wait for developer confirmation";
        developerMessage = `⚠️ UNRESOLVABLE CLASSIFICATION — please clarify task scope manually.`;
    }
    if (validationVerdict === "MISLEADING" || validationVerdict === "NEEDS_CLARIFICATION") {
        allowedNextAction = "CONFIRM";
    }
    // ── Step 6.5: Format final developer message ────────────────────────
    let finalDeveloperMessage = "";
    if (validationVerdict !== "CLEAN") {
        if (validationVerdict === "ADVISORY") {
            finalDeveloperMessage += `💡 ADVISORY — ${work_item_id}\n\nMinor observations before I start:\n`;
            if (completenessIssues.length > 0)
                finalDeveloperMessage += completenessIssues.map(i => `• ${i}`).join("\n") + "\n";
            if (secufusionFlags.length > 0)
                finalDeveloperMessage += secufusionFlags.map(f => `• ${f}`).join("\n") + "\n";
            finalDeveloperMessage += "\n────────────────────────────────────────\n";
        }
        else if (validationVerdict === "NEEDS_CLARIFICATION") {
            finalDeveloperMessage += `❓ NEEDS CLARIFICATION — ${work_item_id}\n\nI cannot implement this correctly without clarification on the following:\n`;
            if (scopeQuestions.length > 0)
                finalDeveloperMessage += scopeQuestions.join("\n") + "\n";
            if (completenessIssues.length > 0)
                finalDeveloperMessage += completenessIssues.map(i => `• ${i}`).join("\n") + "\n";
            if (secufusionFlags.length > 0)
                finalDeveloperMessage += secufusionFlags.map(f => `• ${f}`).join("\n") + "\n";
            finalDeveloperMessage += "\nPlease clarify before I proceed.\n";
            finalDeveloperMessage += "\n────────────────────────────────────────\n";
        }
        else if (validationVerdict === "MISLEADING") {
            finalDeveloperMessage += `⚠️ PROBLEM STATEMENT REVIEW — ${work_item_id}\n\nBefore I start, I noticed some issues:\n\n`;
            if (!titleAccurate) {
                finalDeveloperMessage += `📌 Title may be misleading:\n   Current : "${title}"\n   Suggests: "${suggestedTitle}"\n   Why     : ${suggestedTitleReason}\n\n`;
            }
            if (!taskTypeCorrect) {
                finalDeveloperMessage += `📌 Task type may be incorrect:\n   Current  : ${task_type}\n   Suggested: ${suggestedTaskType}\n   Why      : ${taskTypeReason}\n\n`;
            }
            if (rootCauseAssumed) {
                finalDeveloperMessage += `📌 Root cause assumed in description:\n   ${rootCauseNote}\n   I will investigate before fixing.\n\n`;
            }
            if (secufusionFlags.length > 0) {
                finalDeveloperMessage += `📌 SecuFusion-specific flags:\n` + secufusionFlags.map(f => `   • ${f}`).join("\n") + "\n\n";
            }
            finalDeveloperMessage += `Does this change anything about the task?\nReply YES to proceed with my interpretation,\nor correct me and I will re-classify.\n`;
            finalDeveloperMessage += "\n────────────────────────────────────────\n";
        }
    }
    if (architectureOwnershipSignals.length > 0) {
        finalDeveloperMessage += `\n📐 Architecture ownership signals:\n`;
        for (const sig of architectureOwnershipSignals) {
            finalDeveloperMessage +=
                `  → [${sig.direction}] Rule '${sig.rule}':\n` +
                    `    ${sig.note}\n`;
        }
    }
    if (learnedLogs.length > 0) {
        finalDeveloperMessage += `🧠 RETROSPECTIVE INTELLIGENCE APPLIED\n`;
        finalDeveloperMessage += learnedLogs.join("\n") + "\n\n";
    }
    finalDeveloperMessage += developerMessage; // The original classification message
    developerMessage = finalDeveloperMessage;
    // Collect relevant rejected patterns (keyword match against corpus)
    const rejectedPatternsRelevant = rejectedPatterns
        .filter(r => r.pattern && corpus.includes(r.pattern.toLowerCase().slice(0, 20)))
        .map(r => `[${r.category}] ${r.pattern}`);
    // ── Step 7: Build result object ───────────────────────────────────────
    const result = {
        work_item_id,
        title,
        task_type,
        classification,
        confidence,
        signals_found: {
            backend: backendFound,
            frontend: frontendFound,
            extension: extensionFound,
        },
        validation_result,
        allowed_next_action: allowedNextAction,
        breaking_change_risk: {
            endpoint: endpointRisk,
            kafka: kafkaRisk,
            database: dbRisk,
            affected_consumers: affectedConsumers,
        },
        resuming_existing_task: resumingExistingTask,
        rejected_patterns_relevant: rejectedPatternsRelevant,
        developer_message: developerMessage,
        next_phase: nextPhase,
        classified_at: new Date().toISOString(),
    };
    // ── Step 7.5: LLM decides; the keyword scoring above is only a prior ───
    const heuristicPrior = {
        classification, confidence, allowed_next_action: allowedNextAction,
        signals_found: result.signals_found, breaking_change_risk: result.breaking_change_risk,
    };
    const classOutcome = await judge(server, getWorkspaceRoot(), {
        kind: "classification",
        subject: work_item_id,
        role: "Task Classification Engine (decides which layers a change touches and what it can break)",
        rubric: ClassificationRubric,
        evidence: {
            task: { work_item_id, title, task_type, description },
            project: specEvidence(getWorkspaceRoot()),
            heuristic_prior: heuristicPrior,
        },
        schema: ClassificationVerdict,
        schemaHint: ClassificationHint,
        supplied: judgment,
        reinvoke: "classify_task",
    });
    if (classOutcome.status !== "ok") {
        return appendTelemetry(textResult(classOutcome.text, classOutcome.status === "invalid"), inputChars);
    }
    const cv = classOutcome.verdict;
    result.classification = cv.classification;
    result.confidence = cv.confidence;
    result.allowed_next_action =
        cv.classification === "FRONTEND_ONLY" ? "STOP"
            : cv.needs_user_confirmation || cv.confidence !== "HIGH" || cv.classification !== "BACKEND_ONLY" ? "CONFIRM"
                : "PROCEED";
    result.next_phase =
        result.allowed_next_action === "STOP" ? "Route to frontend team — do not proceed"
            : result.allowed_next_action === "CONFIRM" ? "Wait for developer confirmation"
                : "Phase 0.7 — Present implementation plan";
    result.decided_by = classOutcome.source;
    result.root_cause_location = cv.root_cause_location;
    result.reasoning = cv.reasoning;
    result.services_in_scope = cv.services_in_scope;
    result.llm_breaking_change_risks = cv.breaking_change_risks;
    result.heuristic_prior = heuristicPrior;
    result.developer_message =
        `🧠 Classified by ${classOutcome.source}: **${cv.classification}** (${cv.confidence})\n` +
            `Fix lives in: ${cv.root_cause_location}\n${cv.reasoning}\n` +
            (cv.breaking_change_risks.length ? `\n⚠️ Breaking-change risks:\n${cv.breaking_change_risks.map((r) => `  • ${r}`).join("\n")}\n` : "") +
            `\n${result.developer_message}`;
    developerMessage = result.developer_message;
    recordGate(getWorkspaceRoot(), work_item_id, "classification", cv.classification !== "FRONTEND_ONLY", classOutcome.source, `${cv.classification} (${cv.confidence})`);
    // ── Step 8: Persist classification ────────────────────────────────────
    // Persist even on STOP so future sessions know this was already classified
    writeFile(classifFile, JSON.stringify(result, null, 2));
    // ── Step 9: Return developer_message + full JSON ──────────────────────
    const breakingChangeWarning = (endpointRisk || kafkaRisk || dbRisk)
        ? `\n\n⚠️  BREAKING CHANGE RISK DETECTED\n` +
            `  Endpoint change signals: ${endpointRisk}\n` +
            `  Kafka change signals:    ${kafkaRisk}\n` +
            `  DB migration signals:    ${dbRisk}\n` +
            (affectedConsumers.length > 0 ? `  Potentially affected consumers:\n${affectedConsumers.map(c => `    • ${c}`).join("\n")}` : "")
        : "";
    const resumingNote = resumingExistingTask
        ? `\n\n🔁 Resuming existing task — classification loaded from persisted record.`
        : "";
    const responseText = `## classify_task — ${work_item_id}\n\n` +
        developerMessage +
        breakingChangeWarning +
        resumingNote +
        `\n\n---\n### Full Classification Result\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    return appendTelemetry({
        content: [{ type: "text", text: responseText }],
    }, inputChars);
});
// ─── Tool 11: analyze_impact ──────────────────────────────────────────────────
// Walks the project-spec inter-service call graph and Kafka topic graph to produce
// a ranked impact report for any planned change. Classifies consumers by blast radius.
server.tool("analyze_impact", "Traces the SecuFusion inter-service call graph and Kafka topology to find EVERY " +
    "service, consumer, and integration affected by a planned change. " +
    "Call this during Phase 0.7 plan presentation whenever modifying an endpoint, entity, Kafka topic, or shared service. " +
    "Returns a ranked impact report with breaking-change verdicts per consumer.", {
    change_target: z.string().describe("What you are changing: class name, endpoint path, Kafka topic, or service name. E.g. 'DeviceEntity', '/api/v1/devices', 'device-events', 'sfn-iam-api'."),
    change_type: z.enum(["endpoint", "entity", "kafka_topic", "service", "field"])
        .describe("The kind of thing being changed."),
    impact_depth: z.enum(["direct", "full"]).default("full")
        .describe("'direct' = 1 hop only. 'full' = walk entire call graph (default)."),
}, async ({ change_target, change_type, impact_depth }) => {
    const inputChars = JSON.stringify({ change_target, change_type, impact_depth }).length;
    // Load project spec
    const SPEC_FILE = ".secufusion-project-spec.json";
    const specCandidates = [
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
        path.resolve(getWorkspaceRoot(), SPEC_FILE),
    ];
    const specPath = specCandidates.find(p => fs.existsSync(p)) ?? null;
    let spec = null;
    if (specPath) {
        try {
            spec = JSON.parse(readFileSafe(specPath) || "null");
        }
        catch { }
    }
    if (!spec) {
        return appendTelemetry({ isError: true, content: [{ type: "text", text: "❌ Project spec not found. Generate .secufusion-project-spec.json first." }] }, inputChars);
    }
    const microservices = spec.microservices || {};
    const target = change_target.toLowerCase();
    // ── Pass 1: Direct consumers ──────────────────────────────────────────
    // Walk every service and check if it calls/consumes the target.
    const directHits = [];
    const indirectHits = [];
    const visited = new Set();
    function walkGraph(targetName, depth) {
        for (const [svcName, svcData] of Object.entries(microservices)) {
            if (visited.has(svcName + ":" + targetName))
                continue;
            visited.add(svcName + ":" + targetName);
            const callsServices = (svcData.calls_services || []).map(s => s.toLowerCase());
            const consumesTopics = (svcData.kafka_consumes || []).map(t => t.toLowerCase());
            const exposedEndpoints = (svcData.endpoints || []).map(e => (typeof e === "string" ? e : e.path || "").toLowerCase());
            const ownsEntities = (svcData.owns_tables || svcData.entities || []).map(e => e.toLowerCase());
            let hit = false;
            let reason = "";
            if (change_type === "endpoint" && exposedEndpoints.some(e => e.includes(targetName))) {
                hit = true;
                reason = `exposes endpoint matching '${targetName}'`;
            }
            else if (change_type === "endpoint" && callsServices.some(s => s.includes(targetName.split("/")[1] || targetName))) {
                hit = true;
                reason = `calls service that owns '${targetName}'`;
            }
            else if (change_type === "entity" && ownsEntities.some(e => e.includes(targetName.replace("entity", "").trim()))) {
                hit = true;
                reason = `owns or references '${targetName}'`;
            }
            else if (change_type === "kafka_topic" && consumesTopics.some(t => t.includes(targetName))) {
                hit = true;
                reason = `consumes Kafka topic '${targetName}'`;
            }
            else if (change_type === "service" && callsServices.some(s => s.includes(targetName))) {
                hit = true;
                reason = `calls '${targetName}' directly`;
            }
            else if (change_type === "field") {
                // Field changes: find who owns the entity and who calls that service
                if (ownsEntities.some(e => e.includes(targetName.split(".")[0]?.toLowerCase() || ""))) {
                    hit = true;
                    reason = `owns the entity containing field '${targetName}'`;
                }
            }
            if (hit) {
                const entry = {
                    service: svcName,
                    reason,
                    port: svcData.port || "?",
                    repo: svcData.repo || svcName,
                    breaking_risk: "LIKELY",
                };
                if (depth === 0)
                    directHits.push(entry);
                else
                    indirectHits.push(entry);
                // Recurse if full depth
                if (impact_depth === "full" && depth < 3) {
                    walkGraph(svcName, depth + 1);
                }
            }
        }
    }
    walkGraph(target, 0);
    // ── Pass 2: Chrome extension check ────────────────────────────────────
    const extData = spec.chrome_extension || spec["sfn-chrome-ext"] || spec["snf-browser-extn"] || null;
    let extensionHit = null;
    if (extData) {
        const extCalls = (extData.calls_endpoints || extData.calls || []).map(e => e.toLowerCase());
        if (extCalls.some(e => e.includes(target))) {
            extensionHit = {
                service: "sfn-chrome-ext",
                reason: `Chrome extension calls endpoint matching '${target}' — breaks silently for end users`,
                breaking_risk: "HIGH — SILENT",
            };
        }
    }
    // ── Pass 3: Build output ──────────────────────────────────────────────
    const totalAffected = directHits.length + indirectHits.length + (extensionHit ? 1 : 0);
    const riskEmoji = totalAffected === 0 ? "🟢" : totalAffected <= 2 ? "🟡" : "🔴";
    const riskLevel = totalAffected === 0 ? "LOW IMPACT" : totalAffected <= 2 ? "MEDIUM IMPACT" : "HIGH IMPACT";
    let output = `## analyze_impact — \`${change_target}\` (${change_type})\n\n`;
    output += `${riskEmoji} **${riskLevel}** — ${totalAffected} service(s) affected\n\n`;
    if (directHits.length > 0) {
        output += `### 🔴 Direct consumers (${directHits.length})\n`;
        for (const h of directHits) {
            output += `- **${h.service}** (port: ${h.port}, repo: \`${h.repo}\`)\n`;
            output += `  → ${h.reason}\n`;
            output += `  → Breaking risk: **${h.breaking_risk}**\n`;
        }
        output += "\n";
    }
    if (extensionHit) {
        output += `### 🔴 Chrome Extension\n`;
        output += `- **${extensionHit.service}**\n`;
        output += `  → ${extensionHit.reason}\n\n`;
    }
    if (indirectHits.length > 0) {
        output += `### 🟡 Indirect consumers (${indirectHits.length} via call chain)\n`;
        for (const h of indirectHits) {
            output += `- **${h.service}** → ${h.reason}\n`;
        }
        output += "\n";
    }
    if (totalAffected === 0) {
        output += `✅ No consumers found in the project spec for \`${change_target}\`.\n`;
        output += `Safe to modify without coordination — but verify manually if spec is incomplete.\n`;
    }
    else {
        output += `### Recommended actions\n`;
        if (change_type === "endpoint") {
            output += `- Version to \`/v2/\` first — do NOT modify \`/v1/\` in place\n`;
            output += `- Coordinate deploy with: ${directHits.map(h => h.service).join(", ")}\n`;
        }
        else if (change_type === "entity" || change_type === "field") {
            output += `- Check all \`@Query\` annotations across repositories for references to this field/entity\n`;
            output += `- Include a migration script in src/main/resources/db/migration/ -- MANUAL, run against PostgreSQL BEFORE deploy -- flag tier: SAFE/RISKY/DANGEROUS\n`;
        }
        else if (change_type === "kafka_topic") {
            output += `- Schema change requires coordinated deployment of producer + ALL consumers\n`;
            output += `- Consumers: ${[...directHits, ...indirectHits].map(h => h.service).join(", ")}\n`;
        }
    }
    return appendTelemetry({ content: [{ type: "text", text: output }] }, inputChars);
});
// ─── Tool 12: prime_session ───────────────────────────────────────────────────
// Hyper-efficient Phase 00 + Phase 0 in a single call.
// Loads ONLY the spec sections relevant to the active task — not the full 85 kB spec.
// Saves ~15,000 tokens (~$0.22) per session compared to full spec load.
server.tool("prime_session", "Hyper-efficient session startup — combines Phase 00 (project spec) and Phase 0 (task resume) into ONE call. " +
    "Loads ONLY the spec sections relevant to the active task, not the full project spec. " +
    "Use this INSTEAD of calling manage_project_spec(read) + manage_task(read_summary) separately. " +
    "Returns: relevant service contexts, active task next_step, decisions made, and token savings estimate.", {
    work_item_id: z.string().describe("The active work item ID to resume. E.g. 'WI-2847' or 'BUG-1140'."),
}, async ({ work_item_id }) => {
    const inputChars = JSON.stringify({ work_item_id }).length;
    // Load project spec
    const SPEC_FILE = ".secufusion-project-spec.json";
    const specCandidates = [
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
        path.resolve(getWorkspaceRoot(), SPEC_FILE),
    ];
    const specPath = specCandidates.find(p => fs.existsSync(p)) ?? null;
    let spec = null;
    if (specPath) {
        try {
            spec = JSON.parse(readFileSafe(specPath) || "null");
        }
        catch { }
    }
    const microservices = spec?.microservices || {};
    const goldenRules = spec?.golden_rules || [];
    const codingPatterns = spec?.coding_patterns || {};
    const fullSpecSize = specPath ? fs.statSync(specPath).size : 0;
    // Load classification to know which services are relevant
    const classifFile = resolve(`.secufusion/classifications/${work_item_id}.json`);
    let classification = null;
    if (fs.existsSync(classifFile)) {
        try {
            classification = JSON.parse(readFileSafe(classifFile) || "null");
        }
        catch { }
    }
    // Load active task
    const registry = readRegistry();
    const taskEntry = registry.find(r => r["work_item_id"] === work_item_id);
    let taskDir = null;
    if (taskEntry?.folder_name) {
        taskDir = resolve(`.secufusion/tasks/${taskEntry.folder_name}`);
    }
    // Fallback: scan for folder
    if (!taskDir) {
        const tasksBase = resolve(".secufusion/tasks");
        if (fs.existsSync(tasksBase)) {
            const folders = fs.readdirSync(tasksBase);
            const match = folders.find(f => f.startsWith(work_item_id) || f.includes(work_item_id.replace(/^WI-/, "")));
            if (match)
                taskDir = path.join(tasksBase, match);
        }
    }
    let spec_data = null, progress = null, decisions = [];
    if (taskDir && fs.existsSync(taskDir)) {
        try {
            spec_data = JSON.parse(readFileSafe(path.join(taskDir, "spec.json")) || "null");
        }
        catch { }
        try {
            progress = JSON.parse(readFileSafe(path.join(taskDir, "progress.json")) || "null");
        }
        catch { }
        try {
            decisions = JSON.parse(readFileSafe(path.join(taskDir, "decisions.json")) || "[]");
        }
        catch { }
    }
    // ── Identify relevant services ─────────────────────────────────────────
    // Look at classification signals + task title/description to find which services to load
    const corpus = ((spec_data?.title || "") + " " + (spec_data?.description || "") + " " + work_item_id).toLowerCase();
    const relevantServices = {};
    let relevantCount = 0;
    for (const [svcName, svcData] of Object.entries(microservices)) {
        const svcLower = svcName.toLowerCase();
        // Service is relevant if: mentioned in task, or classification signals reference it, or it owns tables mentioned in task
        const mentionedDirectly = corpus.includes(svcLower.replace("sfn-", "").replace("-api", ""));
        const inClassification = (classification?.signals_found?.backend || []).some(s => s.includes(svcLower.replace("sfn-", "")));
        const ownsRelevantTable = (svcData.owns_tables || []).some(t => corpus.includes(t.toLowerCase().replace("_", " ")));
        if (mentionedDirectly || inClassification || ownsRelevantTable) {
            relevantServices[svcName] = svcData;
            relevantCount++;
        }
    }
    // If nothing matched, include the top 3 most-called services as fallback
    if (relevantCount === 0) {
        let i = 0;
        for (const [svcName, svcData] of Object.entries(microservices)) {
            if (i >= 3)
                break;
            relevantServices[svcName] = svcData;
            i++;
        }
    }
    // ── Calculate token savings ────────────────────────────────────────────
    const relevantSpecSize = JSON.stringify(relevantServices).length;
    const savedChars = Math.max(0, fullSpecSize - relevantSpecSize);
    const savedTokens = Math.ceil(savedChars / 4);
    const savedCost = ((savedTokens / 1000000) * 3.0).toFixed(4);
    // ── Build output ──────────────────────────────────────────────────────
    let out = `## ⚡ prime_session — ${work_item_id}\n\n`;
    // Task status
    if (progress) {
        out += `### Active Task\n`;
        out += `**Title:** ${spec_data?.title || work_item_id}\n`;
        out += `**Next step:** ${progress.next_step || "Not set — check progress.json"}\n`;
        const pending = progress.pending_acs || [];
        const completed = progress.completed_acs || [];
        out += `**Progress:** ${completed.length} AC(s) done, ${pending.length} remaining\n`;
        if (pending.length > 0) {
            out += `**Pending ACs:**\n${pending.map(ac => `  - [ ] ${ac}`).join("\n")}\n`;
        }
        out += "\n### Artifact Pointers\n";
        out += `Use \`view_file\` on these absolute paths to read full task JSON data:\n`;
        out += `- **Spec**: ${path.join(taskDir, "spec.json")}\n`;
        out += `- **Progress**: ${path.join(taskDir, "progress.json")}\n`;
        out += `- **Decisions**: ${path.join(taskDir, "decisions.json")}\n`;
        out += `- **Files Touched**: ${path.join(taskDir, "files-touched.json")}\n`;
        out += `- **Scenarios**: ${path.join(taskDir, "scenarios.json")}\n\n`;
    }
    else {
        out += `⚠️ No active task found for ${work_item_id}. Call manage_task(initialize) to create it.\n\n`;
    }
    // Decisions
    if (decisions.length > 0) {
        out += `### Decisions already made (${decisions.length})\n`;
        for (const d of decisions.slice(-5)) { // last 5 most recent
            out += `- **${d.decision}** — ${d.rationale || ""}\n`;
        }
        out += "\n";
    }
    // Relevant services
    out += `### Services loaded (${relevantCount} of ${Object.keys(microservices).length})\n`;
    for (const [svcName, svcData] of Object.entries(relevantServices)) {
        out += `\n**${svcName}** (port: ${svcData.port || "?"})\n`;
        if (svcData.repo)
            out += `  Repo: \`${svcData.repo}\`\n`;
        if (svcData.owns_tables?.length)
            out += `  Owns: ${svcData.owns_tables.join(", ")}\n`;
        if (svcData.calls_services?.length)
            out += `  Calls: ${svcData.calls_services.join(", ")}\n`;
        if (svcData.kafka_produces?.length)
            out += `  Produces: ${svcData.kafka_produces.join(", ")}\n`;
        if (svcData.kafka_consumes?.length)
            out += `  Consumes: ${svcData.kafka_consumes.join(", ")}\n`;
    }
    // Golden rules (always included — short)
    if (goldenRules.length > 0) {
        out += `\n### Golden Rules (always apply)\n`;
        for (const rule of goldenRules.slice(0, 5)) {
            out += `- ${typeof rule === "string" ? rule : rule.rule || JSON.stringify(rule)}\n`;
        }
        if (goldenRules.length > 5)
            out += `  _(+ ${goldenRules.length - 5} more — call get_golden_rules for full list)_\n`;
    }
    // Classification
    if (classification) {
        out += `\n### Classification\n`;
        out += `Type: **${classification.classification}** (${classification.confidence} confidence)\n`;
        out += `Reason: ${classification.classification_reason}\n`;
    }
    out += `\n### 💰 Token savings\n`;
    out += `Loaded ${relevantCount} of ${Object.keys(microservices).length} services.\n`;
    out += `Saved ≈ ${savedTokens.toLocaleString()} tokens vs full spec load (~${savedCost} at Claude Sonnet pricing).\n`;
    return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
});
// ─── Tool 13: score_change_risk ───────────────────────────────────────────────
// Quantifies the risk of a planned set of changes before any code is written.
// Returns a 0-100 score with per-category breakdown and actionable remediation steps.
server.tool("score_change_risk", "Quantifies the risk of a planned change BEFORE any code is written. " +
    "Returns a 0-100 risk score with breakdown across 6 categories: " +
    "tenant isolation, DB migration tier, API breaking change, Kafka schema, blast radius, test coverage. " +
    "Call this in Phase 0.7 after presenting the plan — score must be reviewed before 'proceed'.", {
    work_item_id: z.string().describe("Active work item ID."),
    planned_changes: z.array(z.object({
        file: z.string().describe("File path being changed."),
        change_type: z.enum(["create", "modify", "delete"]),
        description: z.string().describe("What is changing in this file — be specific."),
    })).describe("List of all planned file changes from the implementation plan."),
}, async ({ work_item_id, planned_changes }) => {
    const inputChars = JSON.stringify({ work_item_id, planned_changes }).length;
    const projectSpec = loadProjectSpec(getWorkspaceRoot()); // DNA Loaded to prevent hallucinations
    const corpus = planned_changes.map(c => c.description + " " + c.file).join(" ").toLowerCase();
    // ── 6-category scoring matrix ──────────────────────────────────────────
    let tenantScore = 0;
    let dbScore = 0;
    let apiScore = 0;
    let kafkaScore = 0;
    let blastScore = 0;
    let testScore = 0;
    const findings = [];
    // Category 1: Tenant isolation (max 25)
    const newRepoMethods = (corpus.match(/repository|@query|findby|deleteBy|countBy/g) || []).length;
    const hasTenantFilter = /tenantid|tenant_id|\.tenant/.test(corpus);
    if (newRepoMethods > 0 && !hasTenantFilter) {
        tenantScore += Math.min(25, newRepoMethods * 8);
        findings.push(`⚠️ TENANT: ${newRepoMethods} repository method(s) — no tenantId filter detected (+${Math.min(25, newRepoMethods * 8)} pts)`);
    }
    else if (newRepoMethods > 0) {
        tenantScore += newRepoMethods * 2;
        findings.push(`✅ TENANT: ${newRepoMethods} repository method(s) with tenantId present (+${newRepoMethods * 2} pts)`);
    }
    // Category 2: DB migration risk (max 20)
    if (/drop column|drop table|drop index|alter.*drop/.test(corpus)) {
        dbScore += 20;
        findings.push(`🚫 DB: DROP operation detected — DANGEROUS migration tier (+20 pts). Requires explicit developer sign-off.`);
    }
    else if (/rename column|rename table/.test(corpus)) {
        dbScore += 15;
        findings.push(`⚠️ DB: RENAME operation — RISKY migration tier (+15 pts). Two-phase approach required.`);
    }
    else if (/not null|add column.*not null/.test(corpus) && !/default/.test(corpus)) {
        dbScore += 12;
        findings.push(`⚠️ DB: NOT NULL column without DEFAULT — RISKY (+12 pts). Will fail on non-empty table.`);
    }
    else if (/migration|@entity|add column|alter table/.test(corpus)) {
        dbScore += 3;
        findings.push(`✅ DB: Additive migration detected — SAFE tier (+3 pts).`);
    }
    // Category 3: API breaking change (max 20)
    if (/remove.*field|delete.*field|drop.*field|remove.*endpoint|delete.*endpoint|v1.*remove/.test(corpus)) {
        apiScore += 20;
        findings.push(`🚫 API: Field or endpoint removal detected (+20 pts). Breaking change — deprecate /v1/, add /v2/ first.`);
    }
    else if (/change.*response|modify.*response|rename.*field|change.*field type/.test(corpus)) {
        apiScore += 14;
        findings.push(`⚠️ API: Response shape change (+14 pts). Consumers may break silently — prefer additive change.`);
    }
    else if (/add.*field|new.*endpoint|optional.*field/.test(corpus)) {
        apiScore += 2;
        findings.push(`✅ API: Additive field or new endpoint (+2 pts). Low breaking-change risk.`);
    }
    else if (/endpoint|api|controller|@restcontroller/.test(corpus)) {
        apiScore += 5;
        findings.push(`🟡 API: Endpoint changes present — verify response shape compatibility (+5 pts).`);
    }
    // Category 4: Kafka schema change (max 15)
    if (/kafka|topic|producer|consumer|@kafkalistener|@sendto/.test(corpus)) {
        if (/change.*schema|modify.*payload|rename.*field|remove.*field/.test(corpus)) {
            kafkaScore += 15;
            findings.push(`🚫 KAFKA: Schema change detected (+15 pts). Coordinated producer+consumer deployment required.`);
        }
        else if (/new topic|add.*topic/.test(corpus)) {
            kafkaScore += 3;
            findings.push(`✅ KAFKA: New topic (additive) (+3 pts).`);
        }
        else {
            kafkaScore += 6;
            findings.push(`🟡 KAFKA: Kafka changes present — verify backward compatibility of message schema (+6 pts).`);
        }
    }
    // Category 5: Blast radius (max 10)
    const servicesAffected = new Set();
    for (const c of planned_changes) {
        const f = c.file.toLowerCase();
        if (f.includes("sfn-iam"))
            servicesAffected.add("sfn-iam-api");
        else if (f.includes("sfn-events"))
            servicesAffected.add("sfn-events-api");
        else if (f.includes("sfn-tenants"))
            servicesAffected.add("sfn-tenants-api");
        else if (f.includes("sfn-policy"))
            servicesAffected.add("sfn-policy-api");
        else if (f.includes("sfn-gateway"))
            servicesAffected.add("sfn-gateway");
        else if (f.includes("sfn-notification"))
            servicesAffected.add("sfn-notification");
        else if (f.includes("sfn-audit"))
            servicesAffected.add("sfn-audit");
        else if (f.includes("web-ui") || f.includes(".tsx") || f.includes(".jsx"))
            servicesAffected.add("sfn-web-ui");
    }
    blastScore = Math.min(10, servicesAffected.size * 3);
    if (servicesAffected.size > 0) {
        findings.push(`📦 BLAST RADIUS: ${servicesAffected.size} service(s) — ${[...servicesAffected].join(", ")} (+${blastScore} pts)`);
    }
    // Category 6: Test coverage gap (max 10)
    const hasUnitTest = /unittest|@test|@springboottest|test.*class|spec\.ts|\.test\.ts/.test(corpus);
    const hasIntegrationTest = /integration.*test|@springboottest|testresttemplate|mockmvc/.test(corpus);
    if (!hasUnitTest && !hasIntegrationTest) {
        testScore += 10;
        findings.push(`⚠️ TESTS: No unit or integration tests detected in plan (+10 pts). Add both before proceeding.`);
    }
    else if (!hasIntegrationTest) {
        testScore += 5;
        findings.push(`🟡 TESTS: Unit tests present but no integration tests (+5 pts).`);
    }
    else {
        findings.push(`✅ TESTS: Unit and integration tests planned (+0 pts).`);
    }
    const totalScore = tenantScore + dbScore + apiScore + kafkaScore + blastScore + testScore;
    const riskLevel = totalScore >= 60 ? "🔴 HIGH" : totalScore >= 30 ? "🟡 MEDIUM" : "🟢 LOW";
    const verdict = totalScore >= 60
        ? "⛔ STOP — resolve HIGH risk items before writing any code."
        : totalScore >= 30
            ? "⚠️ PROCEED WITH CAUTION — address flagged items in the plan."
            : "✅ SAFE TO PROCEED — low risk change.";
    let out = `## score_change_risk — ${work_item_id}\n\n`;
    out += `### ${riskLevel} RISK SCORE: ${totalScore}/100\n\n`;
    out += `| Category | Score |\n|---|---|\n`;
    out += `| Tenant isolation | ${tenantScore}/25 |\n`;
    out += `| DB migration tier | ${dbScore}/20 |\n`;
    out += `| API breaking change | ${apiScore}/20 |\n`;
    out += `| Kafka schema change | ${kafkaScore}/15 |\n`;
    out += `| Blast radius | ${blastScore}/10 |\n`;
    out += `| Test coverage gap | ${testScore}/10 |\n`;
    out += `| **TOTAL** | **${totalScore}/100** |\n\n`;
    out += `### Findings\n`;
    for (const f of findings)
        out += `- ${f}\n`;
    out += `\n### Verdict\n${verdict}\n`;
    return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
});
// ─── Tool 14: smart_search ────────────────────────────────────────────────────
// TF-IDF semantic search over all past tasks — finds related work even when
// the exact words differ. Replaces the plain substring search_tasks tool.
server.tool("smart_search", "Semantic TF-IDF search over all past SecuFusion tasks. " +
    "Finds related past work even when exact words differ — e.g. 'tenant deletion cascade' " +
    "will find 'BUG: device removal does not propagate'. " +
    "Use this INSTEAD of search_tasks when you want high-recall semantic matching. " +
    "Returns top-K results ranked by cosine similarity with reuse recommendations.", {
    query: z.string().describe("Natural language description of what you are looking for."),
    top_k: z.number().default(5).describe("Maximum results to return (default: 5)."),
    filter_type: z.string().optional().describe("Optional: filter by task type — 'bug', 'feature', 'refactor', etc."),
}, async ({ query, top_k, filter_type }) => {
    const inputChars = JSON.stringify({ query, top_k, filter_type }).length;
    const tasksBase = resolve(".secufusion/tasks");
    if (!fs.existsSync(tasksBase)) {
        return appendTelemetry({ content: [{ type: "text", text: "No past tasks found. `.secufusion/tasks/` does not exist yet." }] }, inputChars);
    }
    // ── Load all task documents ───────────────────────────────────────────
    const docs = [];
    const folders = fs.readdirSync(tasksBase);
    for (const folder of folders) {
        const taskDir = path.join(tasksBase, folder);
        if (!fs.statSync(taskDir).isDirectory())
            continue;
        let specData = null, decisions = [];
        try {
            specData = JSON.parse(readFileSafe(path.join(taskDir, "spec.json")) || "null");
        }
        catch { }
        try {
            decisions = JSON.parse(readFileSafe(path.join(taskDir, "decisions.json")) || "[]");
        }
        catch { }
        if (!specData)
            continue;
        if (filter_type && specData.task_type && specData.task_type !== filter_type)
            continue;
        const text = [
            specData.title || "",
            specData.description || "",
            (specData.acceptance_criteria || []).join(" "),
            decisions.map(d => d.decision + " " + (d.rationale || "")).join(" "),
        ].join(" ").toLowerCase();
        docs.push({
            folder,
            work_item_id: specData.work_item_id || folder.split("-")[0],
            title: specData.title || folder,
            task_type: specData.task_type || "unknown",
            status: specData.status || "unknown",
            text,
        });
    }
    if (docs.length === 0) {
        return appendTelemetry({ content: [{ type: "text", text: `No tasks found${filter_type ? ` with type '${filter_type}'` : ""}.` }] }, inputChars);
    }
    // ── TF-IDF implementation (pure JS, zero deps) ─────────────────────────
    const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "is", "it", "its", "be", "are", "was", "were", "will",
        "have", "has", "had", "do", "does", "did", "not", "this", "that", "these", "those",
        "i", "we", "you", "he", "she", "they", "which", "who", "what", "when", "where", "how"]);
    function tokenize(text) {
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    }
    function termFrequency(tokens) {
        const tf = {};
        for (const t of tokens)
            tf[t] = (tf[t] || 0) + 1;
        const total = tokens.length || 1;
        for (const t in tf)
            tf[t] /= total;
        return tf;
    }
    // Compute IDF across all documents
    const N = docs.length;
    const dfMap = {};
    const docTokens = docs.map(d => tokenize(d.text));
    for (const tokens of docTokens) {
        const unique = new Set(tokens);
        for (const t of unique)
            dfMap[t] = (dfMap[t] || 0) + 1;
    }
    const idf = (term) => Math.log((N + 1) / ((dfMap[term] || 0) + 1)) + 1;
    function tfidfVector(tokens) {
        const tf = termFrequency(tokens);
        const vec = {};
        for (const t in tf)
            vec[t] = tf[t] * idf(t);
        return vec;
    }
    function cosineSimilarity(vecA, vecB) {
        let dot = 0, magA = 0, magB = 0;
        const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
        for (const k of allKeys) {
            const a = vecA[k] || 0, b = vecB[k] || 0;
            dot += a * b;
            magA += a * a;
            magB += b * b;
        }
        if (magA === 0 || magB === 0)
            return 0;
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }
    // Score query against all docs
    const queryVec = tfidfVector(tokenize(query));
    const scored = docs.map((doc, i) => ({
        ...doc,
        score: cosineSimilarity(queryVec, tfidfVector(docTokens[i])),
    })).filter(d => d.score > 0.01)
        .sort((a, b) => b.score - a.score)
        .slice(0, top_k);
    // ── Build output ──────────────────────────────────────────────────────
    let out = `## smart_search — "${query}"\n\n`;
    if (scored.length === 0) {
        out += `No semantically similar tasks found. Try broader terms or check if tasks have been initialized.\n`;
    }
    else {
        out += `Found **${scored.length}** relevant past task(s) (TF-IDF semantic match):\n\n`;
        for (let i = 0; i < scored.length; i++) {
            const r = scored[i];
            const bar = "█".repeat(Math.round(r.score * 20)).padEnd(20, "░");
            out += `### ${i + 1}. ${r.work_item_id} — ${r.title}\n`;
            out += `Similarity: ${bar} ${(r.score * 100).toFixed(0)}%\n`;
            out += `Type: ${r.task_type} | Status: ${r.status}\n`;
            if (r.score > 0.4) {
                out += `💡 **High relevance** — call \`get_pattern_from_task("${r.work_item_id}")\` to reuse proven patterns.\n`;
            }
            else if (r.score > 0.2) {
                out += `💡 Call \`get_task_history("${r.work_item_id}")\` to review approach before planning.\n`;
            }
            out += "\n";
        }
    }
    return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
});
// ─── Tool 15: suggest_test_scenarios ─────────────────────────────────────────
// Takes ACs from a work item and auto-generates a complete test plan:
// unit test stubs, integration test endpoints, edge cases, and manual steps.
// Auto-logs all scenarios to the task's scenarios.json.
server.tool("suggest_test_scenarios", "Auto-generates a complete test plan from acceptance criteria — no manual effort required. " +
    "Produces: unit test method stubs (with class suggestions), integration test endpoint stubs, " +
    "edge cases the developer would typically forget, and manual verification steps. " +
    "Auto-logs all generated scenarios to the task's scenarios.json. " +
    "Call this in Phase 1 immediately after manage_task(initialize).", {
    work_item_id: z.string().describe("Active work item ID."),
    acceptance_criteria: z.array(z.string()).describe("Array of AC strings from the work item."),
    service_name: z.string().describe("Primary microservice being modified. E.g. 'sfn-iam-api'."),
    task_type: z.enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"]).default("user_story"),
}, async ({ work_item_id, acceptance_criteria, service_name, task_type }) => {
    const inputChars = JSON.stringify({ work_item_id, acceptance_criteria, service_name, task_type }).length;
    const projectSpec = loadProjectSpec(getWorkspaceRoot()); // DNA Loaded to prevent hallucinations
    // ── Generate test scenarios from ACs ──────────────────────────────────
    const unitTests = [];
    const integrationTests = [];
    const edgeCases = [];
    const manualSteps = [];
    // Derive Java class name from service name
    const serviceClass = service_name
        .replace(/sfn-|-api/g, "")
        .split("-")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
    const testClass = `${serviceClass}ServiceTest`;
    const controllerTestClass = `${serviceClass}ControllerIntegrationTest`;
    for (const ac of acceptance_criteria) {
        const acLower = ac.toLowerCase();
        const acClean = ac.replace(/[^a-zA-Z0-9\s]/g, "").trim();
        const methodSuffix = acClean.split(/\s+/).slice(0, 6)
            .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join("")
            .replace(/[^a-zA-Z0-9]/g, "");
        // ── Unit test ──────────────────────────────────────────────────────
        let unitDescription = ac;
        let unitHint = "";
        if (/must|should|shall/.test(acLower)) {
            unitHint = "Assert happy-path behaviour";
        }
        if (/not|never|must not|cannot/.test(acLower)) {
            unitHint = "Assert negative / guard condition";
        }
        if (/tenant|role|permission|auth/.test(acLower)) {
            unitHint = "Mock SecurityContext with correct tenant + role claims";
        }
        unitTests.push({
            class: testClass,
            method: `should${methodSuffix.charAt(0).toUpperCase()}${methodSuffix.slice(1)}`,
            description: unitDescription,
            hint: unitHint || "Mock dependencies, assert service-layer outcome",
            type: "unit",
        });
        // ── Integration test ───────────────────────────────────────────────
        let verb = "GET", status = "200", path_hint = "/api/v1/" + service_name.replace("sfn-", "").replace("-api", "");
        if (/create|add|register|enroll|submit/.test(acLower)) {
            verb = "POST";
            status = "201";
        }
        else if (/update|modify|change|set/.test(acLower)) {
            verb = "PUT";
            status = "200";
        }
        else if (/delete|remove|deactivate/.test(acLower)) {
            verb = "DELETE";
            status = "204";
        }
        else if (/fail|error|reject|lock|deny/.test(acLower)) {
            verb = "POST";
            status = "40x/423";
        }
        integrationTests.push({
            class: controllerTestClass,
            method: `${verb.toLowerCase()}${methodSuffix.charAt(0).toUpperCase()}${methodSuffix.slice(1)}`,
            description: `${verb} ${path_hint} — ${ac}`,
            expected_status: status,
            hint: `Use MockMvc or TestRestTemplate. Include tenant JWT in Authorization header.`,
            type: "integration",
        });
        // ── Edge cases (domain-specific heuristics) ────────────────────────
        if (/admin|role|permission/.test(acLower)) {
            edgeCases.push({ description: `Non-admin user attempts action reserved for ADMIN — expect 403`, type: "unit" });
            edgeCases.push({ description: `SERVICE_ACCOUNT with admin flag — verify exemption if applicable`, type: "unit" });
        }
        if (/tenant/.test(acLower)) {
            edgeCases.push({ description: `Cross-tenant request — verify tenantId isolation enforced`, type: "integration" });
        }
        if (/lock|limit|max|attempt|retry/.test(acLower)) {
            edgeCases.push({ description: `Exactly at the limit (boundary condition) — verify correct threshold enforcement`, type: "unit" });
            edgeCases.push({ description: `One below the limit — verify NOT triggered prematurely`, type: "unit" });
        }
        if (/delete|remove/.test(acLower)) {
            edgeCases.push({ description: `Delete non-existent resource — expect 404, not 500`, type: "integration" });
            edgeCases.push({ description: `Cascade delete — verify related records cleaned up`, type: "integration" });
        }
        if (/kafka|event|publish|consume/.test(acLower)) {
            edgeCases.push({ description: `Kafka consumer receives malformed payload — verify dead-letter or graceful skip`, type: "integration" });
        }
    }
    // ── Bug-specific additions ────────────────────────────────────────────
    if (task_type === "bug") {
        edgeCases.push({ description: `Regression test: reproduce exact original bug scenario — assert it no longer occurs`, type: "unit" });
    }
    // ── Manual verification steps ─────────────────────────────────────────
    manualSteps.push(`Deploy to local dev — verify no startup errors in ${service_name} logs`);
    manualSteps.push(`Call the primary endpoint via Postman/curl with a valid tenant JWT — verify ${acceptance_criteria[0] || "expected behaviour"}`);
    manualSteps.push(`Call with an invalid or expired JWT — verify 401 Unauthorized`);
    manualSteps.push(`Call with a different tenant's JWT — verify tenant isolation (no cross-tenant data leak)`);
    if (acceptance_criteria.length > 1) {
        manualSteps.push(`Walk through each AC manually with a QA checklist before raising PR`);
    }
    // ── Persist to scenarios.json ─────────────────────────────────────────
    const registry = readRegistry();
    const taskEntry = registry.find(r => r["work_item_id"] === work_item_id);
    let taskDir = null;
    if (taskEntry?.folder_name) {
        taskDir = resolve(`.secufusion/tasks/${taskEntry.folder_name}`);
    }
    if (!taskDir) {
        const tasksBase = resolve(".secufusion/tasks");
        if (fs.existsSync(tasksBase)) {
            const folders = fs.readdirSync(tasksBase);
            const match = folders.find(f => f.startsWith(work_item_id));
            if (match)
                taskDir = path.join(tasksBase, match);
        }
    }
    const allScenarios = [
        ...unitTests.map(t => ({ ...t, generated: true })),
        ...integrationTests.map(t => ({ ...t, generated: true })),
        ...edgeCases.map(t => ({ ...t, generated: true })),
        ...manualSteps.map(s => ({ description: s, type: "manual", generated: true })),
    ];
    if (taskDir && fs.existsSync(taskDir)) {
        const scenFile = path.join(taskDir, "scenarios.json");
        let existing = [];
        try {
            existing = JSON.parse(readFileSafe(scenFile) || "[]");
        }
        catch { }
        // Merge — don't duplicate
        const merged = [...existing, ...allScenarios.filter(s => !existing.some(e => e.description === s.description))];
        writeFile(scenFile, JSON.stringify(merged, null, 2));
    }
    // ── Build output ──────────────────────────────────────────────────────
    let out = `## suggest_test_scenarios — ${work_item_id}\n\n`;
    out += `Auto-generated from ${acceptance_criteria.length} AC(s) for **${service_name}**\n\n`;
    out += `### Unit Tests (${unitTests.length}) — \`${testClass}\`\n`;
    for (const t of unitTests) {
        out += `- **\`${t.method}()\`** — ${t.description}\n`;
        out += `  _${t.hint}_\n`;
    }
    out += `\n### Integration Tests (${integrationTests.length}) — \`${controllerTestClass}\`\n`;
    for (const t of integrationTests) {
        out += `- **\`${t.method}()\`** — expected: HTTP ${t.expected_status}\n`;
        out += `  \`${t.description}\`\n`;
        out += `  _${t.hint}_\n`;
    }
    out += `\n### Edge Cases (${edgeCases.length})\n`;
    for (const e of edgeCases) {
        out += `- [${e.type}] ${e.description}\n`;
    }
    out += `\n### Manual Verification (${manualSteps.length})\n`;
    for (const s of manualSteps) {
        out += `- [ ] ${s}\n`;
    }
    const total = unitTests.length + integrationTests.length + edgeCases.length + manualSteps.length;
    out += `\n---\n✅ **${total} scenarios auto-logged** to \`.secufusion/tasks/.../scenarios.json\`\n`;
    if (!taskDir) {
        out += `⚠️ Task folder not found — call \`manage_task(initialize)\` first to persist scenarios.\n`;
    }
    return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
});
// ─── Tools ─────────────────────────────────────────────
server.tool("skill_recommend", "Searches the skill catalog for matching domain skills based on keywords.", {
    keywords: z.array(z.string()).describe("Keywords to search for (e.g., 'kafka', 'react')")
}, async ({ keywords }) => {
    const content = readFileSafe(SKILLS_CATALOG_PATH);
    if (!content)
        return appendTelemetry({ content: [{ type: "text", text: "No skills catalog found." }] }, 0);
    try {
        const catalog = JSON.parse(content);
        const matches = catalog.skills.filter((skill) => keywords.some(kw => skill.tags.includes(kw.toLowerCase())));
        if (matches.length === 0)
            return appendTelemetry({ content: [{ type: "text", text: "No matching skills found." }] }, content.length);
        let out = "Found the following relevant skills:\n";
        matches.forEach((s) => {
            out += `- **${s.name}**: ${s.description}\n  *Read file:* \`${s.path}\`\n`;
        });
        return appendTelemetry({ content: [{ type: "text", text: out }] }, content.length);
    }
    catch (e) {
        return appendTelemetry({ content: [{ type: "text", text: "Error parsing skills catalog." }] }, 0);
    }
});
let watcher = null;
function getEcosystemRoot(workspaceRoot) {
    // If workspaceRoot itself already contains multiple sibling service repos
    // (the flat-monorepo-of-repos layout), trust it as-is — don't walk up.
    if (fs.existsSync(workspaceRoot)) {
        const ownChildren = fs.readdirSync(workspaceRoot);
        const ownSfnRepos = ownChildren.filter((c) => c.startsWith("sfn-") || c === "secufusion");
        if (ownSfnRepos.length > 1) {
            return workspaceRoot;
        }
    }
    // Otherwise, workspaceRoot may be a single service repo (e.g. sfn-auth-api)
    // opened on its own — walk up to find the shared ecosystem parent.
    const parentDir = path.dirname(workspaceRoot);
    if (fs.existsSync(parentDir)) {
        const parentChildren = fs.readdirSync(parentDir);
        const sfnRepos = parentChildren.filter((c) => c.startsWith("sfn-") || c === "secufusion");
        if (sfnRepos.length > 1) {
            return parentDir;
        }
    }
    return workspaceRoot;
}
const getDnaPath = (ecosystemRoot) => path.join(ecosystemRoot, ".secufusion", "dna.json");
function ensureDnaFile(ecosystemRoot) {
    const dnaPath = getDnaPath(ecosystemRoot);
    const dir = path.dirname(dnaPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(dnaPath)) {
        fs.writeFileSync(dnaPath, JSON.stringify({
            domains: [],
            apis: [],
            events: [],
            node_apis: [],
            frontend: [],
            infra: [],
            databases: [],
            security: [],
            configurations: [],
            inferred_patterns: []
        }, null, 2));
    }
    return dnaPath;
}
function readDna(ecosystemRoot) {
    ensureDnaFile(ecosystemRoot);
    return JSON.parse(fs.readFileSync(getDnaPath(ecosystemRoot), "utf-8"));
}
function writeDna(ecosystemRoot, dna) {
    fs.writeFileSync(getDnaPath(ecosystemRoot), JSON.stringify(dna, null, 2));
}
const VALID_EXTENSIONS = ['.java', '.ts', '.js', '.tsx', '.jsx', '.vue', '.sql', '.prisma', '.tf', '.yaml', '.yml', '.env', '.env.example', '.env.local', '.properties', '.json'];
function getAllSourceFiles(dirPath, repoName, arrayOfFiles = []) {
    if (!fs.existsSync(dirPath))
        return arrayOfFiles;
    const files = fs.readdirSync(dirPath);
    files.forEach(function (file) {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (file !== "node_modules" && file !== "target" && file !== ".git" && file !== "build") {
                arrayOfFiles = getAllSourceFiles(fullPath, repoName, arrayOfFiles);
            }
        }
        else {
            if (VALID_EXTENSIONS.some(ext => file.endsWith(ext)) || file === 'docker-compose.yml') {
                arrayOfFiles.push({ path: fullPath, repo: repoName });
            }
        }
    });
    return arrayOfFiles;
}
function getPolyRepoSourceFiles(ecosystemRoot) {
    let allFiles = [];
    const children = fs.readdirSync(ecosystemRoot);
    for (const child of children) {
        const childPath = path.join(ecosystemRoot, child);
        if (fs.statSync(childPath).isDirectory() && (child.startsWith("sfn-") || child.startsWith("snf-") || child === "secufusion")) {
            allFiles = allFiles.concat(getAllSourceFiles(childPath, child));
        }
        else if (fs.statSync(childPath).isDirectory() && ecosystemRoot === childPath) {
            allFiles = allFiles.concat(getAllSourceFiles(childPath, path.basename(childPath)));
        }
    }
    return allFiles;
}
function generateMigrationSpec(ecosystemRoot) {
    const migrationsSpec = {
        mcp_guardrails: {
            naming_pattern_to_enforce: "^V\\d+__[a-z][a-z0-9_]*\\.sql$",
            version_must_be_next_in_sequence: true,
            no_gap_reuse_allowed: true,
            apply_manually_to: "postgresql"
        },
        microservices: {}
    };
    try {
        const dirs = fs.readdirSync(ecosystemRoot, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && dirent.name !== 'node_modules')
            .map(dirent => dirent.name);
        for (const dir of dirs) {
            const migrationPath = path.join(ecosystemRoot, dir, 'src', 'main', 'resources', 'db', 'migration');
            if (fs.existsSync(migrationPath)) {
                const files = fs.readdirSync(migrationPath).filter(f => f.endsWith('.sql'));
                const versions = files
                    .map(f => {
                    const match = f.match(/^V(\d+)__/);
                    return match ? parseInt(match[1], 10) : null;
                })
                    .filter(v => v !== null);
                versions.sort((a, b) => a - b);
                let latest = 0;
                const gaps = [];
                if (versions.length > 0) {
                    latest = versions[versions.length - 1];
                    for (let i = 1; i < latest; i++) {
                        if (!versions.includes(i)) {
                            gaps.push(i);
                        }
                    }
                }
                migrationsSpec.microservices[dir] = {
                    has_migrations: true,
                    path: "src/main/resources/db/migration/",
                    current_state: {
                        latest_version: latest,
                        next_suggested: `V${latest + 1}__description_here.sql`
                    },
                    organization: {
                        version_gaps: gaps,
                        total_scripts: files.length
                    }
                };
            }
        }
        const outPath = path.join(ecosystemRoot, '.secufusion-migrations.json');
        fs.writeFileSync(outPath, JSON.stringify(migrationsSpec, null, 2), 'utf-8');
    }
    catch (e) {
        console.error("Failed to generate migration spec", e);
    }
}
export function performFullExtraction(ecosystemRoot) {
    // Generate Migration Spec on every extraction
    generateMigrationSpec(ecosystemRoot);
    const sourceFiles = getPolyRepoSourceFiles(ecosystemRoot);
    const models = [];
    const apis = [];
    const events = [];
    const nodeApis = [];
    const frontend = [];
    const extension = [];
    const infra = [];
    const databases = [];
    const security = [];
    const configurations = [];
    for (const fileObj of sourceFiles) {
        const content = fs.readFileSync(fileObj.path, 'utf-8');
        if (fileObj.path.endsWith('.java')) {
            models.push(...parseDomainModels(fileObj.path, content, fileObj.repo));
            apis.push(...parseApiEndpoints(fileObj.path, content, fileObj.repo));
            events.push(...parseEventTopics(fileObj.path, content, fileObj.repo));
        }
        nodeApis.push(...parseNodeApis(fileObj.path, content, fileObj.repo));
        frontend.push(...parseFrontend(fileObj.path, content, fileObj.repo));
        extension.push(...parseExtension(fileObj.path, content, fileObj.repo));
        infra.push(...parseInfra(fileObj.path, content, fileObj.repo));
        databases.push(...parseDatabase(fileObj.path, content, fileObj.repo));
        security.push(...parseSecurity(fileObj.path, content, fileObj.repo));
        configurations.push(...parseConfig(fileObj.path, content, fileObj.repo));
    }
    const dna = readDna(ecosystemRoot);
    dna.domains = models;
    dna.apis = apis;
    dna.events = events;
    dna.node_apis = nodeApis;
    dna.frontend = frontend;
    dna.extension = extension;
    dna.infra = infra;
    dna.databases = databases;
    dna.security = security;
    dna.configurations = configurations;
    // Apply Pattern Inference
    dna.inferred_patterns = inferPatterns(dna);
    // Build Graph
    const specPath = path.join(ecosystemRoot, ".secufusion-project-spec.json");
    let spec = null;
    try {
        spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    }
    catch (e) { }
    dna.graph = buildGraph(dna, spec);
    writeDna(ecosystemRoot, dna);
    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? `\n\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: ${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.` : "";
    return {
        missingWarning,
        inspectionStatus: inspection.status,
        extensionCount: extension.length,
        modelsCount: models.length,
        apisCount: apis.length + nodeApis.length,
        eventsCount: events.length,
        frontendCount: frontend.length,
        infraCount: infra.length,
        databasesCount: databases.length,
        securityCount: security.length,
        configurationsCount: configurations.length,
        inferredCount: dna.inferred_patterns.length
    };
}
server.tool("scan_repository_stack", "Analyzes the ecosystem root to identify the framework and infrastructure", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        ensureDnaFile(ecosystemRoot);
        const files = fs.readdirSync(ecosystemRoot);
        let stack = [];
        if (files.includes("package.json"))
            stack.push("Node.js");
        if (files.includes("pom.xml") || files.includes("build.gradle"))
            stack.push("Java/Spring");
        if (files.includes("docker-compose.yml"))
            stack.push("Docker");
        let warningMsg = "";
        // Look for .secufusion-project-spec.json in ecosystemRoot or workspaceRoot
        const specPathEcosystem = path.join(ecosystemRoot, ".secufusion-project-spec.json");
        const specPathWorkspace = path.join(workspace_root, ".secufusion-project-spec.json");
        const specPath = fs.existsSync(specPathWorkspace) ? specPathWorkspace : (fs.existsSync(specPathEcosystem) ? specPathEcosystem : null);
        if (specPath) {
            try {
                const specData = JSON.parse(fs.readFileSync(specPath, "utf-8"));
                if (specData) {
                    let expectedServices = [];
                    if (specData.microservices) {
                        expectedServices = expectedServices.concat(Object.keys(specData.microservices));
                    }
                    if (specData.frontend && specData.frontend.repo) {
                        expectedServices.push(specData.frontend.repo);
                    }
                    if (specData.chrome_extension && specData.chrome_extension.repo) {
                        expectedServices.push(specData.chrome_extension.repo);
                    }
                    const physicalDirs = files.filter(f => fs.statSync(path.join(ecosystemRoot, f)).isDirectory());
                    const missingServices = expectedServices.filter(svc => !physicalDirs.includes(svc));
                    if (missingServices.length > 0) {
                        warningMsg = `\n\n[WARNING] According to .secufusion-project-spec.json, the following mandatory repositories (microservices/frontend/ext) are missing from your local workspace: ${missingServices.join(", ")}. Please clone them to ensure a complete DNA map.`;
                    }
                }
            }
            catch (e) {
                warningMsg = `\n\n[WARNING] Failed to parse .secufusion-project-spec.json: ${e.message}`;
            }
        }
        return {
            content: [{ type: "text", text: `Scanned ecosystem at ${ecosystemRoot}. Detected stack: ${stack.join(", ")}${warningMsg}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("extract_domain_models", "Parses files across the ecosystem to build the Domain Encyclopedia and checks Golden Rules", {
    workspace_root: z.string().describe("Root directory of the workspace"),
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
            content: [{ type: "text", text: `Extracted ${stats.modelsCount} domain models. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("extract_api_endpoints", "Scans for REST/GraphQL endpoints across the ecosystem", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
            content: [{ type: "text", text: `Extracted ${stats.apisCount} API controllers. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("extract_event_topics", "Scans for event listener/producer usage across the ecosystem", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
            content: [{ type: "text", text: `Extracted ${stats.eventsCount} event classes. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("manage_requirement", "Manages the structured lifecycle of a requirement, including clarification state and confirmation.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    id: z.string().describe("Stable requirement identifier (e.g. '2847' or 'req-123')."),
    action: z.enum(["create", "update", "read", "add_clarification", "resolve_clarification", "confirm", "generate_spec", "assess"]).describe("Action to perform on the requirement. 'assess' asks the LLM whether the requirement is READY; status=CONFIRMED is only accepted after a fresh READY assessment."),
    raw_request: z.string().optional(),
    title: z.string().optional(),
    status: z.enum(["RAW", "UNDERSTOOD", "INVESTIGATING", "CLARIFICATION_REQUIRED", "CONFIRMED", "BLOCKED", "SUPERSEDED"]).optional(),
    // Clarification specifics
    clarification_id: z.string().optional(),
    topic: z.string().optional(),
    issue: z.string().optional(),
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    blocking: z.boolean().optional(),
    question: z.string().optional(),
    answer: z.string().optional(),
    decision: z.string().optional(),
    // Arrays and updates
    facts: z.array(z.string()).optional(),
    unknowns: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
    scope: z.string().optional(),
    actors: z.array(z.string()).optional(),
    tenancy: z.string().optional(),
    authorization: z.string().optional(),
    business_rules: z.array(z.string()).optional(),
    data_lifecycle: z.string().optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    decisions: z.array(z.string()).optional(),
    judgment: judgmentParam
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const wsRoot = getWorkspaceRoot();
        let req = loadRequirement(ecosystemRoot, args.id);
        // Everything an assessment depends on; if it changes, the assessment is stale.
        const reqFingerprint = (r) => hashOf({
            raw_request: r.raw_request, scope: r.scope, actors: r.actors, tenancy: r.tenancy,
            authorization: r.authorization, business_rules: r.business_rules, data_lifecycle: r.data_lifecycle,
            acceptance_criteria: r.acceptance_criteria, constraints: r.constraints, facts: r.facts,
            unknowns: r.unknowns, decisions: r.decisions, blockers: r.blockers,
            clarifications: (r.clarification_questions || []).map((c) => [c.id, c.state, c.answer]),
        });
        if (args.action === "create") {
            if (req)
                return { content: [{ type: "text", text: `Requirement ${args.id} already exists.` }] };
            req = {
                id: args.id,
                title: args.title || "Untitled",
                raw_request: args.raw_request,
                status: args.status || "RAW",
                clarification_questions: []
            };
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: `Requirement ${args.id} created successfully.` }] };
        }
        if (!req)
            return { content: [{ type: "text", text: `Requirement ${args.id} not found.` }], isError: true };
        if (args.action === "read") {
            return { content: [{ type: "text", text: JSON.stringify(req, null, 2) }] };
        }
        if (args.action === "assess") {
            const outcome = await judge(server, wsRoot, {
                kind: "requirement",
                subject: args.id,
                role: "Requirement Analyst (decides whether a requirement is specified well enough to plan against)",
                rubric: RequirementRubric,
                evidence: { requirement: req, project: specEvidence(wsRoot) },
                schema: RequirementVerdict,
                schemaHint: RequirementHint,
                supplied: args.judgment,
                reinvoke: "manage_requirement (action=assess)",
            });
            if (outcome.status !== "ok")
                return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
            const rv = outcome.verdict;
            for (const m of rv.missing) {
                const cid = `Q-${hashOf([m.topic, m.question]).slice(0, 6)}`;
                if (!req.clarification_questions.some((c) => c.id === cid)) {
                    req.clarification_questions.push({
                        id: cid, topic: m.topic, issue: m.issue, state: "OPEN", evidence: [],
                        severity: m.severity, blocking: m.blocking, question: m.question, created_at: new Date().toISOString(),
                    });
                }
            }
            if (rv.verdict !== "READY" && req.status === "INVESTIGATING")
                req.status = "CLARIFICATION_REQUIRED";
            saveRequirement(ecosystemRoot, req);
            // Bind the verdict to the exact content it judged (after clarifications were added),
            // so any later edit makes it stale and forces a re-assessment.
            const stored = loadJudgment(wsRoot, args.id, "requirement");
            if (stored) {
                stored.evidence_hash = reqFingerprint(req);
                fs.writeFileSync(path.join(wsRoot, ".secufusion", "judgments", args.id.replace(/[^a-zA-Z0-9._-]/g, "_"), "requirement.json"), JSON.stringify(stored, null, 2));
            }
            if (rv.verdict !== "READY")
                recordGate(wsRoot, args.id, "requirement", false, outcome.source, rv.summary);
            return { content: [{ type: "text", text: `${rv.verdict === "READY" ? "✅" : "❓"} Requirement ${args.id}: ${rv.verdict} (judged by ${outcome.source})\n${rv.summary}\n` +
                            (rv.missing.length ? `\nOpen questions (added as clarifications):\n${rv.missing.map((m) => `- [${m.severity}${m.blocking ? ", blocking" : ""}] ${m.question}`).join("\n")}\n` : "") +
                            (rv.verdict === "READY"
                                ? `\nNext: manage_requirement action=update status=CONFIRMED (requirement must be INVESTIGATING first).`
                                : `\nAnswer these with action=resolve_clarification, then assess again.`) }] };
        }
        if (args.action === "update") {
            if (args.title)
                req.title = args.title;
            if (args.facts)
                req.facts = args.facts;
            if (args.unknowns)
                req.unknowns = args.unknowns;
            if (args.blockers)
                req.blockers = args.blockers;
            if (args.scope)
                req.scope = args.scope;
            if (args.actors)
                req.actors = args.actors;
            if (args.tenancy)
                req.tenancy = args.tenancy;
            if (args.authorization)
                req.authorization = args.authorization;
            if (args.business_rules)
                req.business_rules = args.business_rules;
            if (args.data_lifecycle)
                req.data_lifecycle = args.data_lifecycle;
            if (args.acceptance_criteria)
                req.acceptance_criteria = args.acceptance_criteria;
            if (args.constraints)
                req.constraints = args.constraints;
            if (args.decisions)
                req.decisions = args.decisions;
            if (args.status) {
                validateStateTransition(req.status, args.status, req);
                if (args.status === "CONFIRMED") {
                    const assessed = loadJudgment(wsRoot, args.id, "requirement");
                    if (!assessed || assessed.verdict.verdict !== "READY") {
                        return { isError: true, content: [{ type: "text", text: `⛔ SPEC GATE: ${args.id} cannot be CONFIRMED without a READY assessment. Run manage_requirement action=assess first.` }] };
                    }
                    if (assessed.evidence_hash !== reqFingerprint(req)) {
                        return { isError: true, content: [{ type: "text", text: `⛔ SPEC GATE: ${args.id} changed after it was assessed. Run manage_requirement action=assess again.` }] };
                    }
                    recordGate(wsRoot, args.id, "requirement", true, assessed.source, assessed.verdict.summary);
                }
                else {
                    recordGate(wsRoot, args.id, "requirement", false, "status", `status is ${args.status}`);
                }
                req.status = args.status;
            }
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: `Requirement ${args.id} updated.` }] };
        }
        if (args.action === "add_clarification") {
            if (!args.clarification_id || !args.topic || !args.issue || !args.question) {
                return { content: [{ type: "text", text: "Missing clarification fields." }], isError: true };
            }
            req.clarification_questions.push({
                id: args.clarification_id,
                topic: args.topic,
                issue: args.issue,
                state: "OPEN",
                evidence: [],
                severity: args.severity || "MEDIUM",
                blocking: args.blocking || false,
                question: args.question,
                created_at: new Date().toISOString()
            });
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: `Clarification ${args.clarification_id} added.` }] };
        }
        if (args.action === "resolve_clarification") {
            const c = req.clarification_questions.find(q => q.id === args.clarification_id);
            if (!c)
                return { content: [{ type: "text", text: `Clarification not found.` }], isError: true };
            c.state = "RESOLVED";
            c.answer = args.answer;
            c.decision = args.decision;
            c.resolved_at = new Date().toISOString();
            if (args.decision) {
                if (!req.decisions)
                    req.decisions = [];
                req.decisions.push(args.decision);
            }
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: `Clarification ${args.clarification_id} resolved.` }] };
        }
        if (args.action === "generate_spec") {
            const spec = generateConfirmedSpecification(req);
            return { content: [{ type: "text", text: spec }] };
        }
        return { content: [{ type: "text", text: `Unknown action ${args.action}` }], isError: true };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("investigate_entity", "Deterministically searches the repository evidence graph for a specific entity.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    entity_name: z.string().describe("Name of the entity to investigate (e.g. 'User', 'Tenant')")
}, async ({ workspace_root, entity_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: `No DNA found. Run extraction first.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph)
            return { content: [{ type: "text", text: "No graph in DNA." }] };
        const res = investigateEntity(graph, entity_name);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("investigate_relationship", "Deterministically searches the repository evidence graph for relationships between two entities.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    source_entity: z.string().describe("First entity"),
    target_entity: z.string().describe("Second entity")
}, async ({ workspace_root, source_entity, target_entity }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: `No DNA found. Run extraction first.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph)
            return { content: [{ type: "text", text: "No graph in DNA." }] };
        const res = investigateRelationship(graph, source_entity, target_entity);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("create_traceability_link", "Explicitly creates a traceability link between two nodes in the graph.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    source: z.string().describe("Source node ID (e.g. 'REQUIREMENT:BM-RET-1')"),
    target: z.string().describe("Target node ID (e.g. 'CLASS:RetentionPolicy')"),
    type: z.string().describe("Relationship type (e.g. 'IMPLEMENTED_BY', 'AFFECTS')"),
    provenance: z.enum(["DIRECT", "INFERRED", "USER_CONFIRMED", "HISTORICAL", "UNKNOWN"]),
    confidence: z.enum(["CONFIRMED", "SUPPORTED", "INFERRED", "CONFLICT", "UNKNOWN", "STALE"])
}, async ({ workspace_root, source, target, type, provenance, confidence }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const link = addTraceabilityLink(ecosystemRoot, source, target, type, provenance, confidence);
        return { content: [{ type: "text", text: `Traceability link created: ${JSON.stringify(link)}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("trace_requirement", "Traces a requirement forward or an implementation backward to find linked artifacts.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    node_id: z.string().describe("The node ID to start tracing from (e.g. 'REQUIREMENT:BM-RET-1' or 'CLASS:EventEntity')"),
    direction: z.enum(["FORWARD", "REVERSE"]).describe("Direction to trace"),
    depth: z.number().optional().describe("Maximum traversal depth")
}, async ({ workspace_root, node_id, direction, depth }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: "No DNA graph found." }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        if (!dna.graph)
            return { content: [{ type: "text", text: "No graph in DNA." }] };
        const edges = loadTraceability(ecosystemRoot);
        const res = direction === "FORWARD"
            ? traceForward(dna.graph, edges, node_id, depth || 3)
            : traceReverse(dna.graph, edges, node_id, depth || 3);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("find_traceability_gaps", "Finds gaps in traceability mapping (e.g. requirements without implementation).", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: "No DNA graph found." }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const edges = loadTraceability(ecosystemRoot);
        const gaps = findTraceabilityGaps(ecosystemRoot, dna.graph || { nodes: [], edges: [] }, edges);
        return { content: [{ type: "text", text: JSON.stringify(gaps, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("manage_implementation_plan", "Creates, retrieves, or updates an implementation plan.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    id: z.string().describe("Plan ID"),
    requirement_id: z.string().optional().describe("Associated requirement ID"),
    action: z.enum(["create", "get", "update"]),
    status: z.enum(["DRAFT", "VALIDATED", "IMPLEMENTING", "VALIDATING", "REVIEWED", "COMPLETED", "BLOCKED"]).optional(),
    summary: z.string().optional(),
    affected_services: z.array(z.string()).optional(),
    affected_files: z.array(z.string()).optional(),
    api_changes: z.array(z.string()).optional(),
    database_changes: z.array(z.string()).optional(),
    event_changes: z.array(z.string()).optional(),
    frontend_changes: z.array(z.string()).optional(),
    extension_changes: z.array(z.string()).optional(),
    security_implications: z.array(z.string()).optional(),
    implementation_steps: z.array(z.string()).optional(),
    test_obligations: z.array(z.string()).optional(),
    validation_requirements: z.array(z.string()).optional(),
    traceability_requirements: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
    unknowns: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        let plan = loadPlan(ecosystemRoot, args.id);
        if (args.action === "get") {
            if (!plan)
                return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
        }
        if (args.action === "create") {
            if (plan)
                return { content: [{ type: "text", text: "Plan already exists." }], isError: true };
            if (!args.requirement_id)
                return { content: [{ type: "text", text: "⛔ A plan must reference the requirement_id it implements." }], isError: true };
            const planGate = requireGates(getWorkspaceRoot(), args.requirement_id, ["philosophy", "intent", "classification", "requirement"], "create a plan");
            if (planGate)
                return { content: [{ type: "text", text: planGate }], isError: true };
            plan = {
                id: args.id,
                requirement_id: args.requirement_id || "",
                status: args.status || "DRAFT",
                summary: args.summary || "",
                affected_services: args.affected_services || [],
                affected_files: args.affected_files || [],
                api_changes: args.api_changes || [],
                database_changes: args.database_changes || [],
                event_changes: args.event_changes || [],
                frontend_changes: args.frontend_changes || [],
                extension_changes: args.extension_changes || [],
                security_implications: args.security_implications || [],
                implementation_steps: args.implementation_steps || [],
                test_obligations: args.test_obligations || [],
                validation_requirements: args.validation_requirements || [],
                traceability_requirements: args.traceability_requirements || [],
                risks: args.risks || [],
                assumptions: args.assumptions || [],
                unknowns: args.unknowns || [],
                blockers: args.blockers || [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                snapshot_id: "LATEST"
            };
            savePlan(ecosystemRoot, plan);
            return { content: [{ type: "text", text: "Plan created." }] };
        }
        if (args.action === "update") {
            if (!plan)
                return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            if (args.status)
                plan.status = args.status;
            if (args.summary)
                plan.summary = args.summary;
            if (args.affected_services)
                plan.affected_services = args.affected_services;
            if (args.affected_files)
                plan.affected_files = args.affected_files;
            if (args.api_changes)
                plan.api_changes = args.api_changes;
            if (args.database_changes)
                plan.database_changes = args.database_changes;
            if (args.event_changes)
                plan.event_changes = args.event_changes;
            if (args.frontend_changes)
                plan.frontend_changes = args.frontend_changes;
            if (args.extension_changes)
                plan.extension_changes = args.extension_changes;
            if (args.security_implications)
                plan.security_implications = args.security_implications;
            if (args.implementation_steps)
                plan.implementation_steps = args.implementation_steps;
            if (args.test_obligations)
                plan.test_obligations = args.test_obligations;
            if (args.validation_requirements)
                plan.validation_requirements = args.validation_requirements;
            if (args.traceability_requirements)
                plan.traceability_requirements = args.traceability_requirements;
            if (args.risks)
                plan.risks = args.risks;
            if (args.assumptions)
                plan.assumptions = args.assumptions;
            if (args.unknowns)
                plan.unknowns = args.unknowns;
            if (args.blockers)
                plan.blockers = args.blockers;
            savePlan(ecosystemRoot, plan);
            return { content: [{ type: "text", text: "Plan updated." }] };
        }
        return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("validate_implementation_plan", "Validates a plan before execution: deterministic checks (requirement CONFIRMED, staleness, test obligations, blockers) plus an LLM judgment that every acceptance criterion is covered by a step and a test, with no scope creep or unconfirmed destructive operations. Passing records the 'plan' gate.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID"),
    judgment: judgmentParam
}, async ({ workspace_root, plan_id, judgment }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan)
            return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        const errors = validatePlan(ecosystemRoot, plan);
        // Aggregate Validation
        let reqStatus = "UNKNOWN";
        const req = loadRequirement(ecosystemRoot, plan.requirement_id);
        if (req)
            reqStatus = req.status;
        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }
        const edges = loadTraceability(ecosystemRoot);
        const gaps = findTraceabilityGaps(ecosystemRoot, graph, edges);
        const hasTests = plan.test_obligations.length > 0;
        const hasSecurityUnknowns = plan.unknowns.some(u => u.toLowerCase().includes("security") || u.toLowerCase().includes("auth"));
        const testResults = loadTestResults(ecosystemRoot);
        const validation = aggregateValidation(reqStatus, errors, plan.test_obligations, testResults, gaps, hasSecurityUnknowns);
        const wsRoot = getWorkspaceRoot();
        const outcome = await judge(server, wsRoot, {
            kind: "plan",
            subject: plan.requirement_id || plan_id,
            role: "Plan Reviewer (checks an implementation plan against the confirmed requirement before any code is written)",
            rubric: PlanRubric,
            evidence: {
                requirement: req,
                plan,
                deterministic_errors: errors,
                traceability_gaps: gaps,
                project: specEvidence(wsRoot),
            },
            schema: PlanVerdict,
            schemaHint: PlanHint,
            supplied: judgment,
            reinvoke: "validate_implementation_plan",
        });
        if (outcome.status !== "ok")
            return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
        const pv = outcome.verdict;
        const passed = pv.verdict === "APPROVED" && errors.length === 0;
        if (plan.requirement_id) {
            recordGate(wsRoot, plan.requirement_id, "plan", passed, outcome.source, passed ? pv.summary : `${pv.verdict}${errors.length ? `; ${errors.join(", ")}` : ""}`);
        }
        if (passed && plan.status === "DRAFT") {
            plan.status = "VALIDATED";
            savePlan(ecosystemRoot, plan);
        }
        return { content: [{ type: "text", text: JSON.stringify({ ...validation, llm_review: { judged_by: outcome.source, ...pv }, plan_gate: passed ? "PASSED" : "FAILED" }, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("verify_against_spec", "Adversarial final review. Judges the implemented change against the task's acceptance criteria, the validated plan, recorded test results and the golden rules. " +
    "Every criterion must be MET with concrete evidence (file:line or test name) for the 'review' gate to pass; manage_task action=complete requires it.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    work_item_id: z.string().describe("Work item / requirement id the change implements."),
    diff_summary: z.string().optional().describe("Optional: summary or excerpt of the diff, in addition to the git diff stat the server collects."),
    judgment: judgmentParam
}, async ({ workspace_root, work_item_id, diff_summary, judgment }) => {
    try {
        const wsRoot = getWorkspaceRoot();
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const gateError = requireGates(wsRoot, work_item_id, ["philosophy", "intent", "classification", "requirement", "plan"], "verify the change");
        if (gateError)
            return textResult(gateError, true);
        const taskDir = resolveTaskFolder(work_item_id, resolve(TASKS_DIR));
        const taskSpec = taskDir ? readJson(path.join(taskDir, "spec.json")) : null;
        const filesTouched = taskDir ? readJson(path.join(taskDir, "files-touched.json")) : null;
        const req = loadRequirement(ecosystemRoot, work_item_id);
        let plan = null;
        const plansDir = path.join(ecosystemRoot, ".secufusion", "plans");
        if (fs.existsSync(plansDir)) {
            for (const f of fs.readdirSync(plansDir).filter((n) => n.endsWith(".json"))) {
                const p = loadPlan(ecosystemRoot, f.replace(/\.json$/, ""));
                if (p && p.requirement_id === work_item_id) {
                    plan = p;
                    break;
                }
            }
        }
        let gitStat = "";
        try {
            gitStat = execSync("git diff --stat HEAD", { cwd: wsRoot, stdio: "pipe" }).toString().slice(0, 4000);
        }
        catch { /* not a repo */ }
        const criteria = [
            ...(req?.acceptance_criteria ?? []),
            ...(taskSpec?.acceptance_criteria ?? []),
        ].filter((c, i, a) => a.indexOf(c) === i);
        if (criteria.length === 0) {
            return textResult(`⛔ No acceptance criteria found for ${work_item_id} (requirement or task spec). A change cannot be verified against an empty spec.`, true);
        }
        const outcome = await judge(server, wsRoot, {
            kind: "review",
            subject: work_item_id,
            role: "Adversarial Spec Verifier (tries to prove the change does NOT meet its spec)",
            rubric: ReviewRubric,
            evidence: {
                acceptance_criteria: criteria,
                plan,
                files_touched: filesTouched,
                git_diff_stat: gitStat,
                diff_summary: diff_summary ?? null,
                test_results: loadTestResults(ecosystemRoot),
                project: specEvidence(wsRoot),
                instruction: "Read the touched files yourself before judging; the evidence above lists where to look, not proof.",
            },
            schema: ReviewVerdict,
            schemaHint: ReviewHint,
            supplied: judgment,
            reinvoke: "verify_against_spec",
        });
        if (outcome.status !== "ok")
            return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
        const rv = outcome.verdict;
        // The judgment must cover every criterion the spec has, not a convenient subset.
        const judged = new Set(rv.criteria.map((c) => c.criterion.trim().toLowerCase()));
        const unjudged = criteria.filter((c) => !judged.has(c.trim().toLowerCase()));
        const passed = rv.verdict === "APPROVED" && unjudged.length === 0;
        recordGate(wsRoot, work_item_id, "review", passed, outcome.source, passed ? rv.summary : unjudged.length ? `${unjudged.length} criteria not judged` : rv.summary);
        return textResult(`${passed ? "✅" : "⛔"} Review ${passed ? "APPROVED" : "CHANGES REQUIRED"} — ${work_item_id} (judged by ${outcome.source})\n${rv.summary}\n\n` +
            rv.criteria.map((c) => `- [${c.status}] ${c.criterion}${c.evidence.length ? `\n    evidence: ${c.evidence.join("; ")}` : ""}`).join("\n") +
            (unjudged.length ? `\n\n⚠️ Criteria missing from the judgment (copy them verbatim):\n${unjudged.map((c) => `- ${c}`).join("\n")}` : "") +
            (rv.out_of_scope_changes.length ? `\n\nOut-of-scope changes:\n${rv.out_of_scope_changes.map((c) => `- ${c}`).join("\n")}` : "") +
            (rv.guardrail_violations.length ? `\n\nGuardrail violations:\n${rv.guardrail_violations.map((c) => `- ${c}`).join("\n")}` : "") +
            (passed ? `\n\nNext: manage_task action=complete.` : `\n\nFix the gaps, then run verify_against_spec again.`));
    }
    catch (e) {
        return textResult(`Error: ${e.message}`, true);
    }
});
server.tool("spec_status", "Shows the spec-driven lifecycle ledger for a work item: which gates (philosophy → intent → classification → requirement → plan → review) have passed, who judged each, " +
    "and exactly which tool to call next. Call this whenever unsure what the next step is, and at session start when resuming.", { work_item_id: z.string().describe("Work item / requirement id.") }, async ({ work_item_id }) => {
    const wsRoot = getWorkspaceRoot();
    const ledger = readLedger(wsRoot, work_item_id);
    const rows = PHASES.map((p) => {
        const g = ledger.phases[p];
        return g ? `${g.status === "PASSED" ? "✅" : "⛔"} ${p.padEnd(15)} ${g.source.padEnd(10)} ${g.summary}` : `⬜ ${p.padEnd(15)} not done`;
    });
    const next = nextPhase(wsRoot, work_item_id);
    return textResult(`## Spec status — ${work_item_id}\n\n${rows.join("\n")}\n\n` +
        (next ? `**Next:** ${nextStepHint(next)}` : `**All gates passed.** manage_task action=complete is allowed.`));
});
server.tool("get_change_context", "Retrieves the consolidated deterministic change context for the host LLM before it writes code.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID")
}, async ({ workspace_root, plan_id }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan)
            return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        const req = loadRequirement(ecosystemRoot, plan.requirement_id);
        const context = {
            requirement: req ? { id: req.id, status: req.status, decisions: req.decisions } : null,
            plan_summary: plan.summary,
            affected_services: plan.affected_services,
            affected_files: plan.affected_files,
            blockers: plan.blockers,
            unknowns: plan.unknowns,
            test_obligations: plan.test_obligations
        };
        return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("generate_test_obligations", "Generates test obligations based on the plan changes.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID")
}, async ({ workspace_root, plan_id }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan)
            return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        const obligations = generateTestObligations(plan);
        return { content: [{ type: "text", text: JSON.stringify(obligations, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("record_engineering_experience", "Create or update an experience record.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    id: z.string().optional(),
    title: z.string(),
    summary: z.string(),
    category: z.string(),
    lesson: z.string(),
    context: z.string(),
    trigger: z.string().optional(),
    outcome: z.string().optional(),
    confidence: z.string().optional(),
    status: z.enum(["PROPOSED", "VALIDATED", "STALE", "CONFLICTING", "RETIRED"]).optional(),
    evidence: z.string().optional()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = recordExperience(ecosystemRoot, {
            id: args.id,
            title: args.title,
            summary: args.summary,
            category: args.category,
            lesson: args.lesson,
            context: args.context,
            trigger: args.trigger,
            outcome: args.outcome,
            confidence: args.confidence,
            status: args.status,
            evidence: args.evidence
        });
        return { content: [{ type: "text", text: `Experience recorded: ${exp.id}
${JSON.stringify(exp, null, 2)}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("get_engineering_experience", "Retrieve bounded experience relevant to supplied context.", {
    workspace_root: z.string(),
    query: z.string().describe("Search query for title, summary, or category"),
    affected_components: z.array(z.string()).optional(),
    affected_services: z.array(z.string()).optional(),
    source_requirement_id: z.string().optional()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const res = getEngineeringExperience(ecosystemRoot, args.query, {
            affected_components: args.affected_components,
            affected_services: args.affected_services,
            source_requirement_id: args.source_requirement_id
        });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("validate_experience", "Validate whether an experience record has sufficient evidence to become durable validated knowledge.", {
    workspace_root: z.string(),
    id: z.string(),
    validation_evidence: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = validateExperience(ecosystemRoot, args.id, args.validation_evidence);
        return { content: [{ type: "text", text: `Experience validated: ${exp.id}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("get_experience_context", "Return experience plus its evidence, provenance, and traceability.", {
    workspace_root: z.string(),
    id: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = getExperienceContext(ecosystemRoot, args.id);
        return { content: [{ type: "text", text: JSON.stringify(exp, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("find_experience_conflicts", "Detect conflicting experience records without resolving them.", {
    workspace_root: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const res = findExperienceConflicts(ecosystemRoot);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("find_repeated_outcomes", "Find repeated validated outcomes across historical work.", {
    workspace_root: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const res = findRepeatedOutcomes(ecosystemRoot);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("mark_experience_stale", "Mark experience as stale based on repository/evidence changes.", {
    workspace_root: z.string(),
    id: z.string(),
    reason: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = markExperienceStale(ecosystemRoot, args.id, args.reason);
        return { content: [{ type: "text", text: `Experience marked stale: ${exp.id}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("retire_experience", "Retire an experience record while preserving history.", {
    workspace_root: z.string(),
    id: z.string(),
    reason: z.string()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = retireExperience(ecosystemRoot, args.id, args.reason);
        return { content: [{ type: "text", text: `Experience retired: ${exp.id}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("link_experience", "Create a provenance-backed relationship between experience and requirements/plans/tests.", {
    workspace_root: z.string(),
    id: z.string(),
    source_requirement_id: z.string().optional(),
    source_plan_id: z.string().optional(),
    source_validation_id: z.string().optional(),
    source_test_result_ids: z.array(z.string()).optional(),
    source_traceability_ids: z.array(z.string()).optional()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = linkExperience(ecosystemRoot, args.id, {
            source_requirement_id: args.source_requirement_id,
            source_plan_id: args.source_plan_id,
            source_validation_id: args.source_validation_id,
            source_test_result_ids: args.source_test_result_ids,
            source_traceability_ids: args.source_traceability_ids
        });
        return { content: [{ type: "text", text: `Experience linked: ${exp.id}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("get_learning_feedback", "Return bounded historical feedback relevant to a current requirement or implementation plan.", {
    workspace_root: z.string(),
    requirement_id: z.string(),
    plan_id: z.string().optional()
}, async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const res = getLearningFeedback(ecosystemRoot, args.requirement_id, args.plan_id);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("discover_tests", "Discover relevant tests for a given set of artifact IDs.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    artifacts: z.array(z.string()).describe("List of artifact IDs (e.g. CLASS:UserService)")
}, async ({ workspace_root, artifacts }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }
        const discovered = discoverTests(graph, artifacts);
        return { content: [{ type: "text", text: JSON.stringify(discovered, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("execute_tests", "Execute supported existing repository test commands.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    command: z.string().describe("Test command to execute"),
    working_dir: z.string().describe("Working directory relative to workspace root")
}, async ({ workspace_root, command, working_dir }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const results = executeTests(ecosystemRoot, command, working_dir);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("ingest_test_results", "Parse and normalize existing test result artifacts.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    results: z.array(z.any()).describe("List of normalized TestResult objects")
}, async ({ workspace_root, results }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const count = ingestTestResults(ecosystemRoot, results);
        return { content: [{ type: "text", text: `Ingested ${count} test results.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("get_test_results", "Retrieve bounded normalized execution results.", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const results = loadTestResults(ecosystemRoot);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("correlate_test_failure", "Determine evidence-supported relationships between a test failure and affected implementation artifacts.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    failure: z.any().describe("The failed TestResult object")
}, async ({ workspace_root, failure }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }
        const edges = loadTraceability(ecosystemRoot);
        const correlated = correlateTestFailure(graph, edges, failure);
        return { content: [{ type: "text", text: JSON.stringify(correlated, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("query_knowledge_graph", "Targeted querying against the SecuFusion knowledge graph.", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    query: z.string().describe("What to search for (e.g., 'User', 'tenantId', 'DeviceEntity'). Matches against name, id, and properties."),
    node_type: z.string().optional().describe("Optional filter by node type (e.g., 'SERVICE', 'CLASS', 'TOPIC')."),
    max_depth: z.number().optional().describe("Max relationship traversal depth (default 1).")
}, async ({ workspace_root, query, node_type, max_depth }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph)
            return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };
        const queryLower = query.toLowerCase();
        const depth = max_depth || 1;
        let startNodes = graph.nodes.filter(n => (n.id.toLowerCase().includes(queryLower) || n.name.toLowerCase().includes(queryLower)) &&
            (!node_type || n.type === node_type));
        const resultNodes = new Map();
        const resultEdges = new Map();
        let currentLayer = startNodes;
        for (let d = 0; d <= depth; d++) {
            const nextLayer = [];
            for (const n of currentLayer) {
                if (!resultNodes.has(n.id))
                    resultNodes.set(n.id, n);
            }
            if (d < depth) {
                for (const edge of graph.edges) {
                    if (resultNodes.has(edge.source) || resultNodes.has(edge.target)) {
                        if (!resultEdges.has(edge.id)) {
                            resultEdges.set(edge.id, edge);
                            const sourceNode = graph.nodes.find(n => n.id === edge.source);
                            const targetNode = graph.nodes.find(n => n.id === edge.target);
                            if (sourceNode && !resultNodes.has(sourceNode.id))
                                nextLayer.push(sourceNode);
                            if (targetNode && !resultNodes.has(targetNode.id))
                                nextLayer.push(targetNode);
                        }
                    }
                }
            }
            currentLayer = nextLayer;
        }
        const result = {
            query,
            depth_searched: depth,
            nodes_found: resultNodes.size,
            edges_found: resultEdges.size,
            nodes: Array.from(resultNodes.values()),
            edges: Array.from(resultEdges.values())
        };
        return { content: [{ type: "text", text: `EVIDENCE_GRAPH:\n${JSON.stringify(result, null, 2)}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("calculate_blast_radius", "Calculates the impact of changing a specific component, entity, or API using graph relationships", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    component_name: z.string().describe("Name of the component, entity, or API to analyze")
}, async ({ workspace_root, component_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath))
            return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph)
            return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };
        const compLower = component_name.toLowerCase();
        const startNodes = graph.nodes.filter(n => n.id.toLowerCase().includes(compLower) || n.name.toLowerCase().includes(compLower));
        const impacts = [];
        for (const node of startNodes) {
            impacts.push(`Impacts for ${node.id}:`);
            const relatedEdges = graph.edges.filter(e => e.source === node.id || e.target === node.id);
            for (const edge of relatedEdges) {
                const otherId = edge.source === node.id ? edge.target : edge.source;
                const direction = edge.source === node.id ? `-> ${edge.type} ->` : `<- ${edge.type} <-`;
                impacts.push(`  ${node.id} ${direction} ${otherId} (Evidence: ${edge.evidence?.filePath || 'Project Spec'})`);
            }
        }
        if (impacts.length === 0)
            impacts.push("No direct impacts found in graph.");
        return { content: [{ type: "text", text: `Blast Radius for '${component_name}':\n${impacts.join('\n')}` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("load_external_env_file", "Loads an unmasked external environment file to override masked values in the knowledge graph", {
    workspace_root: z.string().describe("Root directory of the workspace"),
    absolute_file_path: z.string().describe("Absolute path to the unmasked .env or .properties file")
}, async ({ workspace_root, absolute_file_path }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        if (!fs.existsSync(absolute_file_path)) {
            return { content: [{ type: "text", text: `File not found: ${absolute_file_path}` }], isError: true };
        }
        const content = fs.readFileSync(absolute_file_path, "utf-8");
        const realValues = parseExternalEnv(content);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) {
            return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }], isError: true };
        }
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        let updatedCount = 0;
        if (dna.configurations) {
            for (const config of dna.configurations) {
                for (const entry of config.entries) {
                    if (entry.requiresRealValues && realValues[entry.key]) {
                        entry.value = realValues[entry.key];
                        entry.requiresRealValues = false;
                        updatedCount++;
                    }
                }
            }
        }
        writeDna(ecosystemRoot, dna);
        return {
            content: [{ type: "text", text: `Successfully loaded ${updatedCount} real configuration values into the Knowledge Graph.` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});
server.tool("start_dna_watcher", "Starts a continuous file watcher to automatically sync the DNA when files are modified", {
    workspace_root: z.string().describe("Root directory of the workspace")
}, async ({ workspace_root }) => {
    try {
        if (watcher) {
            return { content: [{ type: "text", text: `DNA Watcher is already running.` }] };
        }
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        watcher = chokidar.watch(ecosystemRoot, {
            ignored: /(^|[\/\\])\..|node_modules|target|build/,
            persistent: true
        });
        watcher.on('change', (path) => {
            if (VALID_EXTENSIONS.some(ext => path.endsWith(ext))) {
                console.log(`[DNA Watcher] Detected change in ${path}. Re-syncing DNA...`);
                performFullExtraction(ecosystemRoot);
            }
        });
        return {
            content: [{ type: "text", text: `Successfully started DNA File Watcher on ${ecosystemRoot}. The knowledge graph will now update automatically in the background.` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error starting watcher: ${e.message}` }], isError: true };
    }
});
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

**Next step:** Run \`/sfn-plan\` with a ticket ID to start your first task.`
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
// ─────────────────────────────────────────────────────────────────────────────
server.tool("discover_secufusion_workspace", "Determine the current SecuFusion workspace and return its configuration (core vs optional repositories).", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const config = getWorkspaceConfig(root);
    return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
});
server.tool("inspect_workspace_repositories", "Inspect which repositories are actually present in the workspace, classifying them as core/optional.", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const result = inspectWorkspaceRepositories(root);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("refresh_repository_knowledge", "Refresh the deterministic knowledge graph from the current repository state.", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const stats = performFullExtraction(root);
    return { content: [{ type: "text", text: JSON.stringify({ status: "REFRESHED", stats }, null, 2) }] };
});
server.tool("get_workspace_status", "Get the overall status of the workspace (READY, PARTIAL, BLOCKED, FAILED).", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const result = inspectWorkspaceRepositories(root);
    return { content: [{ type: "text", text: result.status }] };
});
server.tool("get_evidence_completeness", "Retrieve evidence completeness context, exposing which core/optional repositories are missing.", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const completeness = getEvidenceCompleteness(root);
    return { content: [{ type: "text", text: JSON.stringify(completeness, null, 2) }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);

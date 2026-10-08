// @ts-nocheck
/** Shared constants and helpers used by every tool group. */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { buildGraph } from "./graph_builder.js";
import { parseDomainModels } from "./parsers/domain.js";
import { parseApiEndpoints } from "./parsers/api.js";
import { parseEventTopics } from "./parsers/events.js";
import { inferPatterns } from "./parsers/patterns.js";
import { parseFrontend } from "./parsers/frontend.js";
import { inspectWorkspaceRepositories } from "./workspace_intelligence.js";
import { parseExtension } from "./parsers/extension.js";
import { parseNodeApis } from "./parsers/backend-node.js";
import { parseInfra } from "./parsers/infra.js";
import { parseDatabase } from "./parsers/database.js";
import { parseSecurity } from "./parsers/security.js";
import { parseConfig } from "./parsers/config.js";
import { sameTicket, folderMatches, folderName, findRegistryConflict, identityConflictMessage } from "./work_item_ref.js";
// ─────────────────────────────────────────────
//  Constants / helpers
// ─────────────────────────────────────────────
export const STATE_FILE = ".secufusion-state.json";
export const REJECTED_FILE = ".rejected-patterns.json";
export const TOKEN_FILE = ".secufusion-tokens.json";
export const argv = process.argv.slice(2);
export const rootFlag = argv.indexOf('--root');
export const ROOT = rootFlag !== -1
    ? path.resolve(argv[rootFlag + 1] ?? '.')
    : process.cwd();
/** Find the workspace root by walking up from cwd to find a project marker. */
export function getWorkspaceRoot() {
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
export function resolve(file) {
    return path.resolve(getWorkspaceRoot(), file);
}
export function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
export function readJson(filePath) {
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
export function loadProjectSpec(wsRoot) {
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
export function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
}
export function getCurrentBranch(cwd) {
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
export function loadMigrationSpec(wsRoot) {
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
export function getMigrationContextForService(migrationSpec, serviceName) {
    if (!migrationSpec)
        return null;
    const services = migrationSpec.services ?? {};
    if (services[serviceName])
        return services[serviceName];
    const key = Object.keys(services).find(k => k.includes(serviceName) || serviceName.includes(k.replace("sfn-", "").replace("-api", "")));
    return key ? services[key] : null;
}
/** Return the next suggested migration filename (e.g. "V40__{description}.sql"). */
export function getNextMigrationVersion(migrationSpec, serviceName) {
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
export function getMigrationGaps(migrationSpec, serviceName) {
    const ctx = getMigrationContextForService(migrationSpec, serviceName);
    return ctx?.organization?.version_gaps ?? [];
}
/** Recursively find files whose name ends with the given suffix. */
export function findFilesRecursive(dir, suffix) {
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
export function compressCode(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
        .replace(/\/\/.*$/gm, "") // Remove single-line comments
        .replace(/^\s*[\r\n]/gm, "") // Remove empty lines
        .replace(/[ \t]+$/gm, ""); // Remove trailing whitespace
}
export function appendTelemetry(response, inputChars) {
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
export function specEvidence(wsRoot) {
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
export function textResult(text, isError = false) {
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}
// ─── Business Intent Layer ────────────────────────────────────────────────────
//  Bridges the Polyglot Flexibility & Business Intent gaps.
//  Every work item gets BOTH:
//    - A JSON task folder  (.secufusion/tasks/WI-XXXX/)  → code truth (AST-driven)
//    - A Markdown intent file (.secufusion/intents/WI-XXXX.md) → why truth (human-driven)
//  prime_session merges both into a single context block.
// ─────────────────────────────────────────────────────────────────────────────
export const INTENTS_DIR = ".secufusion/intents";
export const TASKS_DIR = ".secufusion/tasks";
export const CLASSIFICATIONS_DIR = ".secufusion/classifications";
export const REGISTRY_FILE = ".secufusion/registry.json";
export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[:\s]+/g, "-")
        .replace(/[^a-z0-9-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
}
export function nextIntentNumber() {
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
export function parseIntentFrontmatter(raw) {
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
export function resolveTaskFolder(workItemId, tasksRoot, registryData) {
    const registry = registryData || readRegistry();
    const entry = registry.find(t => t["work_item_id"] === workItemId)
        ?? registry.find(t => sameTicket(String(t["work_item_id"] ?? ""), workItemId));
    // 1. Registry first
    if (entry && entry["folder"]) {
        const folderPath = path.join(tasksRoot, entry["folder"]);
        if (fs.existsSync(folderPath))
            return folderPath;
    }
    // 2. Scan: case-insensitive, and tolerant of folders written by older versions (Task-1230-, Bug-1230-)
    if (fs.existsSync(tasksRoot)) {
        const match = fs.readdirSync(tasksRoot).find(f => folderMatches(f, workItemId));
        if (match)
            return path.join(tasksRoot, match);
    }
    // 3. Not found
    return null;
}
/**
 * Folder for a new task. The ticket's own type prefix is kept verbatim (BUG-1230 -> BUG-1230-title).
 * It is never replaced by a default ("Task") and never overridden by the classification's task_type,
 * which describes the kind of work, not the ticket's identity.
 */
export function generateNewTaskFolder(workItemId, title, tasksRoot) {
    const conflict = findRegistryConflict(readRegistry(), workItemId);
    if (conflict)
        throw new Error(identityConflictMessage(workItemId, conflict));
    return path.join(tasksRoot, folderName(workItemId, title));
}
export function readRegistry() {
    return readJson(resolve(REGISTRY_FILE)) || [];
}
export function writeRegistry(records) {
    writeFile(resolve(REGISTRY_FILE), JSON.stringify(records, null, 2));
}
export function upsertRegistry(entry) {
    const records = readRegistry();
    const idx = records.findIndex(r => r["work_item_id"] === entry["work_item_id"]);
    if (idx === -1)
        records.push(entry);
    else
        records[idx] = { ...records[idx], ...entry };
    writeRegistry(records);
}
export const STOP_WORDS = new Set([
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
export function extractSymptomWords(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !STOP_WORDS.has(w))
        .filter(w => !/^\d+$/.test(w));
}
export function levenshteinClose(a, b, threshold = 2) {
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
export function buildScopeText(signals, domain) {
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
export function getEcosystemRoot(workspaceRoot) {
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
export const getDnaPath = (ecosystemRoot) => path.join(ecosystemRoot, ".secufusion", "dna.json");
export function ensureDnaFile(ecosystemRoot) {
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
export function readDna(ecosystemRoot) {
    ensureDnaFile(ecosystemRoot);
    return JSON.parse(fs.readFileSync(getDnaPath(ecosystemRoot), "utf-8"));
}
export function writeDna(ecosystemRoot, dna) {
    fs.writeFileSync(getDnaPath(ecosystemRoot), JSON.stringify(dna, null, 2));
}
export const VALID_EXTENSIONS = ['.java', '.ts', '.js', '.tsx', '.jsx', '.vue', '.sql', '.prisma', '.tf', '.yaml', '.yml', '.env', '.env.example', '.env.local', '.properties', '.json'];
export function getAllSourceFiles(dirPath, repoName, arrayOfFiles = []) {
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
export function getPolyRepoSourceFiles(ecosystemRoot) {
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
export function generateMigrationSpec(ecosystemRoot) {
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

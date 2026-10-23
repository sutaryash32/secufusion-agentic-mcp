import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { checkAppliedMigrations } from "./migration_guard.js";
import { Finding, Severity, assignIds, sortFindings, gateDecision } from "./review_findings.js";

/**
 * Quick check: the mechanical half of the rule catalog, with no model, in about a second.
 *
 * It looks at what a change ADDS and at the files it touches, and reports only what a pattern can
 * establish. Exact things (a reused migration version, a literal credential) are `confirmed`;
 * pattern leads are `possible`, so the review that follows decides. It is built to run on every push,
 * and CI uses the same function, so a developer sees locally what the pipeline will see.
 */

/** `git diff -U0` -> { file: [{ line, text }] } for ADDED lines, with new-file line numbers. */
export function parseAddedLines(diff: string): Record<string, Array<{ line: number; text: string }>> {
    const out: Record<string, Array<{ line: number; text: string }>> = {};
    let file: string | undefined;
    let line = 0;
    for (const raw of diff.split(/\r?\n/)) {
        const f = raw.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/);
        if (f) { file = f[1]; continue; }
        if (raw.startsWith("--- ")) continue;
        const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) { line = Number(h[1]); continue; }
        if (!file) continue;
        if (raw.startsWith("+")) { (out[file] ??= []).push({ line, text: raw.slice(1) }); line++; }
        else if (!raw.startsWith("-") && !raw.startsWith("\\")) line++;
    }
    return out;
}

export interface QuickCtx {
    repoKey: string;
    stack: "java-spring" | "react-vite" | "unknown";
    changedFiles: Array<{ path: string; status: string }>;
    added: Record<string, Array<{ line: number; text: string }>>;
    read: (p: string) => string;
    /** MutatingEndpointAllowlist.java content at head, when the repo has one. */
    allowlist?: string;
    /** True when any existing migration, here or in a sibling repo sharing the database, already mentions the column. */
    columnKnownElsewhere?: (column: string) => boolean;
    migrationsDir?: string;
}

const base = (o: Partial<Finding> & Pick<Finding, "ruleId" | "severity" | "file" | "line" | "anchor" | "title" | "problem" | "failureScenario" | "suggestion">): Finding => ({
    confidence: "possible", specialist: "quick-check", category: "general", ...o, title: o.title.slice(0, 140),
});

const isTestFile = (f: string) => /(^|\/)(src\/test\/|__tests__\/|tests?\/)|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.java$/.test(f);

export function quickCheck(ctx: QuickCtx): Finding[] {
    const out: Finding[] = [];
    const { changedFiles, added, read } = ctx;
    const java = ctx.stack === "java-spring";
    const web = ctx.stack === "react-vite";
    const migDir = ctx.migrationsDir ?? "src/main/resources/db/migration";

    // A column mapped by an entity with no migration in the change that mentions it (ddl-auto is none).
    if (java) {
        const migText = changedFiles.filter((f) => f.status !== "D" && f.path.startsWith(`${migDir}/`)).map((f) => read(f.path).toLowerCase()).join("\n");
        for (const [file, lines] of Object.entries(added)) {
            if (!/\/entity\/.+\.java$/.test(file)) continue;
            for (const l of lines) {
                const m = l.text.match(/@Column\s*\(\s*[^)]*name\s*=\s*"([A-Za-z0-9_]+)"/);
                if (m && !migText.includes(m[1].toLowerCase()) && !ctx.columnKnownElsewhere?.(m[1])) {
                    out.push(base({ ruleId: "DB-001", severity: "blocker", category: "db", file, line: l.line, anchor: `${path.basename(file, ".java")}#${m[1]}`,
                        title: `Column ${m[1]} is mapped but no migration in this change creates it`,
                        problem: `A new @Column(name = "${m[1]}") was added and no migration in the change mentions ${m[1]}. ddl-auto is none.`,
                        failureScenario: `After deploy every query on this entity selects ${m[1]} and fails until the column exists.`,
                        suggestion: "Add V<next>__*.sql creating the column, or confirm it already exists in every environment." }));
                }
            }
        }
    }

    // Line-level checks on added code.
    for (const [file, lines] of Object.entries(added)) {
        const test = isTestFile(file);
        const sql = file.endsWith(".sql");
        const pom = /(^|\/)pom\.xml$/.test(file);
        const pkg = /(^|\/)package\.json$/.test(file);
        const docker = /(^|\/)Dockerfile[^/]*$/.test(file);
        const pipeline = /(azure-pipelines|\.azure-pipelines|(^|\/)pipelines?\/|\.github\/workflows\/|ci\/).*\.ya?ml$/.test(file) || /(^|\/)azure-pipelines[\w.-]*\.ya?ml$/.test(file);
        for (const l of lines) {
            const t = l.text;
            if (!test && (/(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,})/.test(t)
                || (/\b(password|passwd|secret|api[._-]?key|client[._-]?secret|access[._-]?key|private[._-]?key|token)\b\s*[=:]\s*["']?[^\s"'${}<>]{8,}/i.test(t) && !/\$\{|<|example|changeme|dummy|test/i.test(t)))) {
                out.push(base({ ruleId: "SEC-008", severity: "blocker", confidence: "confirmed", category: "security", file, line: l.line, anchor: `${file}#secret@${l.line}`,
                    title: "A credential appears to be committed", problem: "An added line contains what looks like a literal secret.",
                    failureScenario: "Anyone with repo access (and every clone, backup and pipeline log) has the credential.",
                    suggestion: "Remove it, rotate the credential, and read it from the external properties file or a variable group." }));
            }
            if (/authz\.scope-coverage\.enforce\s*[=:]\s*false/.test(t)) {
                out.push(base({ ruleId: "SEC-007", severity: "major", confidence: "confirmed", category: "security", file, line: l.line, anchor: "authz.scope-coverage.enforce",
                    title: "Scope-coverage enforcement turned off", problem: "authz.scope-coverage.enforce=false puts the mutating-endpoint gate in shadow mode.",
                    failureScenario: "An unclassified mutating endpoint ships without a scope check and is reachable by any authenticated user.", suggestion: "Keep enforce=true outside local profiles." }));
            }
            const flag = t.match(/\$\{([A-Z0-9_]*(ENABLED|ENABLE|FEATURE)[A-Z0-9_]*):true\}/);
            if (flag) {
                out.push(base({ ruleId: "SEC-016", severity: "major", category: "security", file, line: l.line, anchor: flag[1],
                    title: `New flag ${flag[1]} defaults to on`, problem: "A feature flag is added with default true.",
                    failureScenario: "Every environment gets the feature on deploy, before anyone opts in.", suggestion: `Default it off: \${${flag[1]}:false}.` }));
            }
            if (!test && /\b(log|logger|LOG|console)\s*\.\s*(info|warn|error|log)\s*\(.*\b(password|passwd|authorization|bearer|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\b/i.test(t) && !/mask|redact|\*\*\*/i.test(t)) {
                out.push(base({ ruleId: "SEC-009", severity: "major", category: "security", file, line: l.line, anchor: `${file}#log@${l.line}`,
                    title: "A log line may write a credential", problem: "A log statement at info level or above mentions a token, password or Authorization value.",
                    failureScenario: "The value lands in log storage, readable by everyone with log access.", suggestion: "Log the fact (token refreshed for tenant X), never the value." }));
            }
            if (java && !test && /(createNativeQuery|createQuery|jdbcTemplate\.\w+|\.queryForObject|\.execute)\s*\(\s*("[^"]*"\s*\+|[A-Za-z_]\w*\s*\+\s*")/.test(t)) {
                out.push(base({ ruleId: "SEC-010", severity: "blocker", category: "security", file, line: l.line, anchor: `${file}#sqlconcat@${l.line}`,
                    title: "SQL built by string concatenation", problem: "A query string is joined with a variable instead of using bind parameters.",
                    failureScenario: "A request value containing a quote changes the query: injection, or another tenant's rows.", suggestion: "Use named or positional bind parameters." }));
            }
            if (java && /lb:\/\/|@LoadBalanced/.test(t)) {
                out.push(base({ ruleId: "RUN-005", severity: "major", confidence: "confirmed", category: "runtime", file, line: l.line, anchor: `${file}#lb`,
                    title: "Peer call through Eureka load balancing", problem: "`lb://` / @LoadBalanced relies on Eureka, which is disabled in practice.",
                    failureScenario: "The call fails to resolve the service in every environment.", suggestion: "Call the peer by its gateway URL." }));
            }
            if (java && !test && /@Async\b/.test(t)) {
                out.push(base({ ruleId: "RUN-004", severity: "major", category: "runtime", file, line: l.line, anchor: `${file}#async@${l.line}`,
                    title: "@Async work: security and tenant context do not follow", problem: "@Async runs on another thread; the security context, tenant context and transaction are not propagated.",
                    failureScenario: "The task reads a null acting tenant, or writes outside a transaction.", suggestion: "Pass the tenant id explicitly and open the transaction inside the task." }));
            }
            if (ctx.repoKey === "sfn-events-api" && !test && !sql && /(\bDELETE\s+FROM\b|\.delete(All|ById|AllById|AllInBatch)?\s*\()/i.test(t)) {
                const anchor = `${path.basename(file)}#hard-delete`;
                const prev = out.find((f) => f.anchor === anchor);
                if (prev) { prev.evidence!.push({ file, line: l.line, note: t.trim().slice(0, 120) }); prev.title = `${prev.evidence!.length} hard deletes in ${path.basename(file)} (soft-delete repo)`; }
                else out.push(base({ ruleId: "DB-007", severity: "major", category: "db", file, line: l.line, anchor,
                    title: "Hard delete in sfn-events-api (soft-delete repo)", problem: "sfn-events-api soft-deletes by status; this file adds hard deletes.",
                    failureScenario: "Rows other code expects to remain disappear; FK-linked rows (incident_events) can make the delete fail mid-batch.",
                    suggestion: "Use the status flag, or document why this table is the exception and delete children first.", evidence: [{ file, line: l.line, note: t.trim().slice(0, 120) }] }));
            }
            if (sql && /\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b/i.test(t) && !/\bDEFAULT\b/i.test(t)) {
                out.push(base({ ruleId: "DB-008", severity: "major", category: "db", file, line: l.line, anchor: `${path.basename(file)}#notnull@${l.line}`,
                    title: "NOT NULL column added with no default", problem: "ADD COLUMN ... NOT NULL without a DEFAULT fails on a table that already has rows.",
                    failureScenario: "The migration aborts on the first environment that has data, halfway through the deployment.", suggestion: "Add the column nullable, backfill in batches, then set NOT NULL; or give it a default." }));
            }
            if (sql && /^\s*CREATE\s+INDEX\b(?!\s+CONCURRENTLY)/i.test(t)) {
                out.push(base({ ruleId: "DB-008", severity: "minor", category: "db", file, line: l.line, anchor: `${path.basename(file)}#index@${l.line}`,
                    title: "Index created without CONCURRENTLY", problem: "A plain CREATE INDEX locks writes on the table while it builds.",
                    failureScenario: "On a hot table (events, event_inbox, devices) writes stall for the duration of the build.", suggestion: "Use CREATE INDEX CONCURRENTLY, outside a transaction block, if the table is large." }));
            }
            if (sql && /\bDROP\s+(TABLE|COLUMN)\b/i.test(t)) {
                out.push(base({ ruleId: "DB-008", severity: "major", category: "db", file, line: l.line, anchor: `${path.basename(file)}#drop@${l.line}`,
                    title: "Destructive DROP in a migration", problem: "A table or column is dropped; applied migrations cannot be undone by editing them.",
                    failureScenario: "A rollback of the application finds the data gone.", suggestion: "State the backup and rollback plan in the PR, and drop only after the code no longer reads it." }));
            }
            if ((pom || pkg) && /(\bLATEST\b|\bRELEASE\b|["'>]\*["'<]|-SNAPSHOT|git\+|github:|"\s*:\s*"(\^|~|>=)?x")/.test(t) && /version|["'][\w@/.-]+["']\s*:/.test(t)) {
                out.push(base({ ruleId: "DEP-004", severity: "minor", category: "deps", file, line: l.line, anchor: `${file}#float@${l.line}`,
                    title: "Floating or snapshot dependency version", problem: "A version that is not pinned (LATEST, RELEASE, *, x, a git URL or -SNAPSHOT) was added.",
                    failureScenario: "Two builds of the same commit install different code.", suggestion: "Pin an exact released version." }));
            }
            if (docker && /^\s*FROM\s+(?!scratch)[^\s:@]+(:latest)?\s*(AS\s+\w+)?\s*$/i.test(t)) {
                out.push(base({ ruleId: "DEP-006", severity: "major", category: "deps", file, line: l.line, anchor: `${file}#from@${l.line}`,
                    title: "Dockerfile base image not pinned", problem: "FROM uses :latest or no tag.", failureScenario: "The image under the service changes without any commit.", suggestion: "Pin a version tag, or a digest." }));
            }
            if (docker && /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(t)) {
                out.push(base({ ruleId: "DEP-006", severity: "major", category: "deps", file, line: l.line, anchor: `${file}#pipe-sh@${l.line}`,
                    title: "Dockerfile pipes a download into a shell", problem: "curl | sh runs whatever the server returns at build time.", failureScenario: "A compromised or changed download runs inside the image build.", suggestion: "Download, verify a checksum, then run." }));
            }
            if (docker && /^\s*(ARG|ENV)\s+\w*(PASSWORD|SECRET|TOKEN|API_?KEY)\w*\s*=?\s*\S+/i.test(t)) {
                out.push(base({ ruleId: "DEP-006", severity: "major", category: "deps", file, line: l.line, anchor: `${file}#secret-arg@${l.line}`,
                    title: "Secret passed as ARG/ENV in a Dockerfile", problem: "Build args and env values are stored in the image layers.", failureScenario: "Anyone who can pull the image can read the secret.", suggestion: "Mount the secret at build time or inject it at run time." }));
            }
            if (pipeline && /(-DskipTests|-Dmaven\.test\.skip|continueOnError:\s*true|--no-verify|skip[-_]?tests:\s*true)/i.test(t)) {
                out.push(base({ ruleId: "DEP-007", severity: "major", category: "deps", file, line: l.line, anchor: `${file}#skip@${l.line}`,
                    title: "Pipeline step skips tests or ignores failure", problem: "A step disables tests or lets a failure pass.", failureScenario: "A red build looks green; broken code reaches the release branch.", suggestion: "Keep the gate failing; fix or quarantine the test instead." }));
            }
            if (test && java && /assertTrue\s*\(\s*true\s*\)|assertEquals\s*\(\s*(\w+)\s*,\s*\1\s*\)|@Disabled\s*$/.test(t)) {
                out.push(base({ ruleId: "TST-004", severity: "major", category: "tests", file, line: l.line, anchor: `${file}#cannotfail@${l.line}`,
                    title: "A test that cannot fail", problem: "The added test asserts something that is always true, or is disabled with no reason.", failureScenario: "It stays green while the behaviour breaks.", suggestion: "Assert on the real result, or give @Disabled a reason and a ticket." }));
            }
            if (test && /Thread\.sleep\s*\(|setTimeout\s*\(\s*[^,]+,\s*\d{3,}/.test(t)) {
                out.push(base({ ruleId: "TST-006", severity: "minor", category: "tests", file, line: l.line, anchor: `${file}#sleep@${l.line}`,
                    title: "Test waits on the clock", problem: "A fixed sleep makes the test slow and flaky.", failureScenario: "It fails on a slow CI agent, or passes without checking anything.", suggestion: "Wait for the condition (Awaitility, fake timers, an injected clock)." }));
            }
            if (web && !test && /dangerouslySetInnerHTML|window\.open\s*\([^)]*\)(?!.*noopener)/.test(t)) {
                out.push(base({ ruleId: "WEB-009", severity: "minor", category: "webui", file, line: l.line, anchor: `${file}#html@${l.line}`,
                    title: "Raw HTML or window.open without noopener", problem: "Markup built from data, or a new window that keeps a handle to this page.", failureScenario: "If any part is user-controlled, script runs in the app's session.", suggestion: "Render as text; pass 'noopener,noreferrer' to window.open." }));
            }
            if (web && !test && /^src\//.test(file)) {
                if (/import\s+axios\s+from\s+['"]axios['"]/.test(t) && !file.endsWith("utils/axiosConfig.js")) {
                    out.push(base({ ruleId: "CON-007", severity: "major", confidence: "confirmed", category: "contracts", file, line: l.line, anchor: `${file}#axios`,
                        title: "axios imported directly instead of axiosConfig", problem: "Direct axios bypasses the shared client: token refresh, tenant headers and the error handling.",
                        failureScenario: "Calls fail with 401 after token expiry, or go out without the acting-tenant header.", suggestion: "import apiClient from '../utils/axiosConfig' instead." }));
                }
                if (/['"`]\/api\/(tenants|iam|events)\//.test(t) && !file.endsWith("utils/apiEndpoints.js")) {
                    out.push(base({ ruleId: "CON-007", severity: "minor", category: "contracts", file, line: l.line, anchor: `${file}#url@${l.line}`,
                        title: "API URL inlined outside apiEndpoints.js", problem: "URLs live only in src/utils/apiEndpoints.js.", failureScenario: "A backend path change is updated in apiEndpoints.js but not here.", suggestion: "Add the URL to apiEndpoints.js and use it." }));
                }
                if (/currentUser\??\.tenantId/.test(t)) {
                    out.push(base({ ruleId: "SEC-014", severity: "major", category: "security", file, line: l.line, anchor: `${file}#currentUser.tenantId`,
                        title: "Tenant id from currentUser instead of the acting tenant", problem: 'currentUser.tenantId ignores MSSP "Open as me" impersonation.',
                        failureScenario: "An MSSP operator acting as tenant B sees or writes their own tenant A data.", suggestion: "Use useEffectiveTenantId() / selectActingTenantId." }));
                }
                if (/localStorage\.(setItem|getItem)\s*\(\s*['"][^'"]*(token|jwt)/i.test(t) && !file.endsWith("utils/axiosConfig.js")) {
                    out.push(base({ ruleId: "SEC-015", severity: "major", category: "security", file, line: l.line, anchor: `${file}#token-storage@${l.line}`,
                        title: "Token handled outside axiosConfig", problem: "A token is stored or read from localStorage in app code.", failureScenario: "A second refresh flow drifts from the real one; the token is readable by any script on the page.", suggestion: "Keep token handling in axiosConfig.js." }));
                }
            }
        }
    }

    // Mutating endpoints without a scope check.
    if (java) {
        const allow = ctx.allowlist ?? "";
        for (const [file, lines] of Object.entries(added)) {
            if (!/\/controller\/.+\.java$/.test(file)) continue;
            const src = read(file).split("\n");
            const classIdx = src.findIndex((x) => /\bclass\s+\w+/.test(x));
            const classPreAuth = /@PreAuthorize/.test(src.slice(0, classIdx + 1).join("\n"));
            for (const l of lines) {
                const m = l.text.match(/@(Post|Put|Patch|Delete)Mapping\b/);
                if (!m || classPreAuth) continue;
                const block: string[] = [];
                for (let i = l.line - 2; i >= 0 && /^\s*(@|\/\/|\*|\/\*|\)|[\w"{},.=: ]+[,)]?\s*$)/.test(src[i] ?? "") && !/[;}]\s*$/.test(src[i] ?? ""); i--) block.push(src[i]);
                let sig = "";
                for (let j = l.line - 1; j < Math.min(src.length, l.line + 80); j++) {
                    if (/^\s*(public|protected|private)\b[^=;]*\(/.test(src[j])) { sig = src[j]; break; }
                    block.push(src[j]);
                }
                const method = sig.match(/\b(\w+)\s*\(/)?.[1];
                const cls = path.basename(file, ".java");
                if (block.some((b) => /@PreAuthorize/.test(b)) || (method && allow.includes(`${cls}#${method}`))) continue;
                out.push(base({ ruleId: "SEC-001", severity: "blocker", category: "security", file, line: l.line, anchor: `${cls}#${method ?? `line${l.line}`}`,
                    title: `New ${m[1].toUpperCase()} endpoint ${cls}#${method ?? "?"} has no @PreAuthorize`,
                    problem: "A mutating handler without @PreAuthorize (and not allowlisted) is denied by EndpointScopeCoverageInterceptor, or, if enforcement is off, reachable without a scope.",
                    failureScenario: "Enforced: every call gets 403 UNCLASSIFIED_ENDPOINT. Shadow mode: any authenticated user can call it.",
                    suggestion: "Add @PreAuthorize with the right scope, or a justified MutatingEndpointAllowlist entry." }));
            }
        }
    }

    // Manifest and lockfile out of step.
    const touched = new Set(changedFiles.map((f) => f.path));
    for (const f of changedFiles) {
        if (/(^|\/)package\.json$/.test(f.path) && f.status !== "D") {
            const lock = f.path.replace(/package\.json$/, "package-lock.json");
            if (!touched.has(lock) && /"(dependencies|devDependencies)"/.test(read(f.path)) && (added[f.path] ?? []).some((l) => /"[\w@/.-]+"\s*:\s*"[~^]?\d/.test(l.text))) {
                out.push(base({ ruleId: "DEP-005", severity: "minor", confidence: "confirmed", category: "deps", file: f.path, line: 1, anchor: f.path,
                    title: "package.json changed without package-lock.json", problem: "A dependency line changed and the lockfile did not.", failureScenario: "CI installs something different from what was tested.", suggestion: "Run npm install and commit the lockfile." }));
            }
        }
        if (web && f.status === "A" && /\.(test|spec)\.[jt]sx?$/.test(f.path) && !f.path.startsWith("src/__tests__/")) {
            out.push(base({ ruleId: "TST-008", severity: "minor", confidence: "confirmed", category: "tests", file: f.path, line: 1, anchor: f.path,
                title: "Test file outside src/__tests__ will not run", problem: "Vitest is configured to run tests only from src/__tests__/.", failureScenario: "The test never runs in CI, so it protects nothing.", suggestion: "Move it under src/__tests__/." }));
        }
    }
    return out;
}

// ---- gathering the context from git -------------------------------------------------------------

const git = (root: string, args: string[]): string => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

export function detectStack(root: string): QuickCtx["stack"] {
    if (["pom.xml", "build.gradle", "build.gradle.kts"].some((f) => fs.existsSync(path.join(root, f)))) return "java-spring";
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.vite) return "react-vite";
    } catch { /* not a node project */ }
    return "unknown";
}

export function defaultBase(root: string): string | undefined {
    for (const ref of ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"]) {
        if (git(root, ["rev-parse", "--verify", "--quiet", ref]).trim()) return git(root, ["merge-base", "HEAD", ref]).trim() || ref;
    }
    return undefined;
}

/** Generated, vendored and fixture paths: patterns there are noise, not changes to review. */
const SKIP = /(^|\/)(node_modules|dist|build|target|\.secufusion|evals\/cases)\//;

export interface QuickResult {
    base: string | null;
    repo_key: string;
    stack: string;
    files_changed: number;
    findings: Finding[];
    notes: string[];
}

export function runQuickCheck(root: string, o: { base?: string; repoKey?: string } = {}): QuickResult {
    const notes: string[] = [];
    const repoKey = o.repoKey ?? path.basename(path.resolve(root));
    const stack = detectStack(root);
    const baseRef = o.base ?? defaultBase(root);
    if (!git(root, ["rev-parse", "--is-inside-work-tree"]).trim()) return { base: null, repo_key: repoKey, stack, files_changed: 0, findings: [], notes: ["Not a git repository: nothing to compare."] };
    if (o.base && !/^[\w./~^@{}-]+$/.test(o.base)) throw new Error(`refusing base ref "${o.base}"`);
    if (!baseRef) notes.push("No base branch found (origin/develop, origin/main, ...): only uncommitted changes were checked.");

    const range = baseRef ? [baseRef] : ["HEAD"];
    const names = git(root, ["diff", "--name-status", "--find-renames=60%", ...range]).split("\n").filter(Boolean).map((l) => {
        const [s, a, b] = l.split("\t");
        return { path: (b ?? a), status: s[0] };
    });
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    for (const u of untracked) if (!names.some((n) => n.path === u)) names.push({ path: u, status: "A" });

    for (let i = names.length - 1; i >= 0; i--) if (SKIP.test(names[i].path)) names.splice(i, 1);
    const added = parseAddedLines(git(root, ["diff", "-U0", "--no-color", ...range]));
    for (const k of Object.keys(added)) if (SKIP.test(k)) delete added[k];
    for (const u of untracked.filter((x) => !SKIP.test(x))) {
        try {
            const text = fs.readFileSync(path.join(root, u), "utf8");
            if (text.length < 500_000) added[u] = text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t }));
        } catch { /* binary or unreadable */ }
    }
    const read = (p: string) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch { return ""; } };
    const allowFile = names.map((n) => n.path).find((p) => /MutatingEndpointAllowlist\.java$/.test(p)) ?? git(root, ["ls-files", "*MutatingEndpointAllowlist.java"]).split("\n")[0];
    const migDir = "src/main/resources/db/migration";
    const baseMigs = baseRef ? git(root, ["ls-tree", "-r", "--name-only", baseRef, migDir]).split("\n").filter(Boolean) : [];
    const baseMigText = baseMigs.map((m) => git(root, ["show", `${baseRef}:${m}`]).toLowerCase()).join("\n");

    const findings = quickCheck({
        repoKey, stack, changedFiles: names, added, read,
        allowlist: allowFile ? read(allowFile) : "",
        columnKnownElsewhere: (c) => baseMigText.includes(c.toLowerCase()),
    });

    // Applied-migration rules come from the framework-neutral guard, not a second copy of the logic.
    try {
        const mg = checkAppliedMigrations(root, { base: baseRef });
        for (const v of mg.violations) {
            const rule = v.rule === "VERSION_CLASH" || v.rule === "VERSION_BELOW_HEAD" ? "DB-003" : "DB-002";
            findings.push(base({ ruleId: rule, severity: v.severity === "BLOCKER" ? "blocker" : "major", confidence: "confirmed", category: "db", file: v.file, line: 1,
                anchor: path.basename(v.file), title: `${v.rule}: ${path.basename(v.file)}`, problem: v.detail, failureScenario: "Environments that already ran the migration never see the change, or a version is skipped or taken twice.", suggestion: v.fix }));
        }
        notes.push(...mg.notes.filter((n) => /not a git|nothing applied/i.test(n)));
    } catch (e: any) { notes.push(`migration guard skipped: ${e?.message ?? e}`); }

    return { base: baseRef ?? null, repo_key: repoKey, stack, files_changed: names.length, findings: sortFindings(assignIds(findings, repoKey)), notes };
}

export function renderQuickCheck(r: QuickResult, failOn: Severity | "none" = "blocker"): string {
    const g = gateDecision({ findings: r.findings }, { failOn, blockOnPossible: false });
    const o = [`# Quick check: ${r.repo_key} (${r.stack}) vs ${r.base ?? "uncommitted changes"} · ${r.files_changed} file(s) · ${r.findings.length} lead(s) · gate ${g.status.toUpperCase()}`, ""];
    if (!r.findings.length) o.push("Nothing the mechanical rules can see. This is not a review: it does not read your logic.");
    for (const f of r.findings) o.push(`${f.severity.toUpperCase().padEnd(7)} ${f.confidence === "confirmed" ? "confirmed" : "possible "}  ${f.ruleId}  ${f.file}:${f.line}\n         ${f.title}\n         Fix: ${f.suggestion}`);
    if (r.notes.length) o.push("", ...r.notes.map((n) => `note: ${n}`));
    o.push("", "A quick check runs patterns, no model. 'possible' leads still need a reader; run /sfn-review for the real review.");
    return o.join("\n");
}

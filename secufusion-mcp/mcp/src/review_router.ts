/**
 * Review router: which of the review's passes does THIS change need?
 *
 * A one-line log change does not need 28 passes; a new endpoint over tenant data needs several deep ones. This scores the
 * change deterministically from the paths it touches and the signals in its code, in any language, and returns the passes
 * to run (with the reason for each), the ones to skip (with the reason), a review level, and the passes grouped so they can
 * be run by parallel specialists. It reads files and git, and writes nothing.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export type Level = "quick" | "standard" | "deep";
export type Group = "data-tenancy" | "contracts-messaging" | "spec-scope" | "quality" | "resilience" | "product" | "filter";

export const PASSES: Record<number, { name: string; group: Group }> = {
    0: { name: "Migration Review", group: "data-tenancy" },
    1: { name: "Tenant Isolation", group: "data-tenancy" },
    2: { name: "N+1 Detection", group: "data-tenancy" },
    3: { name: "Missing Index", group: "data-tenancy" },
    4: { name: "Messaging / Kafka Safety", group: "contracts-messaging" },
    5: { name: "Architectural Patterns", group: "contracts-messaging" },
    6: { name: "Acceptance Criteria Coverage", group: "spec-scope" },
    7: { name: "Rejected Patterns", group: "spec-scope" },
    8: { name: "Decision Drift", group: "spec-scope" },
    9: { name: "Architectural Suggestions", group: "quality" },
    10: { name: "Diff Quality", group: "quality" },
    11: { name: "Product & Privacy Fit", group: "product" },
    12: { name: "Product Behavior & Contracts", group: "product" },
    13: { name: "Architecture & Service Boundaries", group: "contracts-messaging" },
    14: { name: "Deployment Model Realities", group: "data-tenancy" },
    15: { name: "Tenant Hierarchy", group: "data-tenancy" },
    16: { name: "Privacy Model", group: "data-tenancy" },
    17: { name: "Operational Resilience", group: "resilience" },
    18: { name: "Future Maintainability", group: "quality" },
    19: { name: "Spec & Product Cross-Examination", group: "spec-scope" },
    20: { name: "Adversarial Edge Cases", group: "resilience" },
    21: { name: "Cross-Stack Contract Parity", group: "contracts-messaging" },
    22: { name: "Noise Filter", group: "filter" },
    23: { name: "Blast Radius", group: "contracts-messaging" },
    24: { name: "Nice-to-Have Triage", group: "quality" },
    25: { name: "SOLID Violations", group: "quality" },
    26: { name: "DRY & Simplification", group: "quality" },
    27: { name: "Fix-History Regression", group: "quality" },
};
const SPEC_PASSES = [6, 7, 8, 19];

type Signal = "migration" | "entity" | "data_access" | "http" | "security" | "messaging" | "scheduler" | "config" | "deps" | "ci" | "ui" | "invariant";
const PATH_SIGNALS: Array<{ signal: Signal; re: RegExp }> = [
    { signal: "migration", re: /(^|\/)(db\/migrations?|migrations?|alembic|flyway|liquibase|prisma\/migrations|Migrations)\/|\.sql$/i },
    { signal: "entity", re: /(^|\/)(entity|entities|model|models|domain|schema)\/|Entity\.(java|kt)$|schema\.prisma$|(^|\/)models\.py$|\.entity\.ts$/i },
    { signal: "data_access", re: /(Repository|Dao|DAO|Repo)\.(java|kt|ts|js|py|cs|go|rb|php)$|(^|\/)(repositories|repository|dao|daos|queries|store|stores)\//i },
    { signal: "http", re: /(Controller|Resource|Handler|Endpoint|Router|Routes?|Views?|Api)\.(java|kt|ts|tsx|js|py|cs|go|rb|php)$|(^|\/)(controllers?|routes?|handlers?|api|endpoints|views)\//i },
    { signal: "security", re: /(security|auth|jwt|oauth|keycloak|permission|rbac|acl|policy|guard|interceptor|middleware|authoriz)/i },
    { signal: "messaging", re: /(kafka|rabbit|amqp|sqs|sns|pubsub|nats|consumer|producer|listener|publisher|subscriber)/i },
    { signal: "scheduler", re: /(scheduler|cron|celery|sidekiq|hangfire|quartz|worker)/i },
    { signal: "config", re: /(application[^/]*\.(properties|ya?ml)|\.env|appsettings[^/]*\.json|(^|\/)config\/|settings\.py|\.toml$)/i },
    { signal: "deps", re: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|[^/]+\.csproj|Cargo\.(toml|lock))$/ },
    { signal: "ci", re: /(Dockerfile|docker-compose|\.github\/workflows|azure-pipelines|Jenkinsfile|\.gitlab-ci|(^|\/)helm\/|(^|\/)k8s\/|\.tf$)/i },
    { signal: "ui", re: /\.(jsx|tsx|vue|svelte|html|css|scss)$/i },
];
const CONTENT_SIGNALS: Array<{ signal: Signal; re: RegExp }> = [
    { signal: "entity", re: /@Entity|@Table\(|models\.Model|DbSet<|ApplicationRecord|\bmodel\s+\w+\s*\{|CREATE\s+TABLE|@Column\b/ },
    { signal: "data_access", re: /JpaRepository|CrudRepository|\.objects\.(filter|get|all)|prisma\.\w+\.(find|update|delete)|createQueryBuilder|session\.query|ActiveRecord::Base|DB::table|\bdb\.(Where|Find|First)\(/ },
    { signal: "http", re: /@(Get|Post|Put|Delete|Patch|Request)Mapping|@RestController|app\.(get|post|put|delete)\(|router\.(get|post|put|delete)\(|@app\.route|@(api_view|router)\.|\[Http(Get|Post|Put|Delete)|gin\.Context|http\.HandleFunc/ },
    { signal: "messaging", re: /KafkaTemplate|@KafkaListener|kafkajs|confluent_kafka|sarama|amqplib|\bpika\b|RabbitTemplate|@SqsListener|PubSub|nats\.(Connect|connect)/ },
    { signal: "security", re: /@PreAuthorize|\[Authorize|permission_classes|requireAuth|SecurityContext|JwtDecoder|verify_jwt|passport\./ },
    { signal: "scheduler", re: /@Scheduled|@celery|\bcron\b|IHostedService|BackgroundService|sidekiq/ },
    { signal: "invariant", re: /\b(defaultUser|isAdmin|is_admin|owner_?id|isOwner|tenantAdmin|platformAdmin|superuser|is_superuser)\b/ },
];
const WEIGHT: Record<Signal, number> = { migration: 3, entity: 2, data_access: 2, http: 2, security: 4, messaging: 3, scheduler: 2, config: 1, deps: 1, ci: 1, ui: 1, invariant: 2 };

const SIGNAL_PASSES: Record<Signal, number[]> = {
    migration: [0, 3, 14],
    entity: [0, 3, 13, 15],
    data_access: [1, 2, 3, 15, 23],
    http: [5, 12, 16, 21],
    security: [1, 5, 15, 20, 23],
    messaging: [4, 17, 21, 23],
    scheduler: [17, 20],
    config: [14, 16],
    deps: [14],
    ci: [14],
    ui: [12, 21],
    invariant: [15, 20, 23, 25],
};

const TEST = /(^|\/)(src\/test|__tests__|tests?|spec|specs)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt|cs)$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const DOCS = /\.(md|rst|txt|adoc)$|(^|\/)docs?\//i;
const LOCK = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|go\.sum|composer\.lock|Cargo\.lock|Pipfile\.lock)$/;
const CODE = /\.(java|kt|kts|scala|js|jsx|mjs|cjs|ts|tsx|py|cs|go|rb|php|rs|swift|c|cc|cpp|h|hpp|sql|vue|svelte)$/i;

export interface RouteOptions {
    files?: string[];
    base?: string;
    level?: Level;
    has_spec?: boolean;
    lines_changed?: number;
}
export interface RoutePlan {
    level: Level;
    score: number;
    factors: Array<{ signal: string; weight: number; files: string[] }>;
    selected: Array<{ pass: number; name: string; group: Group; why: string }>;
    skipped: Array<{ pass: number; name: string; why: string }>;
    groups: Record<string, number[]>;
    languages: Record<string, number>;
    files: string[];
    notes: string[];
}

function git(root: string, args: string[]): string {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
}

export function changedFilesFromGit(root: string, base?: string): { files: string[]; lines: number } {
    if (base && !/^[\w./~^@{}-]+$/.test(base)) throw new Error(`unsafe base ref: ${base}`);
    let ref = base ?? "";
    if (!ref) {
        for (const cand of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
            const mb = git(root, ["merge-base", "HEAD", cand]).trim();
            if (mb) { ref = mb; break; }
        }
    }
    const names = new Set<string>();
    const add = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).forEach((x) => names.add(x));
    if (ref) add(git(root, ["diff", "--name-only", "--no-renames", ref, "--"]));
    add(git(root, ["diff", "--name-only", "--no-renames", "HEAD", "--"]));
    add(git(root, ["ls-files", "--others", "--exclude-standard"]));
    let lines = 0;
    for (const l of git(root, ["diff", "--numstat", ref || "HEAD", "--"]).split("\n")) {
        const m = /^(\d+)\t(\d+)\t/.exec(l);
        if (m) lines += Number(m[1]) + Number(m[2]);
    }
    return { files: [...names], lines };
}

export function routeReview(root: string, o: RouteOptions = {}): RoutePlan {
    let files = o.files ?? [];
    let lines = o.lines_changed ?? 0;
    const notes: string[] = [];
    if (!files.length) {
        const g = changedFilesFromGit(root, o.base);
        files = g.files; lines = lines || g.lines;
        if (!files.length) notes.push("no changed files found: pass `files`, or run inside a git repository with changes");
    }
    files = files.map((f) => f.replace(/\\/g, "/"));
    const signals = new Map<Signal, Set<string>>();
    const mark = (s: Signal, f: string) => { if (!signals.has(s)) signals.set(s, new Set()); signals.get(s)!.add(f); };
    const languages: Record<string, number> = {};
    let codeFiles = 0, prodCode = 0;

    for (const f of files) {
        const ext = path.extname(f).toLowerCase().replace(".", "");
        if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
        const isTest = TEST.test(f);
        if (CODE.test(f)) { codeFiles++; if (!isTest) prodCode++; }
        if (!isTest) for (const p of PATH_SIGNALS) if (p.re.test(f)) mark(p.signal, f);
        const abs = path.resolve(root, f);
        if (!isTest && CODE.test(f) && abs.startsWith(path.resolve(root)) && fs.existsSync(abs)) {
            try {
                if (fs.statSync(abs).size <= 200_000) {
                    const t = fs.readFileSync(abs, "utf8");
                    for (const c of CONTENT_SIGNALS) if (c.re.test(t)) mark(c.signal, f);
                }
            } catch { /* unreadable */ }
        }
    }

    const nonDocs = files.filter((f) => !DOCS.test(f) && !LOCK.test(f));
    const docsOnly = files.length > 0 && nonDocs.length === 0;

    let score = 0;
    const factors: RoutePlan["factors"] = [];
    for (const [s, set] of signals) { score += WEIGHT[s]; factors.push({ signal: s, weight: WEIGHT[s], files: [...set].slice(0, 6) }); }
    if (lines > 1500) { score += 2; factors.push({ signal: "size>1500 lines", weight: 2, files: [] }); } else if (lines > 500) { score += 1; factors.push({ signal: "size>500 lines", weight: 1, files: [] }); }
    score = Math.min(score, 10);

    const level: Level = o.level ?? (docsOnly ? "quick" : score <= 2 ? "quick" : score >= 7 ? "deep" : "standard");

    const sel = new Map<number, string>();
    const want = (p: number, why: string) => { if (!sel.has(p)) sel.set(p, why); };
    want(10, "always: diff quality");
    want(11, "always: product and privacy fit");
    want(22, "always: noise filter before the report");
    want(27, "always: fix-history regression check (a cheap git lookup)");
    if (!docsOnly) {
        for (const [s] of signals) for (const p of SIGNAL_PASSES[s]) want(p, `signal: ${s}`);
        if (level !== "quick" && prodCode > 0) { want(18, "standard+: maintainability"); want(25, "standard+: SOLID"); want(26, "standard+: DRY and placement"); }
        if (level !== "quick" && (signals.has("http") || signals.has("data_access") || signals.has("messaging") || signals.has("security"))) want(20, "standard+: adversarial edge cases on an entry point");
        if (level === "deep") for (const p of Object.keys(PASSES).map(Number)) want(p, "deep level: every lens");
    }
    const hasSpec = o.has_spec ?? false;
    const skipped: RoutePlan["skipped"] = [];
    if (!hasSpec) {
        for (const p of SPEC_PASSES) { sel.delete(p); skipped.push({ pass: p, name: PASSES[p].name, why: "no specification loaded (has_spec=false): NOT APPLICABLE" }); }
    } else for (const p of SPEC_PASSES) want(p, "a specification exists: check the change against it");
    for (const p of Object.keys(PASSES).map(Number)) {
        if (!sel.has(p) && !skipped.some((s) => s.pass === p)) skipped.push({ pass: p, name: PASSES[p].name, why: docsOnly ? "documentation-only change" : `no signal for this lens at level ${level}` });
    }

    const selected = [...sel.entries()].sort((a, b) => a[0] - b[0]).map(([pass, why]) => ({ pass, name: PASSES[pass].name, group: PASSES[pass].group, why }));
    const groups: Record<string, number[]> = {};
    for (const s of selected) (groups[s.group] ??= []).push(s.pass);
    if (docsOnly) notes.push("documentation- or lockfile-only change: only the always-on passes are selected");
    notes.push("the router decides where to LOOK; a lens it skipped is reported NOT APPLICABLE with the reason, never silently. Override with `level` when you know better.");
    notes.push("groups can be run by parallel specialists (one subagent per group), then merged and filtered by pass 22");
    return { level, score, factors, selected, skipped, groups, languages, files, notes };
}

export function renderRoute(r: RoutePlan): string {
    const out = [
        `# Review route: level ${r.level.toUpperCase()} · risk ${r.score}/10 · ${r.files.length} file(s) · ${Object.entries(r.languages).map(([k, v]) => `${k} ${v}`).join(", ") || "no files"}`,
        "", "Risk factors:", ...(r.factors.length ? r.factors.map((f) => `  +${f.weight} ${f.signal}${f.files.length ? `  (${f.files.join(", ")})` : ""}`) : ["  none"]),
        "", `Run these passes (${r.selected.length}):`, ...r.selected.map((s) => `  PASS ${String(s.pass).padStart(2)}  ${s.name.padEnd(34)} [${s.group}]  ${s.why}`),
        "", "Parallel groups:", ...Object.entries(r.groups).map(([g, p]) => `  ${g}: ${p.join(", ")}`),
        "", `Skip (${r.skipped.length}):`, ...r.skipped.map((s) => `  PASS ${String(s.pass).padStart(2)}  ${s.name}: ${s.why}`),
        "", ...r.notes.map((n) => `note: ${n}`),
    ];
    return out.join("\n");
}

/**
 * Entity impact inventory for the PESSIMISTIC ARCHITECTURE AND PRODUCT REVIEW (ownership, role, admin, tenancy, permission
 * and lifecycle stories).
 *
 * The deterministic half of phases 7 to 9: it searches the WHOLE workspace (every service, not just the changed files) for
 * ownership checks, admin checks, role and authority checks, status checks, `tenant.email`, `defaultUser`, audit fields,
 * write paths, caches, events, scheduled jobs and imports/exports, and reports them per service together with every
 * reference to the entity being changed. It answers "what else depends on this data?" so the reviewer does not stop at the
 * changed files. Pattern-based and READ-ONLY: absence of a hit is not proof of absence, and a hit is not a defect; the
 * reviewer judges what each dependency assumes and whether the change preserves it.
 */
import fs from "fs";
import path from "path";
import { git, gitTop, pickBase } from "./diff_quality.js";

export type Dep =
    | "OWNERSHIP_CHECK" | "ADMIN_CHECK" | "ROLE_OR_AUTHORITY_CHECK" | "STATUS_CHECK" | "TENANT_EMAIL" | "DEFAULT_USER"
    | "AUDIT_FIELD" | "CACHE" | "EVENT" | "SCHEDULED_JOB" | "IMPORT_EXPORT" | "WRITE_PATH";

const LINE_PATTERNS: Array<[Dep, RegExp]> = [
    ["OWNERSHIP_CHECK", /\b(isOwner|getOwner\w*|setOwner\w*|ownerId|owner_id|ownedBy|transferOwnership|changeOwner|newOwner|currentOwner)\b|\bowner\b/i],
    ["ADMIN_CHECK", /\b(isAdmin|isSuperAdmin|isTenantAdmin|isPlatformAdmin|adminOnly|isDefaultAdmin)\b|hasRole\(\s*['"]?(ROLE_)?ADMIN|\bROLE_ADMIN\b|\.equals\(\s*['"]ADMIN['"]/],
    ["ROLE_OR_AUTHORITY_CHECK", /(hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|\.getRoles\(|\.roles\b|\bGroupMember\w*|\bisMemberOf|\bgetAuthorities\()/],
    ["STATUS_CHECK", /(\.getStatus\(\)|\bisActive\(\)|\bisEnabled\(\)|\bisDisabled\(\)|\.status\s*(===?|!==?)|Status\.(ACTIVE|INACTIVE|DISABLED|DELETED|PENDING|SUSPENDED)|\bstatus\s*=\s*['"](ACTIVE|INACTIVE|DISABLED|DELETED))/],
    ["TENANT_EMAIL", /tenant\.?\s*(get)?email|getTenantEmail|tenantEmail|tenant_email/i],
    ["DEFAULT_USER", /defaultUser|default_user|getDefaultUser|isDefaultUser/i],
    ["AUDIT_FIELD", /(\bcreatedAt\b|\bcreatedBy\b|\bupdatedAt\b|\bupdatedBy\b|\bcreated_at\b|\bcreated_by\b|\bupdated_at\b|\bupdated_by\b|@CreatedBy|@LastModifiedBy|@CreatedDate|@LastModifiedDate)/],
    ["CACHE", /(@Cacheable|@CacheEvict|@CachePut|\bredis\w*|cacheManager|\.cache\.|localStorage|sessionStorage|useQuery\()/i],
    ["EVENT", /(@KafkaListener|kafkaTemplate\.send|KafkaProducer|producer\.send|\.publish\(|\bemit\(|ApplicationEventPublisher|@EventListener|@RabbitListener)/],
    ["SCHEDULED_JOB", /(@Scheduled|\bcron\b|@Async\b|ScheduledExecutor|setInterval\()/],
    ["WRITE_PATH", /(@(Post|Put|Patch|Delete)Mapping\b|\b(public|protected)\s+[\w<>\[\],.? ]+\s+(create|update|delete|remove|transfer|disable|enable|deactivate|reactivate|restore|assign|revoke|add|save|import|bulk|migrate|merge|move)\w*\s*\()|\b(router|app)\.(post|put|patch|delete)\(/i],
];

const CODE = /\.(java|kt|scala|groovy|jsx?|tsx?|mjs|py|go|cs|rb|php|sql|ya?ml|properties)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.java$/;
const NAME_IMPORT_EXPORT = /(import|export|csv|excel|bulk|migrat|backfill|seed)/i;
const MAX_FILES = 20000, MAX_BYTES = 1_000_000;

export interface Hit { file: string; line: number; text: string }
export interface ServiceInventory {
    service: string; files_scanned: number;
    entity_references: Record<string, number>; entity_files: string[]; entity_definitions: Array<{ file: string; audit_fields: string[] }>;
    deps: Partial<Record<Dep, Hit[]>>; dep_counts: Partial<Record<Dep, number>>;
    tests_referencing_entity: number; import_export_files: string[];
}
export interface EntityImpactReport {
    root: string; terms: string[]; services: ServiceInventory[]; services_without_references: string[];
    trigger: { fired: boolean; matched: string[]; sources: string[] };
    truncated: boolean; notes: string[];
}

export const TRIGGER_WORDS = ["owner", "ownership", "role", "admin", "tenant", "parent", "child", "permission", "authority", "authorization", "group", "member", "membership", "transfer", "disable", "deactivate", "reactivate", "delete", "restore", "recover", "impersonate", "elevate", "privilege", "createdby", "preauthorize"];
const TRIGGER_RE = new RegExp(`\\b(${TRIGGER_WORDS.join("|")})\\w*`, "gi");

/** Does this story, or its diff, concern ownership, role, admin, tenancy, permission or lifecycle? */
export function detectTrigger(texts: Array<{ source: string; text: string }>): { fired: boolean; matched: string[]; sources: string[] } {
    const matched = new Set<string>(), sources = new Set<string>();
    for (const { source, text } of texts) {
        for (const m of text.matchAll(TRIGGER_RE)) { matched.add(m[0].toLowerCase()); sources.add(source); }
    }
    // a lone generic word ("tenant" in a path, "delete" in a button label) is weak; require two distinct signals or a strong one
    const strong = [...matched].some((m) => /^(owner|ownership|transfer|elevat|privilege|impersonat|preauthorize|authority|authorization|permission|membership)/.test(m));
    return { fired: matched.size >= 2 || strong, matched: [...matched].sort(), sources: [...sources].sort() };
}

function serviceRoots(root: string): string[] {
    const subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_DIR.has(d.name) && !d.name.startsWith("."));
    const marked = subs.filter((d) => ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", ".git", "pyproject.toml"].some((m) => fs.existsSync(path.join(root, d.name, m))));
    return marked.length ? marked.map((d) => d.name) : [""];
}

function walk(dir: string, out: string[], budget: { n: number }) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget.n <= 0) return;
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), out, budget); }
        else if (CODE.test(e.name)) { out.push(path.join(dir, e.name)); budget.n--; }
    }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function inventoryEntityImpact(workspaceRoot: string, opts: { terms: string[]; story_text?: string; base?: string; max_hits?: number }): EntityImpactReport {
    const root = path.resolve(workspaceRoot);
    const terms = opts.terms.map((t) => t.trim()).filter(Boolean);
    const maxHits = opts.max_hits ?? 6;
    const rep: EntityImpactReport = { root, terms, services: [], services_without_references: [], trigger: { fired: false, matched: [], sources: [] }, truncated: false, notes: [] };
    const termRes = terms.map((t) => [t, new RegExp(`\\b${esc(t)}(s|es)?\\b`, "i")] as const);
    const budget = { n: MAX_FILES };

    for (const svc of serviceRoots(root)) {
        const dir = svc ? path.join(root, svc) : root;
        const files: string[] = []; walk(dir, files, budget);
        const inv: ServiceInventory = { service: svc || path.basename(root), files_scanned: 0, entity_references: {}, entity_files: [], entity_definitions: [], deps: {}, dep_counts: {}, tests_referencing_entity: 0, import_export_files: [] };
        for (const f of files) {
            let text: string;
            try { const st = fs.statSync(f); if (st.size > MAX_BYTES) continue; text = fs.readFileSync(f, "utf-8"); } catch { continue; }
            inv.files_scanned++;
            const rel = path.relative(root, f).split(path.sep).join("/");
            const refsHere = termRes.filter(([, re]) => re.test(text));
            if (!refsHere.length) continue;       // dependencies are only reported in files that talk about the entity
            for (const [t, re] of termRes) { const n = (text.match(new RegExp(re.source, "gi")) ?? []).length; if (n) inv.entity_references[t] = (inv.entity_references[t] ?? 0) + n; }
            if (TEST.test(rel)) { inv.tests_referencing_entity++; continue; }
            inv.entity_files.push(rel);
            if (NAME_IMPORT_EXPORT.test(path.basename(f))) inv.import_export_files.push(rel);
            const lines = text.split(/\r?\n/);
            // an entity definition: a class/type named after a term, with the audit fields it carries
            for (const [t] of termRes) {
                if (new RegExp(`\\b(class|interface|record|type|enum)\\s+${esc(t)}\\b`, "i").test(text) && /\.(java|kt|ts|tsx|cs)$/.test(f)) {
                    inv.entity_definitions.push({ file: rel, audit_fields: [...new Set([...text.matchAll(/\b(createdAt|createdBy|updatedAt|updatedBy|created_at|created_by|updated_at|updated_by)\b/g)].map((m) => m[1]))] });
                }
            }
            lines.forEach((l, i) => {
                if (/^\s*(\/\/|\*|\/\*|#)/.test(l)) return;
                for (const [dep, re] of LINE_PATTERNS) {
                    if (!re.test(l)) continue;
                    inv.dep_counts[dep] = (inv.dep_counts[dep] ?? 0) + 1;
                    const arr = (inv.deps[dep] ??= []);
                    if (arr.length < maxHits) arr.push({ file: rel, line: i + 1, text: l.trim().slice(0, 160) });
                }
            });
        }
        if (Object.keys(inv.entity_references).length) rep.services.push(inv); else rep.services_without_references.push(inv.service);
    }
    if (budget.n <= 0) { rep.truncated = true; rep.notes.push(`Stopped after ${MAX_FILES} files; the inventory is partial.`); }
    rep.services.sort((a, b) => Object.values(b.entity_references).reduce((x, y) => x + y, 0) - Object.values(a.entity_references).reduce((x, y) => x + y, 0));

    const texts: Array<{ source: string; text: string }> = [];
    if (opts.story_text) texts.push({ source: "story text", text: opts.story_text });
    const top = gitTop(root);
    if (top) {
        const { base } = pickBase(top, opts.base);
        const diff = git(top, ["diff", "-U0", "--no-color", "--no-renames", base]) ?? "";
        const added = (diff as string).split(/\r?\n/).filter((l: string) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
        const names = (diff as string).split(/\r?\n/).filter((l: string) => l.startsWith("+++ ")).join("\n");
        if (added) texts.push({ source: "diff", text: added + "\n" + names });
    }
    rep.trigger = detectTrigger(texts);
    rep.notes.push("Pattern-based and read-only. Dependencies are listed only in files that mention the entity. A hit is not a defect and a missing hit is not proof of absence: read what each dependency assumes about the entity and whether the change preserves it.");
    if (!terms.length) rep.notes.push("No entity terms were given, so nothing could be inventoried.");
    return rep;
}

const LABEL: Record<Dep, string> = {
    OWNERSHIP_CHECK: "Ownership checks", ADMIN_CHECK: "Admin checks", ROLE_OR_AUTHORITY_CHECK: "Role / authority / membership checks", STATUS_CHECK: "Status checks",
    TENANT_EMAIL: "tenant.email usage", DEFAULT_USER: "defaultUser usage", AUDIT_FIELD: "Audit fields", CACHE: "Caches and client-side stores", EVENT: "Events produced or consumed",
    SCHEDULED_JOB: "Scheduled and async jobs", WRITE_PATH: "Write paths (endpoints and mutating methods)", IMPORT_EXPORT: "Imports / exports",
};

export function renderEntityImpact(r: EntityImpactReport): string {
    const head =
        `## ENTITY IMPACT INVENTORY\n` +
        `Entity terms: ${r.terms.join(", ") || "none"} · services referencing it: ${r.services.length} · without references: ${r.services_without_references.join(", ") || "none"}\n` +
        `Pessimistic-review trigger: ${r.trigger.fired ? "FIRED" : "not fired"}${r.trigger.matched.length ? ` (${r.trigger.matched.join(", ")}; from ${r.trigger.sources.join(", ")})` : ""}\n` +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "");
    if (!r.services.length) return head + "\nNo service references the entity.\n";
    const blocks = r.services.map((s) => {
        const lines: string[] = [`### ${s.service}  (${s.files_scanned} files scanned; ${s.entity_files.length} non-test files reference the entity; ${s.tests_referencing_entity} test files)`];
        lines.push(`References: ${Object.entries(s.entity_references).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        if (s.entity_definitions.length) lines.push(`Entity definitions and their audit fields:\n${s.entity_definitions.map((d) => `- ${d.file}: ${d.audit_fields.length ? d.audit_fields.join(", ") : "NO audit fields found"}`).join("\n")}`);
        for (const dep of Object.keys(LABEL) as Dep[]) {
            const hits = s.deps[dep];
            if (dep === "IMPORT_EXPORT") { if (s.import_export_files.length) lines.push(`${LABEL[dep]} (${s.import_export_files.length} files): ${s.import_export_files.slice(0, 6).join(", ")}`); continue; }
            if (!hits?.length) continue;
            lines.push(`${LABEL[dep]} (${s.dep_counts[dep]}):\n${hits.map((h) => `- ${h.file}:${h.line}  ${h.text}`).join("\n")}${(s.dep_counts[dep] ?? 0) > hits.length ? `\n- …and ${(s.dep_counts[dep] ?? 0) - hits.length} more` : ""}`);
        }
        return lines.join("\n");
    });
    return head + "\n" + blocks.join("\n\n") + "\n";
}

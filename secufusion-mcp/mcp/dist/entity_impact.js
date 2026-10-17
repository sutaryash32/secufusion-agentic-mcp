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
import { variantsOf } from "./invariant_enforcement.js";
const LINE_PATTERNS = [
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
// words that mark a line as part of an authorization decision
const AUTH_CONTEXT = /(AccessDenied|Forbidden|Unauthorized|NotAuthorized|hasAuthority|hasAnyAuthority|hasRole|hasScope|callerHasScope|hasPermission|@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|\bisAuthorized|\bcanAccess|\bcanManage|checkPermission|requireRole|requireAuth|\bisPlatformAdmin\w*|isCallerAncestorOrSelf|ParentChain\w*|authorize\w*\()/;
// a field or method declaration that merely names the flag is not a use of it
const PLAIN_DECLARATION = /^\s*(public|protected|private)\b(?!.*\b(return|if)\b)[^=]*[;{]\s*$/;
// a trivial accessor (one-line getter or setter) or a bare `return field;` is not a decision either
const ACCESSOR_LINE = /^\s*(?:(?:public|protected|private)\s+)?[\w<>\[\],.? ]+\s+(?:is|get|set|has)\w+\s*\([^)]*\)\s*\{\s*(?:return\s+(?:this\.)?[\w.]+\s*;|(?:this\.)?\w+\s*=\s*\w+\s*;)\s*\}\s*$|^\s*return\s+(?:this\.)?[\w.]+\s*;\s*$/;
const AUTH_INFRA_FILE = /(Authorizer|Authoriz|Filter|Security|Guard|Interceptor)\w*\.(java|kt|ts|js)$/i;
const LOW_FILE = /(Notif|Notifier|Mailer|Email|Report|Export|Dashboard)/i;
const UI_FILE = /\.(jsx?|tsx?|mjs)$/;
const CODE = /\.(java|kt|scala|groovy|jsx?|tsx?|mjs|py|go|cs|rb|php|sql|ya?ml|properties)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.java$/;
const NAME_IMPORT_EXPORT = /(import|export|csv|excel|bulk|migrat|backfill|seed)/i;
const MAX_FILES = 20000, MAX_BYTES = 1_000_000;
export const TRIGGER_WORDS = ["owner", "ownership", "role", "admin", "tenant", "parent", "child", "permission", "authority", "authorization", "group", "member", "membership", "transfer", "disable", "deactivate", "reactivate", "delete", "restore", "recover", "impersonate", "elevate", "privilege", "createdby", "preauthorize"];
const TRIGGER_RE = new RegExp(`\\b(${TRIGGER_WORDS.join("|")})\\w*`, "gi");
/** Does this story, or its diff, concern ownership, role, admin, tenancy, permission or lifecycle? */
export function detectTrigger(texts) {
    const matched = new Set(), sources = new Set();
    for (const { source, text } of texts) {
        for (const m of text.matchAll(TRIGGER_RE)) {
            matched.add(m[0].toLowerCase());
            sources.add(source);
        }
    }
    // a lone generic word ("tenant" in a path, "delete" in a button label) is weak; require two distinct signals or a strong one
    const strong = [...matched].some((m) => /^(owner|ownership|transfer|elevat|privilege|impersonat|preauthorize|authority|authorization|permission|membership)/.test(m));
    return { fired: matched.size >= 2 || strong, matched: [...matched].sort(), sources: [...sources].sort() };
}
function serviceRoots(root) {
    const subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_DIR.has(d.name) && !d.name.startsWith("."));
    const marked = subs.filter((d) => ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", ".git", "pyproject.toml"].some((m) => fs.existsSync(path.join(root, d.name, m))));
    return marked.length ? marked.map((d) => d.name) : [""];
}
function walk(dir, out, budget) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget.n <= 0)
            return;
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name) && !e.name.startsWith("."))
                walk(path.join(dir, e.name), out, budget);
        }
        else if (CODE.test(e.name)) {
            out.push(path.join(dir, e.name));
            budget.n--;
        }
    }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function inventoryEntityImpact(workspaceRoot, opts) {
    const root = path.resolve(workspaceRoot);
    const terms = opts.terms.map((t) => t.trim()).filter(Boolean);
    const maxHits = opts.max_hits ?? 6;
    const rep = { root, terms, services: [], services_without_references: [], trigger: { fired: false, matched: [], sources: [] }, flags: (opts.flags ?? []).map((f) => f.trim()).filter(Boolean), ranked_consumers: [], truncated: false, notes: [] };
    const allTerms = [...new Set([...terms, ...rep.flags])];
    const flagRe = rep.flags.length ? new RegExp(rep.flags.flatMap((f) => variantsOf(f)).map(esc).join("|"), "i") : null;
    const fileInfo = new Map();
    const termRes = allTerms.map((t) => [t, new RegExp(`\\b${esc(t)}(s|es)?\\b`, "i")]);
    const budget = { n: MAX_FILES };
    for (const svc of serviceRoots(root)) {
        const dir = svc ? path.join(root, svc) : root;
        const files = [];
        walk(dir, files, budget);
        const inv = { service: svc || path.basename(root), files_scanned: 0, entity_references: {}, entity_files: [], entity_definitions: [], deps: {}, dep_counts: {}, tests_referencing_entity: 0, import_export_files: [] };
        for (const f of files) {
            let text;
            try {
                const st = fs.statSync(f);
                if (st.size > MAX_BYTES)
                    continue;
                text = fs.readFileSync(f, "utf-8");
            }
            catch {
                continue;
            }
            inv.files_scanned++;
            const rel = path.relative(root, f).split(path.sep).join("/");
            const refsHere = termRes.filter(([, re]) => re.test(text));
            // a flag is matched by substring across its naming variants (isDefaultUser, findByTenantAndDefaultUser, default_user), not at word boundaries
            const flagHits = flagRe ? (text.match(new RegExp(flagRe.source, "gi")) ?? []).length : 0;
            if (!refsHere.length && !flagHits)
                continue; // dependencies are only reported in files that talk about the entity or the flag
            if (flagHits)
                inv.entity_references[`flag ${rep.flags.join("/")}`] = (inv.entity_references[`flag ${rep.flags.join("/")}`] ?? 0) + flagHits;
            for (const [t, re] of termRes) {
                const n = (text.match(new RegExp(re.source, "gi")) ?? []).length;
                if (n)
                    inv.entity_references[t] = (inv.entity_references[t] ?? 0) + n;
            }
            if (TEST.test(rel)) {
                inv.tests_referencing_entity++;
                continue;
            }
            inv.entity_files.push(rel);
            if (NAME_IMPORT_EXPORT.test(path.basename(f)))
                inv.import_export_files.push(rel);
            const lines = text.split(/\r?\n/);
            // an entity definition: a class/type named after a term, with the audit fields it carries
            for (const [t] of termRes) {
                if (new RegExp(`\\b(class|interface|record|type|enum)\\s+${esc(t)}\\b`, "i").test(text) && /\.(java|kt|ts|tsx|cs)$/.test(f)) {
                    inv.entity_definitions.push({ file: rel, audit_fields: [...new Set([...text.matchAll(/\b(createdAt|createdBy|updatedAt|updatedBy|created_at|created_by|updated_at|updated_by)\b/g)].map((m) => m[1]))] });
                }
            }
            const info = fileInfo.get(rel) ?? { service: inv.service, cats: new Set(), hits: [], count: 0 };
            fileInfo.set(rel, info);
            const note = (dep, i, l) => {
                inv.dep_counts[dep] = (inv.dep_counts[dep] ?? 0) + 1;
                const hit = { file: rel, line: i + 1, text: l.trim().slice(0, 160) };
                const arr = (inv.deps[dep] ??= []);
                if (arr.length < maxHits)
                    arr.push(hit);
                info.cats.add(dep);
                info.count++;
                if (info.hits.length < 40)
                    info.hits.push({ ...hit, dep });
            };
            const authIdx = [];
            lines.forEach((l, i) => { if (!/^\s*(\/\/|\*|\/\*|#|import\s)/.test(l) && AUTH_CONTEXT.test(l))
                authIdx.push(i); });
            lines.forEach((l, i) => {
                if (/^\s*(\/\/|\*|\/\*|#)/.test(l))
                    return;
                for (const [dep, re] of LINE_PATTERNS)
                    if (re.test(l))
                        note(dep, i, l);
                // authority coupling: a flag or field that identifies ownership or status is used inside an authorization decision
                if (flagRe && flagRe.test(l) && !/^\s*(import\s|@)/.test(l) && !PLAIN_DECLARATION.test(l) && !ACCESSOR_LINE.test(l) && authIdx.some((a) => Math.abs(a - i) <= 8))
                    note("AUTHORITY_COUPLING", i, l);
            });
        }
        if (Object.keys(inv.entity_references).length)
            rep.services.push(inv);
        else
            rep.services_without_references.push(inv.service);
    }
    if (budget.n <= 0) {
        rep.truncated = true;
        rep.notes.push(`Stopped after ${MAX_FILES} files; the inventory is partial.`);
    }
    // rank the consumers: what to read first
    const MEDIUM_CATS = ["WRITE_PATH", "STATUS_CHECK", "OWNERSHIP_CHECK", "EVENT", "SCHEDULED_JOB", "CACHE", "TENANT_EMAIL", "ADMIN_CHECK", "ROLE_OR_AUTHORITY_CHECK", "DEFAULT_USER"];
    for (const [file, info] of fileInfo) {
        if (!info.count)
            continue;
        const cats = [...info.cats];
        let crit, why;
        if (cats.includes("AUTHORITY_COUPLING")) {
            crit = "CRITICAL";
            why = "the flag appears inside an authorization decision: moving or changing it moves who may act";
        }
        else if (AUTH_INFRA_FILE.test(file) && info.hits.length) {
            crit = "CRITICAL";
            why = "authorization infrastructure reads it";
        }
        else if (cats.some((c) => MEDIUM_CATS.includes(c))) {
            crit = "MEDIUM";
            why = "it writes, checks the status or ownership of, or reacts to this data";
        }
        else {
            crit = "LOW";
            why = "it only carries audit fields or imports/exports the data";
        }
        if (crit !== "LOW" && LOW_FILE.test(path.basename(file)) && !cats.includes("AUTHORITY_COUPLING")) {
            crit = "LOW";
            why = "a notification, report or export that follows the data";
        }
        if (crit === "CRITICAL" && UI_FILE.test(file)) {
            crit = "MEDIUM";
            why = "UI gating on the flag: a UX / authority mismatch risk, not a security boundary";
        }
        const ev = [...info.hits].sort((a, b) => (a.dep === "AUTHORITY_COUPLING" ? 0 : 1) - (b.dep === "AUTHORITY_COUPLING" ? 0 : 1)).slice(0, 2).map(({ dep: _d, ...h }) => h);
        rep.ranked_consumers.push({ file, service: info.service, criticality: crit, why, hits: info.count, categories: cats, evidence: ev });
    }
    const crank = { CRITICAL: 0, MEDIUM: 1, LOW: 2 };
    rep.ranked_consumers.sort((a, b) => crank[a.criticality] - crank[b.criticality] || b.hits - a.hits || a.file.localeCompare(b.file));
    // the same file name in several services at the same criticality is one rule copied around: show it once, listing the copies
    // (copies of a rule drift apart; that is a finding to check, and it keeps the worklist short)
    const merged = [];
    const byName = new Map();
    for (const c of rep.ranked_consumers) {
        const key = `${path.basename(c.file)}|${c.criticality}`;
        const first = byName.get(key);
        if (first && first.service !== c.service) {
            (first.also_in ??= []).push(`${c.service}/${path.basename(c.file)}`);
            first.hits += c.hits;
        }
        else {
            const copy = { ...c };
            if (!first)
                byName.set(key, copy);
            merged.push(copy);
        }
    }
    rep.ranked_consumers = merged.slice(0, opts.max_ranked ?? 15);
    rep.services.sort((a, b) => Object.values(b.entity_references).reduce((x, y) => x + y, 0) - Object.values(a.entity_references).reduce((x, y) => x + y, 0));
    const texts = [];
    if (opts.story_text)
        texts.push({ source: "story text", text: opts.story_text });
    const top = gitTop(root);
    if (top) {
        const { base } = pickBase(top, opts.base);
        const diff = git(top, ["diff", "-U0", "--no-color", "--no-renames", base]) ?? "";
        const added = diff.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
        const names = diff.split(/\r?\n/).filter((l) => l.startsWith("+++ ")).join("\n");
        if (added)
            texts.push({ source: "diff", text: added + "\n" + names });
    }
    rep.trigger = detectTrigger(texts);
    rep.notes.push("Pattern-based and read-only. Dependencies are listed only in files that mention the entity. A hit is not a defect and a missing hit is not proof of absence: read what each dependency assumes about the entity and whether the change preserves it.");
    if (!terms.length)
        rep.notes.push("No entity terms were given, so nothing could be inventoried.");
    return rep;
}
const LABEL = {
    AUTHORITY_COUPLING: "Authority coupling (the flag appears in an authorization decision)",
    OWNERSHIP_CHECK: "Ownership checks", ADMIN_CHECK: "Admin checks", ROLE_OR_AUTHORITY_CHECK: "Role / authority / membership checks", STATUS_CHECK: "Status checks",
    TENANT_EMAIL: "tenant.email usage", DEFAULT_USER: "defaultUser usage", AUDIT_FIELD: "Audit fields", CACHE: "Caches and client-side stores", EVENT: "Events produced or consumed",
    SCHEDULED_JOB: "Scheduled and async jobs", WRITE_PATH: "Write paths (endpoints and mutating methods)", IMPORT_EXPORT: "Imports / exports",
};
export function renderEntityImpact(r) {
    const head = `## ENTITY IMPACT INVENTORY\n` +
        `Entity terms: ${r.terms.join(", ") || "none"}${r.flags.length ? ` · flags checked for authority coupling: ${r.flags.join(", ")}` : ""} · services referencing it: ${r.services.length} · without references: ${r.services_without_references.join(", ") || "none"}\n` +
        `Pessimistic-review trigger: ${r.trigger.fired ? "FIRED" : "not fired"}${r.trigger.matched.length ? ` (${r.trigger.matched.join(", ")}; from ${r.trigger.sources.join(", ")})` : ""}\n` +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "");
    if (!r.services.length)
        return head + "\nNo service references the entity.\n";
    const blocks = r.services.map((s) => {
        const lines = [`### ${s.service}  (${s.files_scanned} files scanned; ${s.entity_files.length} non-test files reference the entity; ${s.tests_referencing_entity} test files)`];
        lines.push(`References: ${Object.entries(s.entity_references).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        if (s.entity_definitions.length)
            lines.push(`Entity definitions and their audit fields:\n${s.entity_definitions.map((d) => `- ${d.file}: ${d.audit_fields.length ? d.audit_fields.join(", ") : "NO audit fields found"}`).join("\n")}`);
        for (const dep of Object.keys(LABEL)) {
            const hits = s.deps[dep];
            if (dep === "IMPORT_EXPORT") {
                if (s.import_export_files.length)
                    lines.push(`${LABEL[dep]} (${s.import_export_files.length} files): ${s.import_export_files.slice(0, 6).join(", ")}`);
                continue;
            }
            if (!hits?.length)
                continue;
            lines.push(`${LABEL[dep]} (${s.dep_counts[dep]}):\n${hits.map((h) => `- ${h.file}:${h.line}  ${h.text}`).join("\n")}${(s.dep_counts[dep] ?? 0) > hits.length ? `\n- …and ${(s.dep_counts[dep] ?? 0) - hits.length} more` : ""}`);
        }
        return lines.join("\n");
    });
    const rank = r.ranked_consumers.length
        ? `### RANKED CONSUMERS: read these first\n` +
            `Critical = the flag is inside an authorization decision or authorization infrastructure reads it; Medium = it writes, checks status or ownership, or reacts to the data; Low = audit fields, imports/exports, notifications.` +
            (r.flags.length ? "" : ` (No flags were given, so authority coupling was not checked: pass the fields that identify ownership or status, e.g. defaultUser, owner.)`) + "\n" +
            r.ranked_consumers.map((c) => `- [${c.criticality}] ${c.file}  (${c.service}; ${c.hits} hit(s); ${c.categories.join(", ")})\n    why: ${c.why}${c.also_in?.length ? `\n    ALSO IN ${c.also_in.length} other service(s): ${c.also_in.join(", ")}: the same rule appears copied across services, so check the copies agree` : ""}\n${c.evidence.map((h) => `    ${h.file.split("/").pop()}:${h.line}  ${h.text}`).join("\n")}`).join("\n")
        : "";
    return head + "\n" + (rank ? rank + "\n\n" : "") + blocks.join("\n\n") + "\n";
}

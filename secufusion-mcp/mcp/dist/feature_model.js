/**
 * Feature model: build the review's understanding of the feature BEFORE judging any diff.
 *
 *   1. Family: the story, its child tasks and the item it was split from (registry tags, text references, branch names).
 *   2. Entities: the primary business entities (given, or proposed from tags, titles and recorded decisions).
 *   3. Transitions: for every entity, the lifecycle transitions that EXIST in the workspace (create, update, transfer,
 *      disable, delete, status change, membership change, ...) with file:line, and whether the method that performs
 *      each one mentions the ownership/status flag at all (a transition that never looks at the flag cannot protect it).
 *   4. Capability dependencies and the cross-service graph: from check_entity_impact (authority coupling, ranked
 *      consumers, rules copied across services).
 *   5. A review matrix: every transition checked against every contract clause. Transitions with no path are listed
 *      too: an absent path is a lifecycle question ("what state results?"), not a clean bill.
 * Pattern-based and READ-ONLY. It builds the questions; the reviewer answers them.
 */
import fs from "fs";
import path from "path";
import { inventoryEntityImpact } from "./entity_impact.js";
import { variantsOf } from "./invariant_enforcement.js";
const ID_RE = /\b(?:STORY|TASK|BUG|US|FEATURE|EPIC|PBI)-?\d+\b/gi;
const normId = (s) => s.toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, "$1-$2");
const num = (s) => /(\d+)/.exec(s)?.[1] ?? s;
function readJson(p) { try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""));
}
catch {
    return null;
} }
/** The story, its children and the item it was split from: from the registry's tags and titles, and ids mentioned in the records. */
export function discoverFamily(root, id) {
    const out = new Map();
    const want = normId(id);
    const reg = readJson(path.join(root, ".secufusion", "registry.json"));
    const items = Array.isArray(reg) ? reg : [];
    const byId = new Map(items.map((i) => [normId(String(i.work_item_id)), i]));
    const add = (m) => { if (!out.has(m.id))
        out.set(m.id, m); };
    const self = byId.get(want);
    add({ id: want, title: self?.title ?? "(no record: the story itself has no work record here)", role: "story", via: self ? "registry" : "requested", status: self?.status });
    for (const it of items) {
        const iid = normId(String(it.work_item_id));
        if (iid === want)
            continue;
        const tags = (it.tags ?? []).map(String);
        const tagIds = tags.flatMap((t) => [...t.matchAll(ID_RE)].map((m) => normId(m[0])));
        if (tagIds.includes(want)) {
            add({ id: iid, title: it.title, role: "child", via: `tagged ${want}`, status: it.status });
            for (const t of tags) {
                const sp = /^split-from-(.+)$/i.exec(t);
                if (sp) {
                    const oid = normId(sp[1]);
                    const o = byId.get(oid);
                    add({ id: oid, title: o?.title ?? "(origin, no record)", role: "origin", via: `split-from tag on ${iid}`, status: o?.status });
                }
            }
        }
        else if (new RegExp(`\\b${num(want)}\\b`).test(String(it.title))) {
            add({ id: iid, title: it.title, role: "related", via: "id in title", status: it.status });
        }
    }
    // one hop: ids mentioned in a member's request or decisions
    for (const m of [...out.values()]) {
        const req = readJson(path.join(root, ".secufusion", "requirements", `${m.id}.json`));
        const text = [req?.raw_request, ...(req?.decisions ?? [])].filter(Boolean).join(" ");
        for (const x of text.matchAll(ID_RE)) {
            const xid = normId(x[0]);
            if (out.has(xid))
                continue;
            const rec = byId.get(xid);
            if (rec)
                add({ id: xid, title: rec.title, role: "related", via: `mentioned in ${m.id}`, status: rec.status });
        }
    }
    // branches named after the work item number are evidence of a child even without a record
    return [...out.values()];
}
// ── transitions ─────────────────────────────────────────────────────────────
const CODE = /\.(java|kt|ts|tsx|js|jsx|mjs|py|cs|go)$/;
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "else", "new", "synchronized", "try", "function"]);
const TRANSITIONS = [
    ["transfer", /transfer|reassign|handover|changeowner/i],
    ["create", /^(create|add|register|provision|onboard|bootstrap|insert)/i],
    ["enable/disable", /^(enable|disable|activate|deactivate|reactivate|suspend|lock|unlock|archive)/i],
    ["delete", /^(delete|remove|purge|destroy|drop|offboard)/i],
    ["restore", /^(restore|undelete|recover|unarchive)/i],
    ["import/migrate", /^(import|migrat|upload|ingest|seed|backfill)/i],
    ["bulk", /bulk|batch|many|all(?=[A-Z])/i],
    ["update", /^(update|edit|patch|save|modify|set(?!tings)|change|sync)/i],
];
const METHOD_JAVA = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|synchronized|abstract|default)\s+)*(?:[\w<>\[\],.? ]+?\s+)(\w+)\s*\(([^;{)]*)\)\s*(?:throws\s+[\w.,\s]+)?\{?\s*$/;
const METHOD_JS = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*(?:=\s*(?:async\s*)?)?\(([^)]*)\)\s*(?:=>|:\s*[^={]+)?\s*\{\s*$/;
function canon(name) {
    for (const [t, re] of TRANSITIONS)
        if (re.test(name))
            return t;
    return null;
}
function bodyOf(lines, start) {
    let depth = 0, seen = false;
    const out = [];
    for (let i = start; i < Math.min(lines.length, start + 220); i++) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === "{") {
                depth++;
                seen = true;
            }
            else if (ch === "}")
                depth--;
        }
        if (seen && depth <= 0)
            break;
    }
    return out;
}
function walkCode(dir, out, budget) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget.n <= 0)
            return;
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name) && !e.name.startsWith("."))
                walkCode(path.join(dir, e.name), out, budget);
        }
        else if (CODE.test(e.name)) {
            out.push(path.join(dir, e.name));
            budget.n--;
        }
    }
}
export function scanTransitions(root, entities, flags) {
    const files = [];
    walkCode(root, files, { n: 8000 });
    const flagWords = flags.flatMap((f) => [f, ...variantsOf(f)]).map((x) => x.toLowerCase());
    const rows = new Map();
    const row = (entity, transition) => {
        const k = entity + "|" + transition;
        if (!rows.has(k))
            rows.set(k, { entity, transition, sites: [], services: [], unguarded: [] });
        return rows.get(k);
    };
    for (const abs of files) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (TEST.test(rel))
            continue;
        let text;
        try {
            const st = fs.statSync(abs);
            if (st.size > 600_000)
                continue;
            text = fs.readFileSync(abs, "utf-8");
        }
        catch {
            continue;
        }
        const base = path.basename(rel).toLowerCase();
        const ents = entities.filter((e) => base.includes(e.toLowerCase().replace(/\s+/g, "")));
        if (!ents.length)
            continue;
        const service = rel.includes("/") ? rel.split("/")[0] : "(root)";
        const lines = text.split(/\r?\n/);
        const isJs = /\.(tsx?|jsx?|mjs)$/.test(rel);
        for (let i = 0; i < lines.length; i++) {
            const m = (isJs ? METHOD_JS : METHOD_JAVA).exec(lines[i]);
            if (!m || CONTROL.has(m[1]))
                continue;
            const name = m[1];
            const body = bodyOf(lines, i);
            const bodyText = body.join("\n");
            const bl = bodyText.toLowerCase();
            const mentionsFlag = flagWords.some((w) => bl.includes(w));
            const hits = [];
            const t = canon(name);
            if (t)
                hits.push(t);
            // transitions performed INSIDE a generic method: a status or membership write is a disable/enable or a membership change
            if (/\bset(Status|Active|Enabled|Disabled|State)\s*\(|\.status\s*=[^=]|\bstatus\s*=\s*[^=]/.test(bodyText) && !/^(get|is|find|map|to)/i.test(name))
                hits.push("status change");
            if (/\b(ensureGroups|setGroups|setMappedGroups|addToGroup|removeFromGroup|setRoles|setMembers|assignRole|addMember|removeMember)\s*\(/.test(bodyText))
                hits.push("membership change");
            for (const e of ents)
                for (const h of [...new Set(hits)]) {
                    const r = row(e, h);
                    const site = { service, file: rel, line: i + 1, method: name, text: lines[i].trim().slice(0, 140) };
                    r.sites.push(site);
                    if (!r.services.includes(service))
                        r.services.push(service);
                    if (flags.length && !mentionsFlag && h !== "create")
                        r.unguarded.push(site);
                }
        }
    }
    return { rows: [...rows.values()], files_scanned: files.length };
}
// ── the model ───────────────────────────────────────────────────────────────
export const CONTRACT_CLAUSES = ["ownership", "authority", "lifecycle", "consistency (source of truth)", "audit", "dependencies", "tenancy"];
export const ALL_TRANSITIONS = ["create", "update", "transfer", "enable/disable", "status change", "membership change", "delete", "restore", "import/migrate", "bulk"];
const WORKFLOW_TAGS = /^(backend|frontend|bug|feature|task|story|split-from-.*|(story|task|bug|us)-\d+)$/i;
const pascal = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
export function buildFeatureModel(root, opts) {
    const family = discoverFamily(root, opts.work_item_id);
    const notes = [];
    const entities = [];
    if (opts.entities?.length)
        for (const e of opts.entities)
            entities.push({ name: e, source: "given" });
    else {
        const reg = readJson(path.join(root, ".secufusion", "registry.json"));
        const tags = new Set();
        for (const f of family) {
            const it = (Array.isArray(reg) ? reg : []).find((x) => normId(String(x.work_item_id)) === f.id);
            for (const t of it?.tags ?? [])
                if (!WORKFLOW_TAGS.test(String(t)))
                    tags.add(String(t));
        }
        for (const t of tags)
            entities.push({ name: pascal(t), source: "proposed from tags (confirm)" });
        notes.push("Entities were PROPOSED from the work records' tags. Pass `entities` to name the primary business entities yourself; a wrong list gives a wrong matrix.");
    }
    const flags = opts.flags ?? [];
    const names = entities.map((e) => e.name);
    const { rows, files_scanned } = scanTransitions(root, names, flags);
    const missing = [];
    for (const e of names)
        for (const t of ALL_TRANSITIONS)
            if (!rows.some((r) => r.entity === e && r.transition === t))
                missing.push({ entity: e, transition: t });
    let impact = null;
    try {
        const text = [opts.story_text ?? "", ...family.map((f) => f.title)].join(" ");
        impact = inventoryEntityImpact(root, { terms: [...names, ...flags], flags, story_text: text, max_ranked: 20 });
    }
    catch (e) {
        notes.push(`Cross-service graph unavailable: ${e.message}`);
    }
    const AUTH = new Set(["AUTHORITY_COUPLING", "ADMIN_CHECK", "ROLE_OR_AUTHORITY_CHECK"]);
    const capability = (impact?.ranked_consumers ?? []).filter((c) => c.criticality === "CRITICAL" && c.categories.some((d) => AUTH.has(d)))
        .slice(0, 12).map((c) => ({ file: c.file, service: c.service, why: c.why, evidence: c.evidence[0] ? `${c.evidence[0].file.split("/").pop()}:${c.evidence[0].line}  ${c.evidence[0].text.slice(0, 110)}` : "" }));
    const graph = {
        services: (impact?.services ?? []).map((s) => ({ name: s.service, references: s.entity_files.length, authority_coupling: (s.deps.AUTHORITY_COUPLING ?? []).length })),
        copies: (impact?.ranked_consumers ?? []).filter((c) => c.also_in?.length).map((c) => ({ file: c.file, also_in: c.also_in })),
        without_references: impact?.services_without_references ?? [],
    };
    return { work_item_id: opts.work_item_id, family, entities, flags, transitions: rows, missing, capability, graph, impact, files_scanned, notes };
}
export function renderFeatureModel(m) {
    const L = [];
    L.push(`FEATURE MODEL: ${m.work_item_id}`, "Built from the work records and the code BEFORE judging the diff. Pattern-based and read-only: it builds the questions, you answer them.");
    L.push("", "## 1. Work item family");
    for (const f of m.family)
        L.push(`- ${f.id} [${f.role}] ${f.title}${f.status ? ` (${f.status})` : ""}  via ${f.via}`);
    if (m.family.length === 1)
        L.push("Only the item itself was found: no children or origin are recorded. Ask whether parent/child items exist elsewhere (ADO) before treating this scope as complete.");
    L.push("", "## 2. Primary business entities");
    for (const e of m.entities)
        L.push(`- ${e.name}  (${e.source})`);
    if (m.flags.length)
        L.push(`Flags that identify ownership or status: ${m.flags.join(", ")}`);
    L.push("", "## 3. Lifecycle transitions that exist (file:line), and whether the method ever mentions the flag");
    const byEntity = new Map();
    for (const r of m.transitions)
        byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);
    for (const [e, rs] of byEntity) {
        L.push(`### ${e}`);
        for (const r of rs.sort((a, b) => a.transition.localeCompare(b.transition))) {
            const un = r.unguarded.length;
            L.push(`- ${r.transition}: ${r.sites.length} method(s) in ${r.services.join(", ")}${m.flags.length ? `; ${un ? `${un} NEVER mention ${m.flags.join("/")}` : "all mention the flag"}` : ""}`);
            for (const s of r.sites.slice(0, 4))
                L.push(`    ${s.file}:${s.line}  ${s.method}${r.unguarded.includes(s) ? "   <- does not mention the flag" : ""}`);
            if (r.sites.length > 4)
                L.push(`    ...and ${r.sites.length - 4} more`);
        }
    }
    L.push("", "## 4. Transitions with NO path found (a lifecycle question: what state results, or is it implemented elsewhere?)");
    if (!m.missing.length)
        L.push("None: every transition has at least one path.");
    for (const x of m.missing)
        L.push(`- ${x.entity}: ${x.transition}`);
    L.push("", "## 5. Capability dependencies (code that decides authority from the entity or flag)");
    if (!m.capability.length)
        L.push("None found, or the cross-service scan did not run.");
    for (const c of m.capability)
        L.push(`- ${c.service}/${c.file.split("/").pop()}: ${c.why}\n    ${c.evidence}`);
    L.push("", "## 6. Cross-service dependency graph");
    for (const s of m.graph.services)
        L.push(`- ${s.name}: ${s.references} referencing file(s), ${s.authority_coupling} authority coupling`);
    if (m.graph.without_references.length)
        L.push(`No references: ${m.graph.without_references.join(", ")} (absence of a hit is not proof of absence)`);
    for (const c of m.graph.copies)
        L.push(`- COPIED RULE ${c.file.split("/").pop()} also in ${c.also_in.join(", ")}: check the copies agree`);
    L.push("", "## 7. Review matrix: every transition against every contract clause");
    L.push(`Clauses: ${CONTRACT_CLAUSES.join(" | ")}`);
    for (const r of m.transitions)
        L.push(`- [ ] ${r.entity} / ${r.transition} (${r.sites.length} path(s)${r.unguarded.length ? `, ${r.unguarded.length} without the flag` : ""}): check against ${CONTRACT_CLAUSES.join(", ")}`);
    for (const x of m.missing)
        L.push(`- [ ] ${x.entity} / ${x.transition} (NO PATH): what state does the entity end up in, and is that supported?`);
    for (const n of m.notes)
        L.push("", `Note: ${n}`);
    L.push("", `Scanned ${m.files_scanned} code files. A transition marked "does not mention the flag" is a lead: it may still be protected by a caller or an authorizer. Read it before you call it a finding.`);
    return L.join("\n");
}

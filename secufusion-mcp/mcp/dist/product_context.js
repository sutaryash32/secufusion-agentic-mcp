/**
 * Product context: what THIS product requires of a change, pulled from what the project already knows.
 *
 * A generic list of edge cases is a checklist. The edges that hurt are product edges: "exactly one IT Admin per tenant",
 * "the previous owner keeps their groups", "a status change inside a generic update bypasses the guard", "this authorizer
 * reads the same flag the change rewrites". This module turns the project's own memory into questions about the change:
 *   - the project knowledge in .mcp/ (invariants, decisions, lessons learned, known exceptions, architecture) that applies to
 *     the story's terms and the entry points, with its status (accepted is authoritative, proposed is a hint);
 *   - the lifecycle transitions that EXIST for the entities in the code (with file:line), which of them never mention the
 *     flag, and the ones that do not exist (a missing path is a lifecycle question);
 *   - the authorization decisions elsewhere in the workspace that read the same fields (authority coupling), ranked by
 *     criticality, and rules copied across services;
 *   - what the story is SILENT about: transitions that exist for its entities and that it never mentions.
 * Every question names its source. It builds questions and evidence; it never answers them: the reviewer reasons, and the
 * answer is verified against the code. READ-ONLY.
 */
import { loadKnowledge, queryKnowledge } from "./project_knowledge.js";
import { scanTransitions, ALL_TRANSITIONS } from "./feature_model.js";
import { inventoryEntityImpact } from "./entity_impact.js";
const CATS = ["invariants", "decisions", "lessons-learned", "known-exceptions", "architecture", "patterns", "operational"];
const hint = (e) => (e.status === "accepted" ? "accepted" : e.status === "proposed" ? "proposed: a hint, not a rule" : e.status);
const one = (v) => (Array.isArray(v) ? v.join(", ") : v ?? "");
const MAX_PER_KIND = 25;
function relevantKnowledge(root, o) {
    const model = loadKnowledge(root);
    if (!model.exists)
        return { hits: [], exists: false };
    const terms = [...(o.terms ?? []), ...(o.entities ?? []), ...(o.flags ?? []), ...o.entries.map((e) => e.name), (o.story_text ?? "").slice(0, 700)].filter(Boolean);
    const hits = queryKnowledge(model.entries, { terms, files: o.files, categories: CATS, limit: 30 }).map((s) => s.entry);
    return { hits, exists: true };
}
export function gatherProductCells(root, o) {
    const cells = [];
    const used = [];
    const notes = [];
    const entryNames = o.entries.length ? o.entries.map((e) => e.name) : ["the change"];
    // ---- 1. what the project already knows
    try {
        const { hits, exists } = relevantKnowledge(root, o);
        if (!exists)
            notes.push("no .mcp/ project knowledge exists: product cells come from the code only (a knowledge gap: record the invariants, decisions and lessons so the next review does not start blind)");
        const per = {};
        for (const k of hits) {
            used.push({ id: k.id, category: k.category, status: k.status, file: k.file });
            per[k.category] = (per[k.category] ?? 0) + 1;
            if (per[k.category] > MAX_PER_KIND)
                continue;
            const acc = k.status === "accepted";
            for (const en of entryNames) {
                const src = `${k.file} (${k.status})`;
                if (k.category === "invariants") {
                    const enf = one(k.extra?.enforcement), wp = one(k.extra?.write_paths), fl = one(k.extra?.fields);
                    cells.push({ entry: en, area: `invariant ${k.id}`, origin: "PRODUCT", risk: acc ? 9 : 6, source: src,
                        edge: `Does "${k.title}" still hold after ${en}?${fl ? ` Fields: ${fl}.` : ""}${enf ? ` Recorded enforcement: ${enf}.` : " No enforcement is recorded."}${wp ? ` Known write paths: ${wp}.` : ""} Find every path that can break it, not only the one in the story.`,
                        why: `${hint(k)} invariant from ${k.source}` });
                }
                else if (k.category === "decisions") {
                    const g = one(k.extra?.guardrail);
                    cells.push({ entry: en, area: `decision ${k.id}`, origin: "PRODUCT", risk: acc ? 8 : 5, source: src,
                        edge: `Does ${en} honour the decision "${k.title}"?${g ? ` Its guardrail: ${g}.` : ""} Could any path bypass, weaken or duplicate it?`, why: `${hint(k)} decision from ${k.source}` });
                }
                else if (k.category === "lessons-learned") {
                    cells.push({ entry: en, area: `lesson ${k.id}`, origin: "PRODUCT", risk: acc ? 8 : 6, source: src,
                        edge: `Does ${en} repeat what was learned: "${k.title}"? Compare the change with what went wrong before.`, why: `${hint(k)} lesson from ${k.source}` });
                }
                else if (k.category === "known-exceptions") {
                    cells.push({ entry: en, area: `known exception ${k.id}`, origin: "PRODUCT", risk: 5, source: src,
                        edge: `Is the behaviour around ${en} the intentional exception "${k.title}", or an accident that only looks like it? (An accepted exception is not a defect.)`, why: `${hint(k)} exception from ${k.source}` });
                }
                else {
                    cells.push({ entry: en, area: `${k.category} ${k.id}`, origin: "PRODUCT", risk: acc ? 5 : 4, source: src,
                        edge: `Does ${en} respect "${k.title}"?`, why: `${hint(k)} ${k.category} from ${k.source}` });
                }
            }
        }
    }
    catch (e) {
        notes.push(`project knowledge could not be read: ${e.message.split("\n")[0]}`);
    }
    // ---- 2. lifecycle transitions that exist, and the ones that do not
    const entities = (o.entities ?? []).filter(Boolean);
    const flags = (o.flags ?? []).filter(Boolean);
    if (entities.length) {
        try {
            const { rows, files_scanned } = scanTransitions(root, entities, flags);
            if (!files_scanned)
                notes.push("no source files were found to scan for lifecycle transitions");
            for (const r of rows) {
                for (const s of r.sites.slice(0, 3)) {
                    const unguarded = r.unguarded.some((u) => u.file === s.file && u.line === s.line);
                    for (const en of entryNames)
                        cells.push({ entry: en, area: `lifecycle ${r.entity}.${r.transition}`, origin: "CODE", risk: unguarded ? 9 : 6, source: `${s.file}:${s.line}`,
                            edge: `${r.transition} of ${r.entity} exists at ${s.file}:${s.line} (${s.method}).${unguarded ? ` It never mentions ${flags.join(" / ")}: what stops it from breaking the invariant?` : ` Does it still preserve ${flags.length ? flags.join(" / ") : "the entity's invariants"} when combined with ${en}?`} Another way in: import, admin tool, cascade, scheduler, direct SQL.`,
                            why: unguarded ? `a method that performs ${r.transition} on ${r.entity} and never mentions ${flags.join(" / ")}` : `an existing path to ${r.transition} ${r.entity}` });
                }
            }
            // an absent path can only be claimed when something was actually scanned
            if (files_scanned)
                for (const e of entities)
                    for (const t of ["transfer", "delete", "enable/disable", "status change", "membership change", "restore"]) {
                        if (!ALL_TRANSITIONS.includes(t))
                            continue;
                        if (rows.some((r) => r.entity === e && r.transition === t))
                            continue;
                        for (const en of entryNames)
                            cells.push({ entry: en, area: `lifecycle ${e}.${t}`, origin: "CODE", risk: t === "delete" || t === "transfer" ? 7 : 6, source: `scan of ${files_scanned} file(s)`,
                                edge: `No ${t} path for ${e} was found in the workspace. If it happens another way (another service, a bulk job, SQL, a cascade), what state results? Is that state supported?`, why: "an absent path is a lifecycle question, not a clean bill" });
                    }
        }
        catch (e) {
            notes.push(`lifecycle scan failed: ${e.message.split("\n")[0]}`);
        }
    }
    else
        notes.push("no `entities` were given: lifecycle paths were not scanned. Name the primary business entities of the change to get them");
    // ---- 3. authorization decisions elsewhere that read the same fields
    if (entities.length || flags.length) {
        try {
            const imp = inventoryEntityImpact(root, { terms: [...entities, ...flags], flags, story_text: o.story_text, max_ranked: 8, max_hits: 3 });
            for (const c of imp.ranked_consumers.filter((x) => x.criticality === "CRITICAL").slice(0, 6)) {
                const ev = c.evidence[0];
                for (const en of entryNames)
                    cells.push({ entry: en, area: "authority consumer", origin: "CODE", risk: 9, source: ev ? `${ev.file}:${ev.line}` : c.file,
                        edge: `${c.file} (${c.service}) reads ${flags.length ? flags.join(" / ") : entities.join(" / ")} inside an authorization decision${ev ? ` (${ev.file}:${ev.line}: ${ev.text.slice(0, 80)})` : ""}. After ${en}, is what that decision assumes still true? Who gains or loses authority?`,
                        why: c.why });
                if (c.also_in?.length)
                    for (const en of entryNames)
                        cells.push({ entry: en, area: "copied rule", origin: "CODE", risk: 7, source: c.file, edge: `The rule in ${c.file} is copied in ${c.also_in.join(", ")}. If ${en} changes one copy, do the others drift?`, why: "a rule copied across services" });
            }
        }
        catch (e) {
            notes.push(`authority-coupling scan failed: ${e.message.split("\n")[0]}`);
        }
    }
    return { cells, knowledge_used: used, notes };
}
const SYN = {
    create: /\b(creat\w*|add\w*|new|register\w*|onboard\w*)\b/i,
    update: /\b(updat\w*|edit\w*|modif\w*|chang\w*)\b/i,
    transfer: /\b(transfer\w*|hand ?over|reassign\w*|promot\w*|demot\w*|chang\w* (?:the )?owner)\b/i,
    "enable/disable": /\b(enabl\w*|disabl\w*|activat\w*|deactivat\w*|suspend\w*|reactivat\w*)\b/i,
    "status change": /\b(status|state|archiv\w*)\b/i,
    "membership change": /\b(member\w*|group\w*|role\w*|assign\w*)\b/i,
    delete: /\b(delet\w*|remov\w*|purg\w*|deprovision\w*|destroy\w*)\b/i,
    restore: /\b(restor\w*|recover\w*|undelete\w*)\b/i,
    "import/migrate": /\b(import\w*|migrat\w*|backfill\w*|sync\w*)\b/i,
    bulk: /\b(bulk|batch\w*|mass|all (?:users|tenants|devices))\b/i,
};
/** Claims the story does NOT make but the product does: recorded invariants and decisions, and lifecycle paths the story is silent about. */
export function gatherImpliedClaims(root, o) {
    const claims = [];
    const notes = [];
    try {
        const { hits, exists } = relevantKnowledge(root, o);
        if (!exists)
            notes.push("no .mcp/ project knowledge exists: implied product claims could not be drawn from it");
        for (const k of hits.filter((h) => h.category === "invariants" || h.category === "decisions").slice(0, 12)) {
            claims.push({ kind: "implied", source: `${k.file} (${k.status})`,
                text: k.category === "invariants" ? `The product invariant "${k.title}" still holds after this change.` : `The change honours the recorded decision "${k.title}".` });
        }
    }
    catch (e) {
        notes.push(`project knowledge could not be read: ${e.message.split("\n")[0]}`);
    }
    const story = o.story_text ?? "";
    if (o.entities?.length && story) {
        try {
            const { rows } = scanTransitions(root, o.entities, o.flags ?? []);
            for (const r of rows) {
                const re = SYN[r.transition];
                if (!re || re.test(story) || !r.sites.length)
                    continue;
                if (claims.filter((c) => c.kind === "silent").length >= 8)
                    break;
                const s = r.sites[0];
                claims.push({ kind: "silent", source: `${s.file}:${s.line}`, text: `The story says nothing about ${r.entity} ${r.transition}, which exists at ${s.file}:${s.line} (${s.method}). State what this change must do to it, or that it must not be touched.` });
            }
        }
        catch (e) {
            notes.push(`lifecycle scan failed: ${e.message.split("\n")[0]}`);
        }
    }
    return { claims, notes };
}

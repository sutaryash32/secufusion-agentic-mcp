/**
 * Review maturity: knowing when a review can be trusted, and what the project already decided.
 *
 *   1. Decision registry: decisions a person made (UD-n) are kept in .mcp/decisions/ and also harvested, read-only,
 *      from the work records (.secufusion/tasks/<id>/decisions.json and answered user decisions in
 *      .secufusion/requirements/). For a change, the relevant decisions are surfaced with deterministic SIGNALS
 *      (a guardrail line removed, a new writer of a field a decision protects, a decision with unconfirmed assumptions).
 *      The tool never says a change ALIGNS: the reviewer judges ALIGNS / VIOLATES / PARTIALLY ALIGNS / UNVERIFIED.
 *   2. Invariant catalog: invariants live in .mcp/invariants/ (domain, fields, source, enforcement). For a review the
 *      relevant ones are retrieved and classified CONFIRMED / PROPOSED / VIOLATED / NOT DEMONSTRATED from their status
 *      and from real enforcement evidence (check_invariant_enforcement logic). Knowledge is suggested, never invented.
 *   3. Review confidence: HIGH / MEDIUM / LOW from the evidence the review actually has, with hard caps. "No findings"
 *      is not "trustworthy"; this separates the two.
 */
import fs from "fs";
import path from "path";
import { loadKnowledge, queryKnowledge } from "./project_knowledge.js";
import { mapInvariantEnforcement, variantsOf } from "./invariant_enforcement.js";
import { git, gitTop, pickBase } from "./diff_quality.js";
const UD = /\bUD-\d+(?:\s*(?:and|,|\/|&)\s*UD-\d+|\s+[A-Z]\b)*/g;
// an identifier is something searchable in code: camelCase, snake_case, dotted, an endpoint, a quoted code token
const IDENT = [
    /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g,
    /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g,
    /\b[A-Za-z]+\.[a-z][A-Za-z]+\b/g,
    /\/[a-z][\w{}\-/]*\/[\w{}\-/]+/g,
    /`([^`\n]{3,60})`/g,
];
const CUE = /\b(must not|cannot|can not|may not|never|prohibit(?:ed|s)?|forbid(?:den|s)?|only|exactly one|at most|not editable|cannot be changed|returns? (?:409|400|403)|separate|same (?:transaction|tenant|domain)|no backfill|intentional)\b/gi;
const STOP_IDENT = new Set(["e.g", "i.e", "etc"]);
function identifiersOf(text) {
    const out = new Set();
    for (const re of IDENT) {
        for (const m of text.matchAll(re)) {
            const v = (m[1] ?? m[0]).trim();
            if (v.length >= 4 && !STOP_IDENT.has(v.toLowerCase()) && !/^\d/.test(v) && !/^(https?|www)/i.test(v))
                out.add(v);
        }
    }
    return [...out];
}
function refsOf(text) {
    const refs = new Set();
    for (const m of text.matchAll(UD))
        for (const r of m[0].matchAll(/UD-\d+/g))
            refs.add(r[0]);
    return [...refs];
}
const cuesOf = (text) => [...new Set([...text.matchAll(CUE)].map((m) => m[0].toLowerCase()))];
const unconfirmedOf = (text) => [...text.matchAll(/(assumptions? awaiting confirmation|awaiting confirmation|not yet confirmed|to be confirmed|\bTBD\b)[^.]*\.?/gi)].map((m) => m[0].trim().slice(0, 200));
function readJson(p) { try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""));
}
catch {
    return null;
} }
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
function fromEntry(e) {
    const x = e.extra ?? {};
    const asArr = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
    const text = `${e.title}. ${e.body}`;
    return {
        ref: String(x.ref ?? e.id), refs: [String(x.ref ?? e.id)], text: text.replace(/\s+/g, " ").trim().slice(0, 700),
        status: e.status === "accepted" ? "ACCEPTED" : "PROPOSED", origin: "registry", source: e.source, file: e.file,
        identifiers: [...new Set([...asArr(x.guardrail), ...identifiersOf(text)])], guardrail: asArr(x.guardrail), cues: cuesOf(text), unconfirmed: unconfirmedOf(text),
    };
}
/** Every decision the project has recorded: the registry first, then the work records. Read-only. */
export function loadDecisions(workspaceRoot) {
    const out = [];
    for (const e of loadKnowledge(workspaceRoot).entries) {
        if (e.category !== "decisions" || e.status === "superseded" || e.status === "deprecated")
            continue;
        out.push(fromEntry(e));
    }
    const seen = new Set(out.map((d) => norm(d.text)));
    const push = (d) => { const k = norm(d.text); if (seen.has(k))
        return; seen.add(k); out.push(d); };
    const reqDir = path.join(workspaceRoot, ".secufusion", "requirements");
    if (fs.existsSync(reqDir)) {
        for (const f of fs.readdirSync(reqDir).filter((n) => n.endsWith(".json"))) {
            const req = readJson(path.join(reqDir, f));
            for (const ud of req?.user_decisions ?? []) {
                if (ud.state !== "ANSWERED" || !ud.user_statement)
                    continue;
                const text = `${ud.question} -> ${ud.answer ?? ""}. User: "${ud.user_statement}"`;
                push({
                    ref: `${f.replace(/\.json$/, "")}:${ud.id}`, refs: [ud.id], text: text.replace(/\s+/g, " ").slice(0, 700), status: "USER-ANSWERED", origin: "requirement",
                    source: `.secufusion/requirements/${f}`, file: `.secufusion/requirements/${f}`, identifiers: identifiersOf(text), guardrail: [], cues: cuesOf(text), unconfirmed: unconfirmedOf(text),
                });
            }
        }
    }
    const tasks = path.join(workspaceRoot, ".secufusion", "tasks");
    if (fs.existsSync(tasks)) {
        for (const d of fs.readdirSync(tasks, { withFileTypes: true }).filter((x) => x.isDirectory())) {
            const list = readJson(path.join(tasks, d.name, "decisions.json"));
            if (!Array.isArray(list))
                continue;
            for (const rec of list) {
                const decision = String(rec.decision ?? "");
                if (!decision)
                    continue;
                const text = `${decision}${rec.rationale ? ` Why: ${rec.rationale}` : ""}`;
                const refs = refsOf(decision);
                const userSaid = /user (statement|answer|decision)s?|business decision|recorded user decisions?/i.test(String(rec.rationale ?? "") + " " + decision);
                push({
                    ref: refs.length ? refs.join("/") : `${d.name.split("-").slice(0, 2).join("-")}#${rec.id}`, refs,
                    text: text.replace(/\s+/g, " ").slice(0, 900), status: userSaid ? "USER-ANSWERED" : "RECORDED", origin: "task-record",
                    source: `.secufusion/tasks/${d.name}/decisions.json`, file: `.secufusion/tasks/${d.name}/decisions.json`,
                    identifiers: identifiersOf(decision), guardrail: [], cues: cuesOf(decision), unconfirmed: unconfirmedOf(text),
                });
            }
        }
    }
    return out;
}
export function collectChange(workspaceRoot, opts) {
    const ctx = { terms: opts.terms ?? [], files: opts.files ?? [], added: [], removed: [], base: null, repo: null };
    let diff = opts.diff_text ?? "";
    if (!diff) {
        const top = gitTop(workspaceRoot);
        if (top) {
            const b = pickBase(top, opts.base);
            ctx.base = b.base;
            ctx.repo = top;
            diff = (git(top, ["diff", "--no-renames", "-U0", b.base]) ?? "");
            const names = (git(top, ["diff", "--name-only", "--no-renames", b.base]) ?? "").split(/\r?\n/).filter(Boolean);
            ctx.files = [...new Set([...ctx.files, ...names])];
        }
    }
    let file = "", ln = 0, rn = 0;
    for (const raw of diff.split(/\r?\n/)) {
        const h = /^\+\+\+ b\/(.+)$/.exec(raw);
        if (h) {
            file = h[1];
            continue;
        }
        if (/^--- /.test(raw))
            continue;
        const hh = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
        if (hh) {
            rn = Number(hh[1]);
            ln = Number(hh[2]);
            continue;
        }
        if (raw.startsWith("+")) {
            ctx.added.push({ file, line: ln++, text: raw.slice(1) });
        }
        else if (raw.startsWith("-")) {
            ctx.removed.push({ file, line: rn++, text: raw.slice(1) });
        }
    }
    return ctx;
}
const TEST_FILE = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt)$/;
const NOT_CODE = /^\s*(\*|\/\/|\/\*|@|#|import\b|log\.|logger\.|console\.)/;
const GENERIC_IDENT = new Set(["userId", "tenantId", "userName", "newOwnerUserId", "getAllUsers", "isAdmin", "Tenant.email"].map((x) => x.toLowerCase()));
const reEsc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does this added line WRITE the identifier: a setter, an assignment to it, or SQL that sets it? Not a read, an annotation, a log or a comment. */
function writesIdent(line, id) {
    if (NOT_CODE.test(line) || /\b\w*(dto|Dto|response|Response|request|Request|payload|builder|Builder)\w*\s*\.\s*set/.test(line))
        return false; // a mapper filling a DTO is a read of the field, not a writer
    const vs = [...new Set([id, ...variantsOf(id)])].filter((v) => v.length >= 4);
    return vs.some((v) => {
        const cap = v.charAt(0).toUpperCase() + v.slice(1);
        return new RegExp(`\\.set${reEsc(cap)}\\s*\\(|(^|[\\s.(,])${reEsc(v)}\\s*=(?!=)|\\bSET\\b[^;]*\\b${reEsc(v)}\\b`, "i").test(line);
    });
}
const ev = (l) => `${l.file}:${l.line}  ${l.text.trim().slice(0, 140)}`;
const hasIdent = (text, id) => { const t = text.toLowerCase(); return [id, ...variantsOf(id)].some((v) => v.length >= 4 && t.includes(v.toLowerCase())); }; // isDefaultUser() reads defaultUser
/** Which decisions does this change touch, and which deterministic warning signs does it show? Never a verdict. */
export function checkDecisionAlignment(decisions, ctx) {
    const changeText = [...ctx.added, ...ctx.removed].map((l) => l.text).join("\n");
    const termText = ctx.terms.join(" ").toLowerCase();
    const testsTouched = ctx.files.some((f) => TEST_FILE.test(f));
    const out = [];
    for (const d of decisions) {
        const matched = [];
        const touched = [];
        for (const id of d.identifiers) {
            if (GENERIC_IDENT.has(id.toLowerCase()))
                continue;
            const inDiff = hasIdent(changeText, id);
            const inTerms = termText.includes(id.toLowerCase());
            const inFiles = ctx.files.some((f) => f.toLowerCase().includes(id.toLowerCase()));
            if (inDiff || inTerms || inFiles) {
                matched.push(id);
                if (inDiff)
                    for (const l of [...ctx.added, ...ctx.removed])
                        if (hasIdent(l.text, id) && touched.length < 6)
                            touched.push(ev(l));
            }
        }
        // a decision a person named by reference (UD-1) is relevant when the terms cite it
        for (const r of d.refs)
            if (r && ctx.terms.some((t) => t.toUpperCase().includes(r.toUpperCase())))
                matched.push(r);
        if (!matched.length)
            continue;
        const signals = [];
        const guardIds = d.guardrail.length ? d.guardrail : d.identifiers;
        const restrictive = d.cues.some((c) => /must not|cannot|can not|may not|never|prohibit|forbid|not editable|returns?|exactly one|at most|only/.test(c));
        if (restrictive) {
            const removed = ctx.removed.filter((l) => guardIds.some((g) => hasIdent(l.text, g)) && /(throw|reject|return|if\s*\(|assert|forbid|denied|409|400|403|unique|lock)/i.test(l.text));
            if (removed.length)
                signals.push({ kind: "GUARDRAIL_REMOVED", detail: "a line that looks like a check or rejection on a field this decision protects was removed", evidence: removed.slice(0, 4).map(ev) });
        }
        const writers = ctx.added.filter((l) => !TEST_FILE.test(l.file) && d.identifiers.some((g) => !GENERIC_IDENT.has(g.toLowerCase()) && writesIdent(l.text, g)));
        if (writers.length)
            signals.push({ kind: "NEW_WRITER", detail: "new code writes a field this decision names: a second writer is a second source of truth unless it goes through the same rule", evidence: writers.slice(0, 4).map(ev) });
        if (d.unconfirmed.length)
            signals.push({ kind: "UNCONFIRMED_ASSUMPTION", detail: "the decision itself records an assumption nobody confirmed", evidence: d.unconfirmed.slice(0, 2) });
        if (touched.length && !testsTouched)
            signals.push({ kind: "NO_TEST_CHANGE", detail: "code touching this decision changed and no test file changed in the diff", evidence: [] });
        if (!signals.length)
            signals.push({ kind: "TOUCHED", detail: "the change touches this decision's subject; no deterministic warning sign", evidence: touched.slice(0, 2) });
        out.push({ decision: d, matched_on: [...new Set(matched)].slice(0, 6), signals, touched });
    }
    const weight = (c) => c.signals.reduce((n, s) => n + (s.kind === "GUARDRAIL_REMOVED" ? 5 : s.kind === "NEW_WRITER" ? 4 : s.kind === "UNCONFIRMED_ASSUMPTION" ? 2 : s.kind === "NO_TEST_CHANGE" ? 1 : 0), c.matched_on.length * 0.1);
    return out.sort((a, b) => weight(b) - weight(a)).slice(0, 12);
}
export function renderDecisionAlignment(checks, total, ctx) {
    const L = [];
    L.push(`DECISION ALIGNMENT: ${total} recorded decision(s) in the registry and work records; ${checks.length} touched by this change${ctx.base ? ` (diff against ${ctx.base})` : ""}.`);
    if (!total)
        L.push("No decisions are recorded. Absence of decisions is not absence of constraints: ask the user, and record what they confirm (record_project_knowledge category=decisions, status=accepted with their words).");
    const shown = new Map();
    for (const c of checks) {
        const d = c.decision;
        L.push("", `### ${d.ref}  [${d.status}]  ${d.origin === "registry" ? "registry" : d.origin}`);
        L.push(d.text.length > 420 ? d.text.slice(0, 420) + "..." : d.text);
        L.push(`Source: ${d.source}`, `Matched on: ${c.matched_on.join(", ")}`);
        for (const s of c.signals) {
            L.push(`- SIGNAL ${s.kind}: ${s.detail}`);
            const key = s.kind + "|" + s.evidence.join("|");
            if (s.evidence.length && shown.has(key)) {
                L.push(`    (same evidence as ${shown.get(key)})`);
                continue;
            }
            if (s.evidence.length)
                shown.set(key, d.ref);
            for (const e of s.evidence)
                L.push(`    ${e}`);
        }
        L.push("Judge: ALIGNS / VIOLATES / PARTIALLY ALIGNS / UNVERIFIED. Does the change contradict it? weaken it? add a second source of truth? bypass its guardrail? Cite file:line. UNVERIFIED when you cannot show it either way.");
    }
    if (!checks.length && total)
        L.push("", "No recorded decision is touched by the identifiers in this diff. That is not proof of alignment: decisions are matched by shared identifiers, so a decision phrased in other words is invisible here. Ask what the change relies on.");
    L.push("", "These are signals, not verdicts. A decision recorded in a work record is RECORDED knowledge, not ACCEPTED: only a person accepting it in the registry makes it a project rule.");
    return L.join("\n");
}
const asList = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
export function enforcementTypes(f) {
    const t = [];
    if (f.db.length)
        t.push("DB");
    if (f.locks.length && !f.unprotected_writes.length)
        t.push("LOCK");
    else if (f.locks.length)
        t.push("LOCK(partial)");
    if (f.concurrency_tests.length)
        t.push("TEST");
    if (!t.length)
        t.push("CODE");
    return t;
}
export function classify(status, f, violated, declared = []) {
    const reasons = [];
    if (violated)
        return { cls: "VIOLATED", reasons: ["the reviewer found a concrete violation (file:line evidence in the review)"] };
    if (status !== "accepted") {
        reasons.push(`status is ${status}: nobody has confirmed this invariant`);
        return { cls: "PROPOSED", reasons };
    }
    if (!f) {
        reasons.push("accepted, but no field is declared so enforcement was not examined");
        return { cls: "NOT DEMONSTRATED", reasons };
    }
    const strong = f.strength === "DB_ENFORCED" || f.strength === "LOCK_PROTECTED";
    // a constraint or lock on a FIELD proves a cardinality/exclusion rule; it proves nothing about a rule enforced only in code (equality, consistency, prohibition)
    const needsDbOrLock = declared.length === 0 || declared.some((x) => /^(DB|LOCK)$/i.test(x));
    if (strong && !needsDbOrLock) {
        reasons.push(`field-level ${f.strength} found, but this invariant is declared as enforced by ${declared.join("/")}: a constraint or lock on the field does not prove it; cite a test or the code path`);
        return { cls: "NOT DEMONSTRATED", reasons };
    }
    if (strong) {
        reasons.push(`enforcement ${f.strength}`);
        return { cls: "CONFIRMED", reasons };
    }
    reasons.push(`accepted rule, but enforcement is ${f.strength}: ${f.reasons[0] ?? "no constraint or lock found"}`);
    if (f.unprotected_writes.length)
        reasons.push(`${f.unprotected_writes.length} write(s) outside any lock or constraint`);
    return { cls: "NOT DEMONSTRATED", reasons };
}
export function relevantInvariants(workspaceRoot, opts) {
    const entries = loadKnowledge(workspaceRoot).entries.filter((e) => e.category === "invariants" && e.status !== "superseded" && e.status !== "deprecated");
    const wantFields = (opts.fields ?? []).map((f) => f.toLowerCase());
    const hits = new Map();
    for (const s of queryKnowledge(entries, { terms: opts.terms, files: opts.files, categories: ["invariants"], limit: 12 }))
        hits.set(s.entry.id, { e: s.entry, on: s.why });
    for (const e of entries) {
        const f = asList(e.extra?.fields).filter((x) => wantFields.some((w) => w === x.toLowerCase() || variantsOf(x).some((v) => v.toLowerCase() === w)));
        if (f.length) {
            const h = hits.get(e.id) ?? { e, on: [] };
            h.on.push(`field ${f.join(", ")}`);
            hits.set(e.id, h);
        }
        if (opts.domains?.some((d) => d.toLowerCase() === String(e.extra?.domain ?? "").toLowerCase())) {
            const h = hits.get(e.id) ?? { e, on: [] };
            h.on.push(`domain ${e.extra?.domain}`);
            hits.set(e.id, h);
        }
    }
    const items = [];
    for (const { e, on } of hits.values()) {
        const fields = asList(e.extra?.fields);
        let enf = null;
        let scanned = false;
        if (fields.length && opts.scan !== false) {
            try {
                const rep = mapInvariantEnforcement(opts.code_root ?? workspaceRoot, { fields: fields.slice(0, 8), max_hits: 8 });
                // the weakest of the invariant's fields decides
                const order = ["NO_WRITES_FOUND", "CODE_ONLY", "CHECK_THEN_ACT", "LOCK_PROTECTED", "DB_ENFORCED"];
                enf = [...rep.fields].sort((a, b) => order.indexOf(a.strength) - order.indexOf(b.strength))[0] ?? null;
                scanned = true;
            }
            catch { /* unreadable root: leave NOT DEMONSTRATED */ }
        }
        const { cls, reasons } = classify(e.status, enf, !!opts.violated?.includes(e.id), asList(e.extra?.enforcement));
        items.push({
            id: e.id, title: e.title, domain: String(e.extra?.domain ?? "General"), status: e.status, classification: cls,
            source: `${e.extra?.ref ? e.extra.ref + "; " : ""}${e.source}`, file: e.file, fields, declared_enforcement: asList(e.extra?.enforcement),
            enforcement_types: enf ? enforcementTypes(enf) : [], strength: enf?.strength ?? null,
            write_paths: enf ? enf.writes.slice(0, 8).map((w) => ({ where: `${w.file}:${w.line}`, protected: !enf.unprotected_writes.some((u) => u.file === w.file && u.line === w.line) })) : asList(e.extra?.write_paths).map((w) => ({ where: w, protected: false })),
            reasons, matched_on: [...new Set(on)].slice(0, 4), scanned,
        });
    }
    const rank = { VIOLATED: 0, "NOT DEMONSTRATED": 1, PROPOSED: 2, CONFIRMED: 3 };
    items.sort((a, b) => rank[a.classification] - rank[b.classification] || a.id.localeCompare(b.id));
    return { items, catalog_size: entries.length };
}
/** Invariant CANDIDATES from recorded decisions: suggestions a person must accept, never records. */
export function candidateInvariants(decisions) {
    const out = [];
    for (const d of decisions) {
        for (const s of d.text.split(/(?<=[.;])\s+/)) {
            if (/\b(exactly one|at most one|only one|must not|cannot be|prohibited|never)\b/i.test(s) && !/\?/.test(s) && s.length > 25 && s.length < 320) {
                out.push({ from: d.ref, text: s.trim(), fields: identifiersOf(s).slice(0, 4) });
            }
        }
    }
    return out.slice(0, 10);
}
export function renderInvariants(r, candidates = []) {
    const L = [];
    L.push(`INVARIANT CATALOG: ${r.catalog_size} invariant(s) in .mcp/invariants/; ${r.items.length} relevant to this change.`);
    if (!r.catalog_size)
        L.push("The catalog is empty. Nothing was rediscovered from memory; every invariant this review relies on is inferred. Record confirmed ones with record_project_knowledge category=invariants.");
    const byDomain = new Map();
    for (const i of r.items)
        byDomain.set(i.domain, [...(byDomain.get(i.domain) ?? []), i]);
    for (const [dom, list] of byDomain) {
        L.push("", `## ${dom}`);
        for (const i of list) {
            L.push(`- ${i.id}: ${i.title}`, `    CLASSIFICATION: ${i.classification}   (status ${i.status})`, `    SOURCE: ${i.source}`);
            L.push(`    EVIDENCE: ${i.reasons.join("; ")}${i.scanned ? "" : i.fields.length ? "; fields not scanned" : ""}`);
            L.push(`    ENFORCEMENT TYPE: ${i.enforcement_types.length ? i.enforcement_types.join(" + ") : "unknown (not scanned)"}${i.declared_enforcement.length ? `   declared: ${i.declared_enforcement.join("/")}` : ""}${i.strength ? `   rating: ${i.strength}` : ""}`);
            if (i.write_paths.length)
                L.push(`    WRITE PATHS: ${i.write_paths.map((w) => `${w.where}${w.protected ? " [protected]" : " [UNPROTECTED]"}`).join("; ")}`);
            L.push(`    Matched on: ${i.matched_on.join("; ") || "domain"}`);
        }
    }
    if (candidates.length) {
        L.push("", "## Candidates (SUGGESTED, not in the catalog; a person must confirm before they are recorded)");
        for (const c of candidates)
            L.push(`- from ${c.from}: ${c.text}${c.fields.length ? `  [fields: ${c.fields.join(", ")}]` : ""}`);
    }
    L.push("", "VIOLATED needs a concrete violation you can cite; the tool only reports the evidence. PROPOSED and NOT DEMONSTRATED invariants are hints: do not present them as product rules.");
    return L.join("\n");
}
const lv = (v, label) => {
    const x = v ?? "none";
    return x === "n/a" ? { name: label, score: null, note: "not applicable to this change" }
        : { name: label, score: x === "covered" ? 2 : x === "partial" ? 1 : 0, note: x === "covered" ? "examined with evidence" : x === "partial" ? "examined in part" : "not examined (counts against confidence)" };
};
export function scoreConfidence(i) {
    const dims = [];
    const conf = i.invariants_confirmed ?? 0, inf = i.invariants_inferred ?? 0, vio = i.invariants_violated ?? 0, nd = i.invariants_not_demonstrated ?? 0;
    const totalInv = conf + inf + vio + nd;
    dims.push(totalInv === 0
        ? { name: "Invariants", score: 0, note: "none identified: either none apply or none were looked for; counts against confidence until stated" }
        : { name: "Invariants", score: conf / totalInv >= 0.75 ? 2 : conf / totalInv >= 0.4 ? 1 : 0, note: `${conf} confirmed, ${inf} inferred/proposed, ${nd} not demonstrated, ${vio} violated` });
    const cs = i.cross_service_scan ?? "not_run";
    dims.push(cs === "n/a" ? { name: "Cross-service scan", score: null, note: "single-service change" }
        : { name: "Cross-service scan", score: cs === "complete" ? 2 : cs === "partial" ? 1 : 0, note: cs === "not_run" ? "not run" : `${cs}${i.services_total ? `; ${i.services_with_hits ?? 0}/${i.services_total} services reference the entity` : ""}` });
    const te = i.test_evidence ?? "none";
    dims.push(te === "n/a" ? { name: "Test evidence", score: null, note: "no behaviour to test" }
        : { name: "Test evidence", score: te === "ran_and_passed" ? 2 : te === "exists_not_run" ? 1 : 0, note: te === "ran_and_passed" ? "tests were run and passed" : te === "exists_not_run" ? "tests exist but were not run in this review" : "no test evidence" });
    const db = i.db_constraints ?? "unknown";
    dims.push(db === "n/a" ? { name: "Database constraints", score: null, note: "no persistent invariant" } : { name: "Database constraints", score: db === "verified" ? 2 : 0, note: db === "verified" ? "examined (present or confirmed absent)" : "not examined" });
    dims.push(lv(i.concurrency, "Concurrency coverage"), lv(i.lifecycle, "Lifecycle coverage"), lv(i.authority, "Authority coverage"));
    const unv = i.unverified ?? 0, rd = i.requires_decision ?? 0;
    dims.push({ name: "UNVERIFIED items", score: unv === 0 ? 2 : unv <= 2 ? 1 : 0, note: `${unv}` });
    dims.push({ name: "REQUIRES_DECISION items", score: rd === 0 ? 2 : rd <= 1 ? 1 : 0, note: `${rd} open: a person must decide` });
    const cu = i.completeness_unknown;
    if (cu !== undefined)
        dims.push({ name: "Completeness check (10 questions)", score: cu === 0 ? 2 : cu <= 2 ? 1 : 0, note: `${cu} of 10 answered UNKNOWN` });
    const scored = dims.filter((d) => d.score !== null);
    const raw = scored.length ? Math.round((scored.reduce((n, d) => n + d.score, 0) / (scored.length * 2)) * 100) : 0;
    let level = raw >= 80 ? "HIGH" : raw >= 50 ? "MEDIUM" : "LOW";
    const caps = [];
    const cap = (to, why) => {
        const order = { LOW: 0, MEDIUM: 1, HIGH: 2 };
        if (order[to] < order[level]) {
            level = to;
            caps.push(`capped at ${to}: ${why}`);
        }
    };
    if (i.stale)
        cap("LOW", "the review is STALE: code changed after the verdict and the verdict never covered it");
    if (i.pessimistic_trigger_fired && cs === "not_run")
        cap("LOW", "the pessimistic trigger fired but the cross-service scan was not run");
    if (vio > 0)
        cap("MEDIUM", `${vio} invariant violation(s) found: the review is trustworthy about the violation, not about what else is wrong`);
    if (rd >= 3 || unv >= 5)
        cap("LOW", `too much is undecided or unverified (${rd} decision(s), ${unv} unverified)`);
    else if (rd >= 1 || unv >= 3)
        cap("MEDIUM", `${rd} decision(s) await a person and ${unv} item(s) are UNVERIFIED`);
    if (totalInv > 0 && inf + nd > conf)
        cap("MEDIUM", "more invariants are inferred or not demonstrated than confirmed");
    if (cu !== undefined && cu >= 4)
        cap("LOW", `${cu} of the 10 completeness questions are UNKNOWN`);
    else if (cu !== undefined && cu >= 1)
        cap("MEDIUM", `${cu} of the 10 completeness questions are UNKNOWN`);
    if (cs === "partial" || cs === "not_run")
        cap("MEDIUM", "the cross-service scan is not complete");
    if (i.pessimistic_trigger_fired && (i.concurrency ?? "none") === "none")
        cap("MEDIUM", "pessimistic story with no concurrency analysis");
    const raise = [];
    for (const d of dims)
        if (d.score !== null && d.score < 2)
            raise.push(`${d.name}: ${d.note}`);
    const lines = [
        `CONFIDENCE SCORE: ${level} (${raw}/100 before caps)`,
        "CONFIDENCE EXPLANATION:",
        ...dims.map((d) => `  - ${d.name}: ${d.score === null ? "n/a" : `${d.score}/2`}  ${d.note}`),
        ...(caps.length ? ["  Caps applied:", ...caps.map((c) => `    * ${c}`)] : []),
        ...(i.findings_count === 0 && level !== "HIGH" ? [`  Note: "no findings" here means "none found", not "none exist". Confidence is ${level}, so absence of findings is not evidence of correctness.`] : []),
        ...(level !== "HIGH" && raise.length ? ["  To raise confidence:", ...raise.slice(0, 6).map((r) => `    * ${r}`)] : []),
    ];
    return { level, score: raw, dimensions: dims, caps, raise, explanation: lines.join("\n") };
}

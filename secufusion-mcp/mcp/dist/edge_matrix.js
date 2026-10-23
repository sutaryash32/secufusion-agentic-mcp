/**
 * Edge matrix: the edges of a change, ranked by what they would cost THIS product, and the ones nobody looked at.
 *
 * "All the edges nobody thought of" is not reached by a longer checklist. Cells come from four places, ranked by risk:
 *   PRODUCT   questions drawn from the project's own memory (accepted invariants, decisions, lessons learned, known
 *             exceptions), each naming its source;
 *   CODE      questions drawn from the code that exists: lifecycle paths that never mention the flag, paths that are absent,
 *             authorization decisions elsewhere that read the same field, rules copied across services;
 *   MODEL     hypotheses the reviewer adds from its own reasoning ("custom cells"), each with the reason it suspects them;
 *   BASELINE  the standard edges for each input type, state, role, call and delivery. A memory jogger, ranked LOW: it is
 *             answered in bulk and is never the goal.
 * The reviewer is expected to reason about the top cells (a written chain from the product rule to the code, with verified
 * evidence), not to fill every cell. A high-risk cell answered without reasoning, or with evidence that is not in the code, is
 * weak. A model verdict (HOLDS, VIOLATED, UNKNOWN) is applied only as far as its evidence checks out. Language-neutral. READ-ONLY.
 */
import crypto from "crypto";
import { validateEvidence } from "./finding_evidence.js";
const TYPE_EDGES = [
    { re: /\b(tenant[_ ]?id|org(?:anization)?[_ ]?id|account[_ ]?id)\b/i, label: "tenant id", edges: ["an id of another tenant (must be refused as not found, not forbidden)", "an id of a parent or a child tenant", "a deleted or disabled tenant", "missing or null", "taken from the request instead of the token", "a malformed or forged value"] },
    { re: /\b(id|uuid|guid|key|ref)\b$|^id$|_id$/i, label: "id", edges: ["an id that does not exist", "an id that belongs to another tenant", "an id of a soft-deleted record", "malformed (wrong length, wrong characters, negative, zero)", "the same id twice in one request", "an id the caller may read but not change"] },
    { re: /email|mail/i, label: "email", edges: ["empty and whitespace only", "different case of the same address", "plus-addressing and subdomains", "non-ASCII (internationalised) domain or local part", "the longest allowed length and one more", "an address that already exists"] },
    { re: /url|uri|link|href/i, label: "url", edges: ["empty", "a scheme that is not http(s) (javascript:, file:)", "an internal address (SSRF) or localhost", "very long", "encoded characters and fragments", "an open redirect target"] },
    { re: /password|secret|token|key$|credential/i, label: "secret", edges: ["empty", "very long", "non-ASCII and emoji", "contains the delimiter the code splits on", "never appears in a log, error or response"] },
    { re: /money|amount|price|cost|currency|decimal|float|double/i, label: "money / decimal", edges: ["zero", "negative", "the maximum and one above", "more decimal places than the currency allows", "binary floating point rounding (0.1 + 0.2)", "two different currencies", "NaN and infinity"] },
    { re: /int|long|number|count|size|limit|page|offset|qty|quantity|age|index/i, label: "number", edges: ["zero", "negative", "the minimum and maximum of the type, and one beyond (overflow)", "a page or offset past the end", "a very large page size", "not a number, or a number as a string", "a value that makes a division or a loop unbounded"] },
    { re: /[Bb]ool|[Ff]lag|[Ee]nabled|[Aa]ctive|\bis_|^is[A-Z]/, label: "boolean", edges: ["missing (default applied?)", "null versus false", "a string 'false' or 'no' or '0'", "flipped while another request reads it"] },
    { re: /date|time|timestamp|instant|datetime|expires|deadline/i, label: "date / time", edges: ["null", "in the past and far in the future", "across a daylight-saving change", "different time zones and a server in another zone", "leap day and end of month", "the epoch and the year 2038", "a range whose end is before its start", "clock skew between services"] },
    { re: /duration|ttl|timeout|interval/i, label: "duration", edges: ["zero", "negative", "very large (overflow when added to a time)", "a unit mix-up (seconds versus milliseconds)"] },
    { re: /enum|status|state|type|kind|role|level/i, label: "enum / status", edges: ["every defined value", "a value that does not exist", "a legacy value still present in old rows", "a new value added later that this code does not handle (a switch with no default)", "null and empty", "different case"] },
    { re: /list|array|ids|items|collection|set|batch|bulk|\[\]/i, label: "collection", edges: ["empty", "one element", "a very large collection (memory, timeout, page size)", "duplicates", "null elements", "an order that matters, or that changes between calls", "mixed tenants in one batch", "one bad element in the batch (partial success)"] },
    { re: /map|object|json|dict|payload|body|dto|metadata|attributes/i, label: "object / json", edges: ["an empty object", "missing required fields and unknown extra fields", "a field of the wrong type", "null for a non-null field", "deeply nested or very large", "duplicate keys", "an old client sending the old shape"] },
    { re: /file|upload|attachment|image|blob|binary|stream|csv|xml/i, label: "file / stream", edges: ["empty file", "the size limit and one byte more", "a wrong content type or extension", "a malicious file (zip bomb, path traversal in the name, XML entity expansion, a formula in a CSV cell)", "a corrupt or truncated file", "a file name with unicode or spaces", "the connection drops mid-upload"] },
    { re: /name|title|description|text|comment|message|label|note|query|search|string|str|body/i, label: "text", edges: ["empty and whitespace only", "the maximum length and one more", "non-ASCII, emoji and right-to-left text", "leading and trailing spaces", "characters that matter to the next layer (quotes, %, _, \\, <, newline)", "a very long single word", "the same text in a different case or Unicode normalisation"] },
];
const SPECIFIC = new Set(["tenant id", "id", "email", "url", "secret", "money / decimal", "date / time", "duration", "file / stream"]);
const FALLBACK = ["null or missing", "empty", "an unexpected type", "the largest value this can hold", "a value that only differs in case or whitespace"];
const STATE_EDGES = ["the entity is deleted or soft-deleted", "the entity is disabled or inactive", "the entity belongs to a deleted parent"];
const EXTERNAL_EDGES = ["the call times out", "the call fails with an error", "the call succeeds but the answer is lost (the caller retries a non-idempotent call)", "the call is slow and holds a lock or a connection", "the call succeeds and a LATER step fails (is the state recoverable?)", "the dependency returns a partial or empty result"];
const MESSAGING_EDGES = ["the same message is delivered twice", "messages arrive out of order", "a malformed or poison message (does it block the partition?)", "the message has no tenant id, or a tenant that no longer exists", "the consumer is down and the backlog is replayed after a deploy", "the producer and consumer run different versions of the payload", "the database write commits but the publish fails (or the reverse)"];
const CONCURRENCY_EDGES = ["the same request is submitted twice at once (double click, retry)", "two different callers change the same record at once", "a read while another request is writing", "the caller retries after a timeout"];
const DATA_EDGES = ["legacy rows written by older code (nulls, old enum values, missing defaults)", "an empty dataset (a new tenant)", "a very large dataset (one tenant with millions of rows)", "rows created before this feature existed"];
const DEPLOY_EDGES = ["the old and the new version run at once during a rolling deploy", "the change is rolled back after data was written in the new shape", "a migration has not been applied yet when this code starts"];
const SCHEDULE_EDGES = ["the job runs on every instance at once", "the job is still running when the next run starts", "the job misses a run (restart, deploy) and must catch up", "daylight-saving change or month end", "a failure halfway leaves partial work"];
const clamp = (n) => Math.max(1, Math.min(10, Math.round(n)));
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 6);
const words = (s) => s.flatMap((x) => x.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 3);
export function buildMatrix(entries, o = {}) {
    const max = Math.max(50, Math.min(o.max_cells ?? 800, 3000));
    const hot = new Set(words([...(o.flags ?? []), ...(o.terms ?? [])]));
    const all = [];
    const add = (entry, area, edge, risk, origin = "BASELINE", source, why) => all.push({ entry, area, edge, origin, risk: clamp(risk), source, why });
    for (const p of o.product ?? [])
        add(p.entry, p.area, p.edge, p.risk, p.origin, p.source, p.why);
    for (const c of o.custom ?? []) {
        if ((c.why ?? "").trim().length < 10)
            continue; // a hypothesis must say why it is suspected
        add(c.entry ?? "(the change)", c.area, c.edge, c.risk ?? 8, "MODEL", c.source, c.why);
    }
    for (const e of entries) {
        for (const inp of e.inputs ?? []) {
            const hit = TYPE_EDGES.find((t) => SPECIFIC.has(t.label) && t.re.test(inp.name)) ?? TYPE_EDGES.find((t) => t.re.test(inp.type)) ?? TYPE_EDGES.find((t) => t.re.test(inp.name));
            const edges = hit ? hit.edges : FALLBACK;
            const isHot = words([inp.name]).some((w) => hot.has(w));
            const base = hit?.label === "tenant id" ? 7 : hit?.label === "secret" || hit?.label === "id" ? 5 : 3;
            for (const edge of edges)
                add(e.name, `input ${inp.name} (${inp.type}${hit ? ", " + hit.label : ""})`, edge, base + (isHot ? 3 : 0), "BASELINE", undefined, isHot ? "the product cares about this field" : undefined);
            if (inp.required === false)
                add(e.name, `input ${inp.name}`, "omitted entirely (what default applies, and is it safe?)", 4 + (isHot ? 3 : 0));
        }
        if (e.tenant_scoped !== false && (e.writes_data !== undefined || (e.inputs ?? []).length)) {
            add(e.name, "tenancy", "a caller from tenant A reaches tenant B's data through this entry point", 9);
            add(e.name, "tenancy", "a parent-tenant administrator, a child-tenant user, and a platform operator each call it", 8);
            add(e.name, "tenancy", "the acting tenant differs from the caller's home tenant", 8);
        }
        for (const op of e.operations ?? [])
            for (const st of e.states ?? ["(any state)"])
                add(e.name, `operation ${op}`, `${op} while the entity is ${st}`, 5);
        if ((e.states ?? []).length)
            for (const edge of STATE_EDGES)
                add(e.name, "state", edge, 5);
        for (const role of e.roles ?? [])
            for (const op of e.operations?.length ? e.operations : ["call"])
                add(e.name, `role ${role}`, `${role} attempts ${op} (allowed, refused, or refused with the right error?)`, 6);
        if (e.roles?.length)
            add(e.name, "roles", "an authenticated user with no role at all", 6);
        for (const call of e.external_calls ?? [])
            for (const edge of EXTERNAL_EDGES)
                add(e.name, `external call ${call}`, edge, /later step fails|answer is lost/.test(edge) ? 7 : 5);
        if (e.messaging)
            for (const edge of MESSAGING_EDGES)
                add(e.name, "messaging", edge, /twice|commits but the publish|no tenant id/.test(edge) ? 7 : 5);
        if (e.scheduled)
            for (const edge of SCHEDULE_EDGES)
                add(e.name, "schedule", edge, 5);
        if (e.writes_data !== false)
            for (const edge of CONCURRENCY_EDGES)
                add(e.name, "concurrency", edge, /same record at once|twice at once/.test(edge) ? 7 : 5);
        for (const edge of DATA_EDGES)
            add(e.name, "data age and size", edge, 4);
        for (const edge of DEPLOY_EDGES)
            add(e.name, "deployment", edge, 4);
    }
    // highest risk first, so a cap drops baseline noise and never a product question; ids come from content, so they survive a re-run
    const rank = { MODEL: 0, PRODUCT: 1, CODE: 2, BASELINE: 3 };
    all.sort((a, b) => b.risk - a.risk || rank[a.origin] - rank[b.origin] || a.entry.localeCompare(b.entry) || a.area.localeCompare(b.area) || a.edge.localeCompare(b.edge));
    const seen = new Map();
    const cells = [];
    for (const c of all) {
        const content = `${c.entry}|${c.area}|${c.edge}`;
        let id = `E${hash(content)}`;
        if (seen.get(id) === content)
            continue; // an exact duplicate
        while (seen.has(id))
            id += "x";
        seen.set(id, content);
        cells.push({ id, ...c });
    }
    return { cells: cells.slice(0, max), truncated: cells.length > max };
}
/** Turns a model's reasoning verdicts into answers, keeping only what the evidence supports. */
export function applyVerdicts(root, cells, verdicts) {
    const answers = [];
    const notes = [];
    const byId = new Map(cells.map((c) => [c.id, c]));
    const flat = verdicts.filter((v) => byId.has(v.cell_id)).flatMap((v) => (v.evidence ?? []).map((e, i) => ({ e, key: `${v.cell_id}#${i}` })));
    const checked = flat.length ? validateEvidence(root, flat.map((x) => ({ id: x.key, file: x.e.file, line: x.e.line, quote: x.e.quote }))) : { results: [] };
    const ok = new Map(checked.results.map((r) => [r.id, r.action === "KEEP"]));
    for (const v of verdicts) {
        if (!byId.has(v.cell_id)) {
            notes.push(`verdict for unknown cell ${v.cell_id} ignored`);
            continue;
        }
        const good = (v.evidence ?? []).find((_, i) => ok.get(`${v.cell_id}#${i}`) === true);
        if (v.verdict === "HOLDS") {
            if (good)
                answers.push({ cell_id: v.cell_id, status: "COVERED", reasoning: v.reasoning, evidence: good });
            else {
                answers.push({ cell_id: v.cell_id, status: "DEFERRED", reasoning: v.reasoning });
                notes.push(`${v.cell_id}: the model says this holds but gave no evidence that survived the check, so it is DEFERRED, not covered`);
            }
        }
        else if (v.verdict === "VIOLATED") {
            answers.push({ cell_id: v.cell_id, status: "GAP", reasoning: v.reasoning, scenario: v.scenario, evidence: good });
            if (!good)
                notes.push(`${v.cell_id}: a VIOLATED verdict with no verified evidence: treat it as a lead and confirm it in the code before reporting`);
        }
        else
            answers.push({ cell_id: v.cell_id, status: "DEFERRED", reasoning: v.reasoning });
    }
    return { answers, notes };
}
const matchesBulk = (c, b) => (!b.origin || c.origin === b.origin) && (!b.area_contains || c.area.toLowerCase().includes(b.area_contains.toLowerCase())) &&
    (!b.edge_contains || c.edge.toLowerCase().includes(b.edge_contains.toLowerCase())) && (b.max_risk === undefined || c.risk <= b.max_risk);
export function scoreMatrix(root, entries, answers, o = {}) {
    const deep = o.deep_threshold ?? 7;
    const { cells, truncated } = buildMatrix(entries, o);
    const byId = new Map(cells.map((c) => [c.id, c]));
    const resolved = new Map();
    for (const a of answers) {
        const ids = [...(a.cell_id ? [a.cell_id] : []), ...(a.cell_ids ?? [])];
        for (const id of ids)
            if (byId.has(id) && !resolved.has(id))
                resolved.set(id, a);
    }
    for (const a of answers.filter((x) => x.bulk))
        for (const c of cells)
            if (!resolved.has(c.id) && matchesBulk(c, a.bulk))
                resolved.set(c.id, a);
    // verify each distinct piece of evidence once, then look the result up per cell
    const keyOf = (a) => JSON.stringify(a.evidence);
    const distinct = [...new Map([...resolved.values()].filter((a) => a.status === "COVERED" && a.evidence).map((a) => [keyOf(a), a])).values()];
    const checked = distinct.length ? validateEvidence(root, distinct.map((a, i) => ({ id: String(i), file: a.evidence.file, line: a.evidence.line, quote: a.evidence.quote }))) : { results: [] };
    const evidenceState = new Map();
    distinct.forEach((a, i) => { const r = checked.results[i]; evidenceState.set(keyOf(a), { state: r.action === "DROP" ? "bad" : r.action === "KEEP_AS_POSSIBLE" ? "weak" : "ok", reason: r.reason }); });
    const unanswered = [], gaps = [], weak = [], deferred = [];
    let highSound = 0;
    const highTotal = cells.filter((c) => c.risk >= deep).length;
    for (const c of cells) {
        const a = resolved.get(c.id);
        if (!a) {
            unanswered.push(c);
            continue;
        }
        const text = (a.reasoning ?? a.why ?? "").trim();
        const high = c.risk >= deep;
        if (a.status === "GAP") {
            gaps.push({ ...c, reasoning: [text, a.scenario].filter(Boolean).join(" — ") });
            if (high)
                highSound++;
            continue;
        }
        if (a.status === "DEFERRED") {
            deferred.push(c);
            continue;
        }
        let problem = "";
        const ev = a.evidence ? evidenceState.get(keyOf(a)) : undefined;
        if (a.status === "NOT_APPLICABLE") {
            if (text.length < (high ? 40 : 10))
                problem = high ? "a high-risk cell marked NOT_APPLICABLE needs a real reason (why can this edge not happen here?), not a label" : "NOT_APPLICABLE without a reason";
        }
        else if (high && text.length < 40)
            problem = "a high-risk cell needs written reasoning: the product rule, the path through the code, and why it holds (or does not)";
        else if (high && !a.evidence)
            problem = "a high-risk cell is COVERED without evidence: cite the code or the test that makes it hold";
        else if (!a.evidence && text.length < 20)
            problem = "COVERED without evidence or reasoning";
        else if (ev?.state === "bad")
            problem = `the evidence is not in the code (${ev.reason})`;
        else if (ev?.state === "weak")
            problem = "the evidence has no quote, so it cannot be matched to the code";
        if (problem)
            weak.push({ ...c, problem });
        else if (high)
            highSound++;
    }
    const by_origin = { PRODUCT: 0, CODE: 0, MODEL: 0, BASELINE: 0 };
    for (const c of cells)
        by_origin[c.origin]++;
    const notes = [
        "the goal is to find what is WRONG, not to fill the matrix: reason about the top cells first, answer the BASELINE cells in bulk, and add your own cells (custom_cells) for what the product requires that no list contains",
        "an unanswered cell is an edge nobody looked at; a high-risk one is the first thing to examine",
    ];
    if (by_origin.PRODUCT + by_origin.CODE === 0)
        notes.push("no PRODUCT or CODE cells were generated: there is no project knowledge and no entities or flags were given, so this matrix is only the generic baseline. Record the product's invariants, decisions and lessons (record_project_knowledge) and name the entities and flags");
    if (truncated)
        notes.push(`the matrix was cut at ${cells.length} cells, lowest risk first: the product and code cells are all still here`);
    return {
        cells, truncated, by_origin, answered: resolved.size, unanswered, high_risk_unanswered: unanswered.filter((c) => c.risk >= deep), gaps, weak, deferred,
        attention: { high_risk_total: highTotal, high_risk_sound: highSound, percent: highTotal ? Math.round((highSound / highTotal) * 1000) / 10 : null }, notes,
    };
}
export function renderMatrix(r, show = 40) {
    const out = [
        `# Edge matrix: ${r.cells.length} cell(s)${r.truncated ? " (cut, lowest risk first)" : ""} · PRODUCT ${r.by_origin.PRODUCT} · CODE ${r.by_origin.CODE} · MODEL ${r.by_origin.MODEL} · BASELINE ${r.by_origin.BASELINE}`,
        `answered ${r.answered} · high-risk cells answered soundly ${r.attention.high_risk_sound}/${r.attention.high_risk_total}${r.attention.percent === null ? "" : ` (${r.attention.percent}%)`} · gaps ${r.gaps.length} · weak ${r.weak.length} · deferred ${r.deferred.length}`, "",
    ];
    const line = (c) => `  ${c.id}  [risk ${c.risk} ${c.origin}] ${c.entry} · ${c.area}\n      ${c.edge}${c.source ? `\n      source: ${c.source}` : ""}${c.why ? `\n      why: ${c.why}` : ""}${c.problem ? `\n      PROBLEM: ${c.problem}` : ""}${c.reasoning ? `\n      reasoning: ${c.reasoning}` : ""}`;
    const list = (title, items) => {
        if (!items.length)
            return;
        out.push(`${title} (${items.length}):`, ...items.slice(0, show).map(line));
        if (items.length > show)
            out.push(`  … ${items.length - show} more (use format=json for all)`);
        out.push("");
    };
    list("GAPS the reviewer confirmed", r.gaps);
    list("HIGH-RISK cells nobody has examined: start here", r.high_risk_unanswered);
    list("WEAK answers", r.weak);
    list("DEFERRED (need a decision or more evidence)", r.deferred);
    const lowUn = r.unanswered.length - r.high_risk_unanswered.length;
    if (lowUn > 0)
        out.push(`${lowUn} lower-risk cell(s) unanswered (mostly BASELINE): answer them in bulk with a reason (bulk: {origin: "BASELINE", area_contains: ...}) once the high-risk ones are done.`, "");
    out.push(...r.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}

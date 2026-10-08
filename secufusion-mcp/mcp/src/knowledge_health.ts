import fs from "fs";
import path from "path";
import { KnowledgeEntry, KnowledgeModel, Category, CATEGORIES, queryKnowledge, listAgentFiles } from "./project_knowledge.js";
import { extractSnapshot, computeRisks } from "./release_notes.js";

/**
 * Project intelligence health: how much of what the project HAS is written down.
 *
 * Coverage is a plain comparison of documented vs discovered entities, per dimension. It is not a score.
 *   discovered  = entities the curated project spec records (services, topics, golden rules, domain
 *                 terminology, platform decisions) plus anomalies it exposes (known-exception candidates).
 *                 The knowledge graph is deliberately NOT the denominator: it contains duplicate and
 *                 code-constant names that would make any ratio meaningless. Graph-only names are
 *                 reported separately as unreconciled.
 *   documented  = at least one ACCEPTED entry in .mcp names the entity (id, title, tag, applies_to or text).
 *   proposed-only = only unreviewed entries name it.
 *   undocumented  = nothing in .mcp names it.
 */

export const COVERAGE_DEFINITION =
    "An entity is **documented** when at least one `accepted` entry in .mcp names it (in its id, title, tags, applies_to or text), " +
    "**proposed-only** when only unreviewed entries do, and **undocumented** otherwise. Entities (services, topics, golden rules, domain concepts, platform decisions) " +
    "are discovered from the project spec. Anomalies the spec exposes are shown as known-exception CANDIDATES but are not in the headline: they are unconfirmed and some may be benign. " +
    "This is a ratio of counts, not a weighted score.";

/** Dimensions that make up the headline coverage. Anomalies are a backlog of candidates, not entities. */
export const HEADLINE_DIMENSIONS: Dimension[] = ["services", "topics", "rules", "concepts", "decisions"];

export type Dimension = "services" | "topics" | "rules" | "concepts" | "decisions" | "exceptions";

export interface DiscoveredEntity { name: string; label?: string; subjects: string[] }
export type Discovered = Record<Dimension, DiscoveredEntity[]>;

const META_TERMINOLOGY = new Set(["history", "rules", "note", "notes", "description"]);
const PLATFORM_DECISIONS = ["tenancy_model", "auth_provider", "event_bus", "database", "migration_strategy"];

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, "-");

export function discoverEntities(spec: any): Discovered {
    spec = spec && typeof spec === "object" ? spec : {};
    const snap = extractSnapshot("health", spec);
    const out: Discovered = { services: [], topics: [], rules: [], concepts: [], decisions: [], exceptions: [] };

    for (const name of Object.keys(snap.services)) out.services.push({ name, subjects: [name] });
    for (const name of Object.keys(snap.topics)) out.topics.push({ name, subjects: [name] });
    for (const id of Object.keys(snap.rules)) out.rules.push({ name: id, subjects: [id] });
    for (const k of Object.keys(spec.terminology ?? {})) {
        if (k.startsWith("_") || META_TERMINOLOGY.has(k.toLowerCase())) continue;
        out.concepts.push({ name: k, subjects: [k] });
    }
    for (const k of PLATFORM_DECISIONS) {
        const v = spec.platform?.[k];
        if (typeof v === "string" && v.trim()) {
            const short = v.split(/[ (,:;]/)[0];
            out.decisions.push({ name: k, label: `${k.replace(/_/g, " ")}: ${v.length > 60 ? v.slice(0, 59) + "…" : v}`, subjects: [k, short] });
        }
    }

    // Known-exception candidates: structural anomalies and the manual-review flags the spec already carries.
    const services = Object.keys(snap.services);
    for (const r of computeRisks(snap)) {
        if (r.id.startsWith("FLAG:")) continue;
        const rest = r.id.slice(r.id.indexOf(":") + 1);
        const subjects = r.id.startsWith("UNKNOWN_CALL_TARGET") ? rest.split("->")
            : r.id.startsWith("UNRESOLVED") ? [rest.slice(0, rest.indexOf(".")), rest.slice(rest.indexOf(".") + 1).split(".")[0]]
            : [rest];
        out.exceptions.push({ name: r.id, label: r.text, subjects: subjects.filter(Boolean) });
    }
    for (const f of snap.flags) {
        const named = services.filter((s) => norm(f).includes(norm(s)));
        out.exceptions.push({ name: `FLAG:${f.slice(0, 48)}`, label: f.length > 140 ? f.slice(0, 139) + "…" : f, subjects: named });
    }
    return out;
}

// ── does an entry name an entity? ───────────────────────────────────────────

function haystack(e: KnowledgeEntry): string {
    return norm(`${e.id} ${e.title} ${e.tags.join(" ")} ${e.applies_to.join(" ")} ${e.body}`);
}
function names(h: string, term: string): boolean {
    const t = norm(term).replace(/[^a-z0-9-]/g, "");
    if (t.length < 3) return false;
    return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(h);
}

const DIM_CATEGORIES: Record<Dimension, Category[] | null> = {
    services: null, topics: null, rules: null, concepts: null,
    decisions: ["adr", "architecture"],
    exceptions: ["known-exceptions"],
};

function entryNames(dim: Dimension, e: KnowledgeEntry, ent: DiscoveredEntity): boolean {
    const cats = DIM_CATEGORIES[dim];
    if (cats && !cats.includes(e.category)) return false;
    if (e.status === "superseded" || e.status === "deprecated") return false;
    const h = haystack(e);
    if (dim === "exceptions") {
        if (ent.subjects.length) return ent.subjects.every((s) => names(h, s));
        return h.includes(norm(ent.name.replace(/^FLAG:/, "")).slice(0, 40));
    }
    if (dim === "decisions") return names(h, ent.subjects[0]) || (ent.subjects[1] ? names(h, ent.subjects[1]) : false);
    return ent.subjects.some((s) => names(h, s));
}

export interface DimensionCoverage {
    dimension: Dimension;
    label: string;
    discovered: number;
    documented: number;
    proposed_only: number;
    undocumented: DiscoveredEntity[];
}

const LABELS: Record<Dimension, string> = {
    services: "Services", topics: "Topics", rules: "Golden rules", concepts: "Domain concepts",
    decisions: "Platform decisions (ADR candidates)", exceptions: "Anomalies (known-exception candidates)",
};

export function computeCoverage(discovered: Discovered, entries: KnowledgeEntry[]): DimensionCoverage[] {
    return (Object.keys(LABELS) as Dimension[]).map((dim) => {
        let documented = 0, proposedOnly = 0;
        const undocumented: DiscoveredEntity[] = [];
        for (const ent of discovered[dim]) {
            const hits = entries.filter((e) => entryNames(dim, e, ent));
            if (hits.some((e) => e.status === "accepted")) documented++;
            else if (hits.length) proposedOnly++;
            else undocumented.push(ent);
        }
        return { dimension: dim, label: LABELS[dim], discovered: discovered[dim].length, documented, proposed_only: proposedOnly, undocumented };
    });
}

// ── tribal knowledge: project-specific sections sitting inside the agent file ──

export interface TribalCandidate { file: string; heading: string; line: number; entities: string[]; suggested_category: Category; reason: string }

function guessCategory(heading: string, body: string): Category {
    const t = `${heading} ${body.slice(0, 400)}`.toLowerCase();
    if (/lesson|incident|post-?mortem|false positive/.test(t)) return "lessons-learned";
    if (/exception|legacy|intentional|workaround/.test(t)) return "known-exceptions";
    if (/migrat|deploy|environment|runtime|rollback|guardrail/.test(t)) return "operational";
    if (/pattern|convention|naming|style/.test(t)) return "patterns";
    if (/decision|adr|why we/.test(t)) return "adr";
    return "architecture";
}

export function findTribalCandidates(workspaceRoot: string, entityNames: string[]): TribalCandidate[] {
    const ents = [...new Set(entityNames.map(norm))].filter((n) => n.length >= 4);
    const out: TribalCandidate[] = [];
    const seen = new Set<string>();
    for (const file of listAgentFiles(workspaceRoot)) {
    const text = fs.readFileSync(path.join(workspaceRoot, file), "utf-8").replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    const sections: Array<{ heading: string; line: number; body: string }> = [];
    let inFence = false;
    lines.forEach((l, i) => {
        if (l.startsWith("```")) inFence = !inFence;
        if (!inFence && /^#{2,3} /.test(l)) sections.push({ heading: l.replace(/^#+\s*/, ""), line: i + 1, body: "" });
        else if (sections.length) sections[sections.length - 1].body += l + "\n";
    });
    for (const s of sections) {
        const dedupe = norm(s.heading) + "|" + s.body.length; // the same section copied into several files is reported once
        if (seen.has(dedupe)) continue;
        if (/\.mcp\//.test(s.body)) continue; // already a pointer to the knowledge layer
        const h = norm(s.body);
        const found = ents.filter((n) => new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(h));
        const flagged = /critical|terminology|history|legacy|incident|known (issue|exception)|lessons?/i.test(s.heading);
        // Workflow and contract sections are what the agent file is FOR; they may name a service as an example without being project knowledge.
        const behavior = /workflow|agreement|contract|philosoph|principle|process|conduct|execution|order of|git\b|pull request|\bpr\b|commands?|how to|rules? for|never|always/i.test(s.heading);
        const strongEntityEvidence = found.length >= 6 || (found.length >= 3 && !behavior);
        if (strongEntityEvidence || (flagged && s.body.trim().length > 200)) {
            seen.add(dedupe);
            out.push({
                file, heading: s.heading, line: s.line, entities: found.slice(0, 6),
                suggested_category: guessCategory(s.heading, s.body),
                reason: strongEntityEvidence ? `names ${found.length} project entities (${found.slice(0, 4).join(", ")})` : "heading marks it as project history or terminology",
            });
        }
    }
    }
    return out.slice(0, 12);
}

// ── lookup history: the raw material for "repeated investigation" ───────────

export interface LookupEvent {
    ts: string;
    kind: "knowledge" | "investigate";
    terms: string[];
    files: string[];
    matched: string[];
    accepted_matched: boolean;
}

const LOG_MAX = 500;
const lookupFile = (root: string) => path.join(root, ".secufusion", "knowledge-lookups.json");

export function readLookups(root: string): LookupEvent[] {
    try { return JSON.parse(fs.readFileSync(lookupFile(root), "utf-8")); } catch { return []; }
}

export function recordLookup(root: string, ev: LookupEvent): void {
    try {
        const all = readLookups(root);
        all.push(ev);
        fs.mkdirSync(path.dirname(lookupFile(root)), { recursive: true });
        fs.writeFileSync(lookupFile(root), JSON.stringify(all.slice(-LOG_MAX), null, 1));
    } catch { /* working state only; never fail a lookup because of it */ }
}

const GENERIC = new Set(("the and for with without from into when then that this have been should must does not are was were its their there which what who " +
    "user users label labels count counts incorrect wrong error errors issue issues data value values name names item items page dialog screen button " +
    "request response return returns show shows shown display displays new add fix bug update change changes using used use get set make makes need needs " +
    "can cannot also only just some any all each both more most other such than too very file files code class method service services api").split(" "));

export function significantTerms(terms: string[]): string[] {
    const ws = terms.flatMap((t) => t.toLowerCase().split(/[^a-z0-9_-]+/)).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));
    return [...new Set(ws)];
}

export interface RepeatedTopic { terms: string[]; count: number; first: string; last: string; kinds: string[] }

/** Topics looked up at least `min` times without any ACCEPTED knowledge answering them. */
export function findRepeated(events: LookupEvent[], entries: KnowledgeEntry[], min = 3): RepeatedTopic[] {
    const byTerm = new Map<string, number[]>();
    events.forEach((ev, i) => {
        if (ev.accepted_matched) return;
        for (const t of significantTerms(ev.terms)) (byTerm.get(t) ?? byTerm.set(t, []).get(t)!).push(i);
    });
    const groups = new Map<string, { terms: string[]; idx: number[] }>();
    for (const [t, idx] of byTerm) {
        if (idx.length < min) continue;
        const key = idx.join(",");
        const g = groups.get(key) ?? { terms: [], idx };
        g.terms.push(t);
        groups.set(key, g);
    }
    const out: RepeatedTopic[] = [];
    for (const g of groups.values()) {
        // knowledge written since then counts: if an accepted entry now answers these terms, it is no longer a gap
        if (queryKnowledge(entries, { terms: g.terms.slice(0, 4), limit: 1 }).some((h) => h.entry.status === "accepted")) continue;
        const evs = g.idx.map((i) => events[i]);
        out.push({ terms: g.terms.sort(), count: g.idx.length, first: evs[0].ts, last: evs[evs.length - 1].ts, kinds: [...new Set(evs.map((e) => e.kind))] });
    }
    return out.sort((a, b) => b.count - a.count);
}

// ── suggestions ─────────────────────────────────────────────────────────────

export interface Suggestion {
    kind: "REPEATED_INVESTIGATION" | "UNDOCUMENTED_ENTITY" | "UNDOCUMENTED_EXCEPTION" | "TRIBAL_SECTION";
    priority: "HIGH" | "MEDIUM" | "LOW";
    category: Category;
    title: string;
    why: string;
    evidence: string;
    applies_to: string[];
    next_step: string;
}

const CAT_FOR_DIM: Record<Dimension, Category> = {
    services: "architecture", topics: "architecture", rules: "patterns", concepts: "architecture", decisions: "adr", exceptions: "known-exceptions",
};

export interface HealthReport {
    coverage: DimensionCoverage[];
    totals: { discovered: number; documented: number; proposed_only: number; undocumented: number };
    by_category: Record<string, { total: number; accepted: number; proposed: number }>;
    tribal: TribalCandidate[];
    repeated: RepeatedTopic[];
    unreconciled_graph_names: string[];
    suggestions: Suggestion[];
}

export function buildHealth(args: {
    spec: any; dna?: any; model: KnowledgeModel; workspaceRoot: string; events: LookupEvent[]; minRepeat?: number;
}): HealthReport {
    const discovered = discoverEntities(args.spec);
    const coverage = computeCoverage(discovered, args.model.entries);
    const totals = coverage.filter((c) => HEADLINE_DIMENSIONS.includes(c.dimension)).reduce((t, c) => ({
        discovered: t.discovered + c.discovered, documented: t.documented + c.documented,
        proposed_only: t.proposed_only + c.proposed_only, undocumented: t.undocumented + c.undocumented.length,
    }), { discovered: 0, documented: 0, proposed_only: 0, undocumented: 0 });

    const by_category: HealthReport["by_category"] = {};
    for (const c of CATEGORIES) {
        const es = args.model.entries.filter((e) => e.category === c);
        by_category[c] = { total: es.length, accepted: es.filter((e) => e.status === "accepted").length, proposed: es.filter((e) => e.status === "proposed").length };
    }

    const entityNames = [...discovered.services, ...discovered.topics, ...discovered.rules, ...discovered.concepts].map((e) => e.name);
    const tribal = findTribalCandidates(args.workspaceRoot, entityNames);
    const repeated = findRepeated(args.events, args.model.entries, args.minRepeat ?? 3);

    // names the graph has that the spec does not (reported, not counted)
    const g = args.dna?.graph ?? args.dna;
    const known = new Set([...discovered.services, ...discovered.topics].map((e) => norm(e.name)));
    const unreconciled = g && Array.isArray(g.nodes)
        ? [...new Set<string>(g.nodes.filter((n: any) => n.type === "SERVICE" || n.type === "TOPIC").map((n: any) => String(n.name ?? n.id)))]
            .filter((n) => !known.has(norm(n))).slice(0, 12)
        : [];

    const suggestions: Suggestion[] = [];
    const lookedUp = new Set(args.events.flatMap((e) => significantTerms(e.terms)));
    for (const r of repeated) {
        suggestions.push({
            kind: "REPEATED_INVESTIGATION", priority: "HIGH", category: "lessons-learned",
            title: `Investigation notes: ${r.terms.slice(0, 3).join(", ")}`,
            why: `Looked up ${r.count} times (${r.first.slice(0, 10)} to ${r.last.slice(0, 10)}) with no accepted knowledge answering it.`,
            evidence: `terms: ${r.terms.join(", ")}`, applies_to: r.terms.slice(0, 5),
            next_step: `record_project_knowledge(category: "lessons-learned" or "architecture", title: ..., source: <where you verified it>, applies_to: ${JSON.stringify(r.terms.slice(0, 5))}). Record only what you have verified.`,
        });
    }
    for (const dim of ["concepts", "decisions", "services", "topics", "rules"] as Dimension[]) {
        for (const ent of coverage.find((c) => c.dimension === dim)!.undocumented.slice(0, 5)) {
            const investigated = ent.subjects.some((s) => significantTerms([s]).some((t) => lookedUp.has(t)));
            suggestions.push({
                kind: "UNDOCUMENTED_ENTITY",
                priority: investigated ? "HIGH" : dim === "concepts" || dim === "decisions" ? "MEDIUM" : "LOW",
                category: CAT_FOR_DIM[dim],
                title: `${LABELS[dim].replace(/ \(.*\)/, "")}: ${ent.label ?? ent.name}`,
                why: investigated ? "Recorded in the project spec, undocumented in .mcp, and you have looked it up before." : "Recorded in the project spec but not described in .mcp.",
                evidence: ent.label ?? ent.name, applies_to: ent.subjects.filter((s) => s.length >= 3).slice(0, 4),
                next_step: `record_project_knowledge(category: "${CAT_FOR_DIM[dim]}", ..., applies_to: ${JSON.stringify(ent.subjects.slice(0, 3))}). Describe why it is this way, not just that it exists.`,
            });
        }
    }
    // Anomalies: one suggestion per kind (40 tables owned by several services is ONE question), unless someone has actually looked at it.
    const KIND_LABEL: Record<string, string> = {
        TABLE_MULTI_OWNER: "tables owned by several services", TOPIC_MULTI_PRODUCER: "topics with several producers",
        TOPIC_NO_CONSUMER: "topics produced but never consumed", TOPIC_NO_PRODUCER: "topics consumed but never produced",
        UNRESOLVED: "unresolved (CONFLICT / NOT_CONFIRMED) values", UNKNOWN_CALL_TARGET: "calls to unknown services", FLAG: "manual-review flags",
    };
    const groups = new Map<string, DiscoveredEntity[]>();
    for (const ent of coverage.find((c) => c.dimension === "exceptions")!.undocumented) {
        const investigated = ent.subjects.some((s) => significantTerms([s]).some((t) => lookedUp.has(t)));
        const kind = ent.name.split(":")[0];
        if (investigated) {
            suggestions.push({
                kind: "UNDOCUMENTED_EXCEPTION", priority: "HIGH", category: "known-exceptions",
                title: `Known exception: ${ent.label ?? ent.name}`, why: "An anomaly in the project spec, undocumented in .mcp, that you have looked up before.",
                evidence: ent.label ?? ent.name, applies_to: ent.subjects.filter((x) => x.length >= 3).slice(0, 4),
                next_step: `record_project_knowledge(category: "known-exceptions", ..., applies_to: ${JSON.stringify(ent.subjects.slice(0, 3))}). Say why it is intentional, or that it is a defect to fix instead.`,
            });
        } else groups.set(kind, [...(groups.get(kind) ?? []), ent]);
    }
    for (const [kind, ents] of groups) {
        suggestions.push({
            kind: "UNDOCUMENTED_EXCEPTION", priority: "LOW", category: "known-exceptions",
            title: `${ents.length} ${KIND_LABEL[kind] ?? kind} to review`,
            why: "Anomalies the project spec exposes. Each is either intentional (record it so nobody 'fixes' it) or a defect (fix it); neither is known yet.",
            evidence: ents.slice(0, 3).map((e) => e.label ?? e.name).join(" | ") + (ents.length > 3 ? ` | +${ents.length - 3} more` : ""),
            applies_to: ents.slice(0, 4).flatMap((e) => e.subjects.slice(0, 1)),
            next_step: `Review them, then record the intentional ones: record_project_knowledge(category: "known-exceptions", ..., applies_to: [...]). Do not record one you have not verified.`,
        });
    }
    for (const t of tribal) {
        suggestions.push({
            kind: "TRIBAL_SECTION", priority: "MEDIUM", category: t.suggested_category,
            title: `Move "${t.heading}" out of ${t.file}`, why: `${t.file} line ${t.line}: ${t.reason}.`, evidence: t.entities.join(", "),
            applies_to: t.entities.slice(0, 4),
            next_step: `Record its content with record_project_knowledge(category: "${t.suggested_category}", status: accepted needs the user's words), then replace the section with a pointer.`,
        });
    }
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    suggestions.sort((a, b) => rank[a.priority] - rank[b.priority]);

    return { coverage, totals, by_category, tribal, repeated, unreconciled_graph_names: unreconciled, suggestions };
}

export function renderHealth(h: HealthReport, opts: { detail?: boolean } = {}): string {
    const L: string[] = [];
    L.push(`## Project intelligence health`);
    L.push(`**Coverage: ${h.totals.documented} of ${h.totals.discovered} discovered entities documented** (${h.totals.proposed_only} with unreviewed entries only, ${h.totals.undocumented} undocumented).`);
    L.push("");
    L.push("| Dimension | Discovered | Documented | Proposed only | Undocumented |");
    L.push("|---|---|---|---|---|");
    for (const c of h.coverage.filter((x) => HEADLINE_DIMENSIONS.includes(x.dimension))) L.push(`| ${c.label} | ${c.discovered} | ${c.documented} | ${c.proposed_only} | ${c.undocumented.length} |`);
    const ex = h.coverage.find((c) => c.dimension === "exceptions")!;
    L.push("");
    L.push(`**Known-exception candidates (not in the coverage line):** ${ex.discovered} anomalies detected in the spec; ${ex.documented + ex.proposed_only} have a known-exception entry, ${ex.undocumented.length} do not. These are unconfirmed: some may be benign.`);
    L.push("");
    L.push(`_${COVERAGE_DEFINITION}_`);
    const entries = Object.entries(h.by_category).map(([c, v]) => `${c} ${v.total} (${v.accepted} accepted${v.proposed ? `, ${v.proposed} proposed` : ""})`).join(" · ");
    L.push(`\n**Entries:** ${entries}`);

    const gaps = h.coverage.filter((c) => c.undocumented.length && HEADLINE_DIMENSIONS.includes(c.dimension));
    if (gaps.length) {
        L.push("\n**Knowledge gaps**");
        for (const c of gaps) {
            const shown = c.undocumented.slice(0, opts.detail ? 50 : 4).map((u) => `\`${(u.label ?? u.name).replace(/`/g, "'")}\``);
            L.push(`- ${c.label} (${c.undocumented.length}): ${shown.join(", ")}${c.undocumented.length > shown.length ? `, +${c.undocumented.length - shown.length} more` : ""}`);
        }
    }
    if (h.repeated.length) {
        L.push("\n**Repeatedly investigated, no accepted knowledge**");
        for (const r of h.repeated.slice(0, 5)) L.push(`- ${r.terms.slice(0, 5).join(", ")}: ${r.count} lookups (${r.first.slice(0, 10)} to ${r.last.slice(0, 10)})`);
    }
    if (h.tribal.length) {
        L.push("\n**Tribal-knowledge candidates in the agent file** (project-specific sections that belong in .mcp)");
        for (const t of h.tribal.slice(0, opts.detail ? 12 : 5)) L.push(`- ${t.file}:${t.line} "${t.heading}": ${t.reason} → \`${t.suggested_category}/\``);
    }
    if (h.unreconciled_graph_names.length) {
        L.push(`\n**Unreconciled graph names** (in the knowledge graph, not in the spec; not counted above): ${h.unreconciled_graph_names.slice(0, 8).join(", ")}${h.unreconciled_graph_names.length > 8 ? ", …" : ""}`);
    }
    return L.join("\n");
}

export function renderSuggestions(s: Suggestion[], limit = 8): string {
    if (!s.length) return "💡 No knowledge suggestions: every discovered entity is documented and nothing has been investigated repeatedly.";
    return `💡 ${Math.min(limit, s.length)} of ${s.length} suggestion(s) to turn what is known into project knowledge\n\n` +
        s.slice(0, limit).map((x, i) => `${i + 1}. **[${x.priority}] ${x.title}** (${x.category})\n   Why: ${x.why}\n   Evidence: ${x.evidence}\n   Next: ${x.next_step}`).join("\n\n");
}

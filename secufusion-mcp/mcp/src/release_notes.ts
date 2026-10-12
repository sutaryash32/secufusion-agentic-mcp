import fs from "fs";
import path from "path";

/**
 * Change-driven release notes.
 *
 * A release is a changelog, not a repository scan. This module snapshots the project's
 * recorded state (spec, migrations, DNA counts), diffs it against the previous release's
 * snapshot, and renders the delta first. Everything detectable is computed, not written by
 * the LLM. The LLM supplies only what code cannot know (why the release exists, what was
 * fixed, what was deprecated), and those items are labelled as author-provided.
 *
 * Nothing is invented: a section with no changes says so.
 */

export interface FieldSet { scalars: Record<string, string>; lists: Record<string, string[]> }

export interface ServiceFacts extends FieldSet {
    tables: string[];
    calls: string[];
    produces: string[];
    consumes: string[];
}

export interface ReleaseSnapshot {
    version: string;
    captured_at: string;
    services: Record<string, ServiceFacts>;
    topics: Record<string, { producers: string[]; consumers: string[] }>;
    rules: Record<string, string>;
    terminology: Record<string, string>;
    other: Record<string, string>;
    migrations: Record<string, string>;
    dna: { nodes: number; edges: number; by_type: Record<string, number> } | null;
    flags: string[];
}

const SKIP_OTHER = new Set(["_meta", "_changelog", "microservices", "kafka_topics", "golden_rules", "terminology", "manual_review_flags", "cross_service_call_graph", "meta"]);
const MAX_OTHER = 400;

// ── extraction ──────────────────────────────────────────────────────────────

function flatten(v: any, prefix: string, set: FieldSet, depth = 0): void {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== "object")) { set.lists[prefix] = v.map(String).sort(); return; }
        v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, set, depth + 1));
        return;
    }
    if (typeof v === "object") {
        if (depth >= 4) { set.scalars[prefix] = JSON.stringify(v).slice(0, 200); return; }
        for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, set, depth + 1);
        return;
    }
    set.scalars[prefix] = String(v);
}

/** [41,42,43,47] -> "41-43, 47" */
export function compressRanges(nums: number[]): string {
    const n = [...new Set(nums.map(Number))].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < n.length; i++) {
        let j = i;
        while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
        out.push(j > i ? `${n[i]}-${n[j]}` : `${n[i]}`);
        i = j;
    }
    return out.join(", ");
}

const asList = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v && typeof v === "object" ? Object.keys(v) : typeof v === "string" && v ? [v] : []);

export function extractSnapshot(version: string, spec: any, migrations?: any, dna?: any): ReleaseSnapshot {
    const snap: ReleaseSnapshot = {
        version, captured_at: new Date().toISOString(),
        services: {}, topics: {}, rules: {}, terminology: {}, other: {}, migrations: {}, dna: null, flags: [],
    };
    spec = spec && typeof spec === "object" ? spec : {};

    for (const [name, raw] of Object.entries<any>(spec.microservices ?? {})) {
        const set: FieldSet = { scalars: {}, lists: {} };
        flatten(raw, "", set);
        const produces = asList(raw?.kafka_produces), consumes = asList(raw?.kafka_consumes);
        const calls = [...new Set([...asList(raw?.direct_rest_calls), ...asList(raw?.calls_services)])].sort();
        const tables = asList(raw?.owns_tables).sort();
        snap.services[name] = { ...set, tables, calls, produces: produces.sort(), consumes: consumes.sort() };
    }
    for (const [edge] of Object.entries<any>(spec.cross_service_call_graph ?? {})) {
        const m = /^\s*(.+?)\s*->\s*(.+?)\s*$/.exec(edge);
        if (m && snap.services[m[1]] && !snap.services[m[1]].calls.includes(m[2])) snap.services[m[1]].calls.push(m[2]);
    }

    const topic = (n: string) => (snap.topics[n] ??= { producers: [], consumers: [] });
    for (const [t, raw] of Object.entries<any>(spec.kafka_topics ?? {})) {
        topic(t).producers.push(...asList(raw?.producers));
        topic(t).consumers.push(...asList(raw?.consumers));
    }
    for (const [svc, f] of Object.entries(snap.services)) {
        f.produces.forEach((t) => topic(t).producers.push(svc));
        f.consumes.forEach((t) => topic(t).consumers.push(svc));
    }
    for (const t of Object.values(snap.topics)) { t.producers = [...new Set(t.producers)].sort(); t.consumers = [...new Set(t.consumers)].sort(); }

    for (const [id, raw] of Object.entries<any>(spec.golden_rules ?? {})) {
        snap.rules[id] = typeof raw === "string" ? raw
            : raw && typeof raw === "object" ? [raw.severity ? `[${raw.severity}]` : "", raw.rule ?? "", raw.reason ? `(why: ${raw.reason})` : ""].filter(Boolean).join(" ")
            : String(raw);
    }
    const tset: FieldSet = { scalars: {}, lists: {} };
    flatten(spec.terminology ?? {}, "", tset);
    Object.entries(tset.scalars).forEach(([k, v]) => { snap.terminology[k] = v; });
    Object.entries(tset.lists).forEach(([k, v]) => { snap.terminology[k] = v.join(" | "); });

    const oset: FieldSet = { scalars: {}, lists: {} };
    for (const [k, v] of Object.entries(spec)) if (!SKIP_OTHER.has(k)) flatten(v, k, oset);
    for (const [k, v] of Object.entries(oset.scalars).slice(0, MAX_OTHER)) snap.other[k] = v;
    for (const [k, v] of Object.entries(oset.lists).slice(0, MAX_OTHER)) snap.other[k] = v.join(", ");

    snap.flags = asList(spec.manual_review_flags).map((f) => (typeof f === "string" ? f : JSON.stringify(f)).slice(0, 300));

    // `microservices` is what generateMigrationSpec writes; `services` is the older hand-written shape.
    const migServices = migrations?.microservices ?? migrations?.services ?? {};
    for (const [svc, raw] of Object.entries<any>(migServices)) {
        const latest = raw?.current_state?.latest_version ?? raw?.current_state?.latest ?? null;
        const total = raw?.organization?.total_scripts ?? null;
        const gaps = raw?.organization?.version_gaps;
        const parts = [
            latest !== null && latest !== undefined ? `latest V${latest}` : "",
            total !== null && total !== undefined ? `${total} script(s)` : "",
            Array.isArray(gaps) && gaps.length ? `gaps ${compressRanges(gaps)}` : "",
        ].filter(Boolean);
        if (parts.length) snap.migrations[svc] = parts.join("; ");
    }

    const g = dna?.graph ?? dna;
    if (g && Array.isArray(g.nodes)) {
        const by: Record<string, number> = {};
        for (const n of g.nodes) by[n.type ?? "UNKNOWN"] = (by[n.type ?? "UNKNOWN"] ?? 0) + 1;
        snap.dna = { nodes: g.nodes.length, edges: Array.isArray(g.edges) ? g.edges.length : 0, by_type: by };
    }
    return snap;
}

// ── risks (deterministic, per snapshot) ─────────────────────────────────────

export interface Risk { id: string; text: string }

export function computeRisks(s: ReleaseSnapshot): Risk[] {
    const risks: Risk[] = [];
    for (const [t, v] of Object.entries(s.topics)) {
        if (v.producers.length && !v.consumers.length) risks.push({ id: `TOPIC_NO_CONSUMER:${t}`, text: `Topic \`${t}\` is produced by ${v.producers.join(", ")} but has no consumer` });
        if (v.consumers.length && !v.producers.length) risks.push({ id: `TOPIC_NO_PRODUCER:${t}`, text: `Topic \`${t}\` is consumed by ${v.consumers.join(", ")} but has no producer` });
        if (v.producers.length > 1) risks.push({ id: `TOPIC_MULTI_PRODUCER:${t}`, text: `Topic \`${t}\` has ${v.producers.length} producers (${v.producers.join(", ")})` });
    }
    const owners: Record<string, string[]> = {};
    for (const [svc, f] of Object.entries(s.services)) f.tables.forEach((tb) => (owners[tb] ??= []).push(svc));
    for (const [tb, o] of Object.entries(owners)) if (o.length > 1) risks.push({ id: `TABLE_MULTI_OWNER:${tb}`, text: `Table \`${tb}\` is owned by ${o.length} services (${o.join(", ")})` });
    for (const [svc, f] of Object.entries(s.services)) {
        for (const c of f.calls) if (!s.services[c] && /^[a-z][a-z0-9-]+$/.test(c)) risks.push({ id: `UNKNOWN_CALL_TARGET:${svc}->${c}`, text: `${svc} calls \`${c}\`, which is not a known service` });
        for (const [k, v] of Object.entries(f.scalars)) if (/\b(CONFLICT|NOT_CONFIRMED|UNKNOWN)\b/.test(v)) risks.push({ id: `UNRESOLVED:${svc}.${k}`, text: `${svc}.${k} is unresolved (${v.length > 90 ? v.slice(0, 89) + "…" : v})` });
    }
    s.flags.forEach((f) => risks.push({ id: `FLAG:${f.slice(0, 80)}`, text: `Manual-review flag: ${f.slice(0, 160)}` }));
    return risks;
}

// ── delta ───────────────────────────────────────────────────────────────────

export interface ValueChange { field: string; from: string; to: string }
export interface ListChange { field: string; added: string[]; removed: string[] }
export interface ServiceChange { name: string; values: ValueChange[]; lists: ListChange[] }

export interface Delta {
    baseline: boolean;
    from_version: string | null;
    to_version: string;
    services: { added: string[]; removed: string[]; changed: ServiceChange[] };
    topics: { added: string[]; removed: string[]; changed: Array<{ name: string; producers: ListChange; consumers: ListChange }> };
    rules: { added: Array<[string, string]>; removed: Array<[string, string]>; modified: Array<{ id: string; from: string; to: string }>; unchanged: string[] };
    terminology: { added: string[]; removed: string[]; modified: ValueChange[] };
    other: { added: string[]; removed: string[]; modified: ValueChange[] };
    migrations: { added: string[]; removed: string[]; modified: ValueChange[] };
    relationships: { added: string[]; removed: string[] };
    tables: { added: string[]; removed: string[] };
    dna: { nodes: number; edges: number; by_type: Record<string, number> } | null;
    risks: { introduced: Risk[]; resolved: Risk[]; persisting: number };
    resolved_ambiguities: ValueChange[];
    /** Dimensions that could not be compared because one side had no data. Never reported as "unchanged". */
    not_compared: string[];
    total: number;
}

const diffSet = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
const diffMap = (a: Record<string, string>, b: Record<string, string>) => ({
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    modified: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).map((k) => ({ field: k, from: a[k], to: b[k] })),
});
const AMBIGUOUS = /\b(CONFLICT|NOT_CONFIRMED|UNKNOWN|TODO|TBD)\b/;

export function computeDelta(prev: ReleaseSnapshot | null, cur: ReleaseSnapshot): Delta {
    const empty: Delta = {
        baseline: !prev, from_version: prev?.version ?? null, to_version: cur.version,
        services: { added: [], removed: [], changed: [] }, topics: { added: [], removed: [], changed: [] },
        rules: { added: [], removed: [], modified: [], unchanged: [] }, terminology: { added: [], removed: [], modified: [] },
        other: { added: [], removed: [], modified: [] }, migrations: { added: [], removed: [], modified: [] },
        relationships: { added: [], removed: [] }, tables: { added: [], removed: [] }, dna: null,
        risks: { introduced: [], resolved: [], persisting: 0 }, resolved_ambiguities: [], not_compared: [], total: 0,
    };
    if (!prev) { empty.dna = cur.dna; return empty; }
    const d = empty;

    const sv = diffSet(Object.keys(prev.services), Object.keys(cur.services));
    d.services.added = sv.added; d.services.removed = sv.removed;
    for (const name of Object.keys(cur.services).filter((n) => n in prev.services)) {
        const a = prev.services[name], b = cur.services[name];
        const vm = diffMap(a.scalars, b.scalars);
        const values: ValueChange[] = [...vm.modified, ...vm.added.map((f) => ({ field: f, from: "(unset)", to: b.scalars[f] })), ...vm.removed.map((f) => ({ field: f, from: a.scalars[f], to: "(removed)" }))];
        const lists: ListChange[] = [];
        for (const f of new Set([...Object.keys(a.lists), ...Object.keys(b.lists)])) {
            const ch = diffSet(a.lists[f] ?? [], b.lists[f] ?? []);
            if (ch.added.length || ch.removed.length) lists.push({ field: f, ...ch });
        }
        if (values.length || lists.length) d.services.changed.push({ name, values, lists });
        for (const v of values) if (AMBIGUOUS.test(v.from) && !AMBIGUOUS.test(v.to) && v.to !== "(removed)") d.resolved_ambiguities.push({ field: `${name}.${v.field}`, from: v.from, to: v.to });
        const tb = diffSet(a.tables, b.tables);
        tb.added.forEach((t) => d.tables.added.push(`${t} (${name})`)); tb.removed.forEach((t) => d.tables.removed.push(`${t} (${name})`));
        const rel = diffSet(a.calls, b.calls);
        rel.added.forEach((c) => d.relationships.added.push(`${name} → ${c}`)); rel.removed.forEach((c) => d.relationships.removed.push(`${name} → ${c}`));
    }
    for (const n of d.services.added) {
        cur.services[n].tables.forEach((t) => d.tables.added.push(`${t} (${n})`));
        cur.services[n].calls.forEach((c) => d.relationships.added.push(`${n} → ${c}`));
    }
    for (const n of d.services.removed) {
        prev.services[n].tables.forEach((t) => d.tables.removed.push(`${t} (${n})`));
        prev.services[n].calls.forEach((c) => d.relationships.removed.push(`${n} → ${c}`));
    }

    const tp = diffSet(Object.keys(prev.topics), Object.keys(cur.topics));
    d.topics.added = tp.added; d.topics.removed = tp.removed;
    for (const t of Object.keys(cur.topics).filter((n) => n in prev.topics)) {
        const p = diffSet(prev.topics[t].producers, cur.topics[t].producers), c = diffSet(prev.topics[t].consumers, cur.topics[t].consumers);
        if (p.added.length || p.removed.length || c.added.length || c.removed.length) d.topics.changed.push({ name: t, producers: { field: "producers", ...p }, consumers: { field: "consumers", ...c } });
    }

    for (const [id, text] of Object.entries(cur.rules)) {
        if (!(id in prev.rules)) d.rules.added.push([id, text]);
        else if (prev.rules[id] !== text) d.rules.modified.push({ id, from: prev.rules[id], to: text });
        else d.rules.unchanged.push(id);
    }
    for (const [id, text] of Object.entries(prev.rules)) if (!(id in cur.rules)) d.rules.removed.push([id, text]);

    const tm = diffMap(prev.terminology, cur.terminology);
    d.terminology = { added: tm.added, removed: tm.removed, modified: tm.modified };
    const ot = diffMap(prev.other, cur.other);
    d.other = { added: ot.added, removed: ot.removed, modified: ot.modified };
    const prevMig = Object.keys(prev.migrations).length > 0, curMig = Object.keys(cur.migrations).length > 0;
    if (prevMig && curMig) {
        const mg = diffMap(prev.migrations, cur.migrations);
        d.migrations = { added: mg.added, removed: mg.removed, modified: mg.modified };
    } else if (prevMig !== curMig) {
        d.not_compared.push(prevMig ? "migrations (no migration data in the current state)" : "migrations (the earlier release recorded no migration data)");
    }

    if (!!prev.dna !== !!cur.dna) d.not_compared.push(prev.dna ? "knowledge graph (not available now)" : "knowledge graph (the earlier release recorded none)");
    if (prev.dna && cur.dna) {
        const by: Record<string, number> = {};
        for (const t of new Set([...Object.keys(prev.dna.by_type), ...Object.keys(cur.dna.by_type)])) {
            const diff = (cur.dna.by_type[t] ?? 0) - (prev.dna.by_type[t] ?? 0);
            if (diff) by[t] = diff;
        }
        d.dna = { nodes: cur.dna.nodes - prev.dna.nodes, edges: cur.dna.edges - prev.dna.edges, by_type: by };
    }

    const before = computeRisks(prev), after = computeRisks(cur);
    const beforeIds = new Set(before.map((r) => r.id)), afterIds = new Set(after.map((r) => r.id));
    d.risks.introduced = after.filter((r) => !beforeIds.has(r.id));
    const fixedAmbiguity = new Set(d.resolved_ambiguities.map((a) => `UNRESOLVED:${a.field}`));
    d.risks.resolved = before.filter((r) => !afterIds.has(r.id) && !fixedAmbiguity.has(r.id));
    d.risks.persisting = after.filter((r) => beforeIds.has(r.id)).length;

    d.total =
        d.services.added.length + d.services.removed.length + d.services.changed.length +
        d.topics.added.length + d.topics.removed.length + d.topics.changed.length +
        d.rules.added.length + d.rules.removed.length + d.rules.modified.length +
        d.terminology.added.length + d.terminology.removed.length + d.terminology.modified.length +
        d.other.added.length + d.other.removed.length + d.other.modified.length +
        d.migrations.added.length + d.migrations.removed.length + d.migrations.modified.length +
        d.relationships.added.length + d.relationships.removed.length + d.tables.added.length + d.tables.removed.length +
        d.risks.introduced.length + d.risks.resolved.length;
    return d;
}

// ── rendering ───────────────────────────────────────────────────────────────

export interface Narrative {
    summary?: string;
    why?: string;
    added?: string[];
    changed?: string[];
    fixed?: string[];
    removed?: string[];
    risks?: string[];
    discoveries?: string[];
    rule_notes?: string[];
}

const cap = <T>(items: T[], n = 25): { shown: T[]; more: number } => ({ shown: items.slice(0, n), more: Math.max(0, items.length - n) });
const bullets = (items: string[], n = 25): string => {
    const { shown, more } = cap(items, n);
    return shown.map((i) => `- ${i}`).join("\n") + (more ? `\n- …and ${more} more` : "");
};
const trunc = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const code = (s: string) => `\`${s}\``;
const section = (title: string, count: number | null, body: string[], authored: string[] | undefined, none: string): string => {
    const lines = [...body];
    const items = authored?.filter(Boolean) ?? [];
    if (items.length) lines.push(`**Author notes**\n${bullets(items)}`);
    const n = (count ?? 0) + items.length;
    return `## ${title}${count === null ? "" : ` (${n})`}\n${lines.length ? lines.join("\n\n") : none}\n`;
};

export interface RenderInput {
    version: string;
    previous_version: string | null;
    date: string;
    delta: Delta;
    current: ReleaseSnapshot;
    narrative?: Narrative;
    include_snapshot?: boolean;
    /** Pre-rendered "What this MCP version brings" section (see mcp_release_info.ts). */
    mcp_release?: string;
}

export function renderReleaseNotes(i: RenderInput): string {
    const { delta: d, narrative: nar = {}, current: cur } = i;
    const prev = i.previous_version ? `v${i.previous_version.replace(/^v/, "")}` : null;
    const ver = `v${i.version.replace(/^v/, "")}`;
    const NO_BASE = "No earlier release to compare against, so no change is claimed here.";

    // ── Executive summary: why, then how much
    const parts: string[] = [];
    if (nar.summary?.trim()) parts.push(nar.summary.trim());
    if (nar.why?.trim()) parts.push(`**Why this release exists:** ${nar.why.trim()}`);
    else parts.push("**Why this release exists:** _not stated by the author._");
    if (d.baseline) {
        parts.push(`**First recorded release.** There is no earlier snapshot, so no delta can be computed. This note establishes the baseline (${Object.keys(cur.services).length} services, ${Object.keys(cur.topics).length} topics, ${Object.keys(cur.rules).length} rules); future releases will be compared against it.`);
    } else if (d.total === 0 && !(nar.added?.length || nar.changed?.length || nar.fixed?.length || nar.removed?.length || nar.discoveries?.length || nar.risks?.length)) {
        const compared = d.not_compared.length === 0
            ? "No service, topic, rule, terminology, mapping, migration or risk changed."
            : "No service, topic, rule, terminology, mapping or risk changed.";
        parts.push(`**No significant changes since ${prev}.** ${compared} The detailed snapshot below is unchanged and is included for reference.`);
    } else {
        const bits = (pairs: Array<[number, string]>) => pairs.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(", ");
        const addedBits = bits([[d.services.added.length, "service(s)"], [d.topics.added.length, "topic(s)"], [d.rules.added.length, "rule(s)"], [d.terminology.added.length, "terminology entr(ies)"]]);
        const changedBits = bits([[d.services.changed.length, "service(s)"], [d.topics.changed.length, "topic(s)"], [d.rules.modified.length, "rule(s)"], [d.terminology.modified.length + d.other.modified.length, "setting(s)"]]);
        const removedBits = bits([[d.services.removed.length, "service(s)"], [d.topics.removed.length, "topic(s)"], [d.rules.removed.length, "rule(s)"]]);
        const q = [
            `added: ${addedBits || "nothing"}`,
            `changed: ${changedBits || "nothing"}`,
            `removed: ${removedBits || "nothing"}`,
            `${d.resolved_ambiguities.length + d.risks.resolved.length} resolved, ${d.risks.introduced.length} new risk(s)`,
        ];
        parts.push(`**${d.total} detected change(s) since ${prev}** (${q.join("; ")}). Rules: ${d.rules.added.length} added, ${d.rules.modified.length} modified, ${d.rules.removed.length} removed, ${d.rules.unchanged.length} unchanged.`);
    }

    if (!d.baseline && d.not_compared.length) {
        parts.push(`**Not compared:** ${d.not_compared.join("; ")}. Changes there are not reported in this release; they are not claimed to be absent.`);
    }

    // ── Added
    const added: string[] = [];
    if (d.rules.added.length) added.push(`**Rules (${d.rules.added.length})**\n${bullets(d.rules.added.map(([id, t]) => `${code(id)}: ${trunc(t)}`))}`);
    if (d.terminology.added.length) added.push(`**Terminology (${d.terminology.added.length})**\n${bullets(d.terminology.added.map(code))}`);
    const newMappings = d.services.changed.flatMap((c) => c.lists.filter((l) => l.added.length).map((l) => `${code(c.name)} ${l.field}: +${l.added.join(", ")}`));
    if (newMappings.length) added.push(`**New mappings on existing services (${newMappings.length})**\n${bullets(newMappings)}`);
    if (d.other.added.length) added.push(`**New configuration (${d.other.added.length})**\n${bullets(d.other.added.map(code))}`);
    if (d.migrations.added.length) added.push(`**Migration tracking (${d.migrations.added.length})**\n${bullets(d.migrations.added.map(code))}`);
    if (d.services.added.length || d.topics.added.length) added.push(`New services and topics are listed under *Repository Intelligence Updates* (${d.services.added.length} service(s), ${d.topics.added.length} topic(s)).`);
    const addedCount = d.rules.added.length + d.terminology.added.length + newMappings.length + d.other.added.length + d.migrations.added.length;

    // ── Changed
    const changed: string[] = [];
    const svcChanges: string[] = [];
    const isFixed = (name: string, field: string) => d.resolved_ambiguities.some((a) => a.field === `${name}.${field}`);
    let svcShown = 0;
    for (const c of d.services.changed) {
        const before = svcChanges.length;
        for (const v of c.values.filter((x) => !isFixed(c.name, x.field))) svcChanges.push(`${code(c.name)} ${v.field}: ${trunc(v.from, 80)} → ${trunc(v.to, 80)}`);
        for (const l of c.lists) if (l.removed.length) svcChanges.push(`${code(c.name)} ${l.field}: −${l.removed.join(", ")}${l.added.length ? ` / +${l.added.join(", ")}` : ""}`);
        if (svcChanges.length > before) svcShown++;
    }
    if (svcChanges.length) changed.push(`**Services (${svcShown})**\n${bullets(svcChanges)}`);
    if (d.topics.changed.length) {
        changed.push(`**Topic topology (${d.topics.changed.length})**\n` + bullets(d.topics.changed.map((t) => `${code(t.name)}: ` + [
            t.producers.added.length ? `producers +${t.producers.added.join(", ")}` : "", t.producers.removed.length ? `producers −${t.producers.removed.join(", ")}` : "",
            t.consumers.added.length ? `consumers +${t.consumers.added.join(", ")}` : "", t.consumers.removed.length ? `consumers −${t.consumers.removed.join(", ")}` : "",
        ].filter(Boolean).join("; "))));
    }
    if (d.terminology.modified.length) changed.push(`**Terminology (${d.terminology.modified.length})**\n${bullets(d.terminology.modified.map((v) => `${code(v.field)}: ${trunc(v.from, 70)} → ${trunc(v.to, 70)}`))}`);
    if (d.other.modified.length) changed.push(`**Configuration (${d.other.modified.length})**\n${bullets(d.other.modified.map((v) => `${code(v.field)}: ${trunc(v.from, 70)} → ${trunc(v.to, 70)}`))}`);
    if (d.migrations.modified.length) changed.push(`**Migrations (${d.migrations.modified.length})**\n${bullets(d.migrations.modified.map((v) => `${code(v.field)}: ${v.from} → ${v.to}`))}`);
    if (d.rules.modified.length) changed.push(`Rule edits are detailed under *Rule Changes* (${d.rules.modified.length}).`);
    const changedCount = svcShown + d.topics.changed.length + d.terminology.modified.length + d.other.modified.length + d.migrations.modified.length;

    // ── Fixed
    const fixed: string[] = [];
    if (d.resolved_ambiguities.length) fixed.push(`**Ambiguities resolved (${d.resolved_ambiguities.length})**\n${bullets(d.resolved_ambiguities.map((v) => `${code(v.field)}: ${trunc(v.from, 80)} → ${trunc(v.to, 80)}`))}`);
    if (d.risks.resolved.length) fixed.push(`${d.risks.resolved.length} risk(s) were also resolved; they are listed under *Risks*.`);
    const fixedCount = d.resolved_ambiguities.length;

    // ── Removed
    const removed: string[] = [];
    if (d.services.removed.length) removed.push(`**Services (${d.services.removed.length})**\n${bullets(d.services.removed.map(code))}`);
    if (d.topics.removed.length) removed.push(`**Topics (${d.topics.removed.length})**\n${bullets(d.topics.removed.map(code))}`);
    if (d.rules.removed.length) removed.push(`**Rules (${d.rules.removed.length})**\n${bullets(d.rules.removed.map(([id, t]) => `${code(id)}: ${trunc(t)}`))}`);
    if (d.terminology.removed.length) removed.push(`**Terminology (${d.terminology.removed.length})**\n${bullets(d.terminology.removed.map(code))}`);
    if (d.other.removed.length) removed.push(`**Configuration (${d.other.removed.length})**\n${bullets(d.other.removed.map(code))}`);
    const lostMappings = d.services.changed.flatMap((c) => c.lists.filter((l) => l.removed.length).map((l) => `${code(c.name)} ${l.field}: −${l.removed.join(", ")}`));
    if (lostMappings.length) removed.push(`**Mappings dropped from existing services (${lostMappings.length})**\n${bullets(lostMappings)}`);
    const removedCount = d.services.removed.length + d.topics.removed.length + d.rules.removed.length + d.terminology.removed.length + d.other.removed.length + lostMappings.length;

    // ── Risks
    const risks: string[] = [];
    if (d.risks.introduced.length) risks.push(`**Introduced (${d.risks.introduced.length})**\n${bullets(d.risks.introduced.map((r) => r.text))}`);
    if (d.risks.resolved.length) risks.push(`**Resolved (${d.risks.resolved.length})**\n${bullets(d.risks.resolved.map((r) => r.text))}`);
    if (!d.baseline) risks.push(`Net: ${d.risks.introduced.length} introduced, ${d.risks.resolved.length} resolved, ${d.risks.persisting} unchanged.`);
    else risks.push(`Risks present at baseline: ${computeRisks(cur).length}.`);

    // ── Repository intelligence
    const intel: string[] = [];
    if (d.services.added.length) intel.push(`**New services (${d.services.added.length})**\n${bullets(d.services.added.map((n) => { const s = cur.services[n]; return `${code(n)}${s.scalars["language"] ? ` (${s.scalars["language"]})` : ""}${s.tables.length ? `, owns ${s.tables.length} table(s)` : ""}${s.produces.length || s.consumes.length ? `, ${s.produces.length} produced / ${s.consumes.length} consumed topic(s)` : ""}`; }))}`);
    if (d.topics.added.length) intel.push(`**New topics (${d.topics.added.length})**\n${bullets(d.topics.added.map((t) => `${code(t)}: producers ${cur.topics[t].producers.join(", ") || "none"}; consumers ${cur.topics[t].consumers.join(", ") || "none"}`))}`);
    if (d.relationships.added.length) intel.push(`**New service relationships (${d.relationships.added.length})**\n${bullets(d.relationships.added)}`);
    if (d.relationships.removed.length) intel.push(`**Relationships no longer present (${d.relationships.removed.length})**\n${bullets(d.relationships.removed)}`);
    if (d.tables.added.length) intel.push(`**Table ownership discovered (${d.tables.added.length})**\n${bullets(d.tables.added)}`);
    if (d.tables.removed.length) intel.push(`**Table ownership dropped (${d.tables.removed.length})**\n${bullets(d.tables.removed)}`);
    if (d.dna && (d.dna.nodes || d.dna.edges)) {
        const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
        intel.push(`**Knowledge graph:** ${sign(d.dna.nodes)} nodes, ${sign(d.dna.edges)} edges` + (Object.keys(d.dna.by_type).length ? ` (${Object.entries(d.dna.by_type).map(([t, n]) => `${t} ${sign(n)}`).join(", ")})` : "") + ".");
    }
    const intelCount = d.services.added.length + d.topics.added.length + d.relationships.added.length + d.relationships.removed.length + d.tables.added.length + d.tables.removed.length;

    // ── Rule changes
    const rules: string[] = [];
    rules.push(`| Added | Modified | Removed | Unchanged |\n|---|---|---|---|\n| ${d.rules.added.length} | ${d.rules.modified.length} | ${d.rules.removed.length} | ${d.rules.unchanged.length} |`);
    if (d.rules.added.length) rules.push(`**Added**\n${bullets(d.rules.added.map(([id, t]) => `${code(id)}: ${trunc(t, 200)}`))}`);
    if (d.rules.modified.length) rules.push(`**Modified**\n${d.rules.modified.map((r) => `- ${code(r.id)}\n  - before: ${trunc(r.from, 220)}\n  - after: ${trunc(r.to, 220)}`).join("\n")}`);
    if (d.rules.removed.length) rules.push(`**Removed**\n${bullets(d.rules.removed.map(([id, t]) => `${code(id)}: ${trunc(t, 200)}`))}`);
    if (d.rules.unchanged.length && d.rules.unchanged.length <= 12) rules.push(`**Unchanged:** ${d.rules.unchanged.map(code).join(", ")}`);
    if (nar.rule_notes?.length) rules.push(`**Author notes**\n${bullets(nar.rule_notes)}`);

    // ── snapshot (last, compact)
    let snapshot = "";
    if (i.include_snapshot !== false) {
        const hasLang = Object.values(cur.services).some((s) => s.scalars["language"] || s.scalars["framework"]);
        const svcRows = Object.entries(cur.services).slice(0, 40).map(([n, s]) => `| ${n} |${hasLang ? ` ${s.scalars["language"] ?? s.scalars["framework"] ?? "-"} |` : ""} ${s.scalars["port"] ? trunc(s.scalars["port"], 24) : "-"} | ${s.tables.length} | ${s.produces.length}/${s.consumes.length} |`).join("\n");
        snapshot = `## Detailed Snapshot\n_Current state, for auditing. Not a list of changes._\n\n| Services | Topics | Rules | Terminology entries | Open risks | Manual-review flags |\n|---|---|---|---|---|---|\n| ${Object.keys(cur.services).length} | ${Object.keys(cur.topics).length} | ${Object.keys(cur.rules).length} | ${Object.keys(cur.terminology).length} | ${computeRisks(cur).length} | ${cur.flags.length} |\n` +
            (cur.dna ? `\nKnowledge graph: ${cur.dna.nodes} nodes, ${cur.dna.edges} edges.\n` : "") +
            (svcRows ? (hasLang ? `\n| Service | Lang | Port | Tables | Topics out/in |\n|---|---|---|---|---|\n${svcRows}\n` : `\n| Service | Port | Tables | Topics out/in |\n|---|---|---|---|\n${svcRows}\n`) : "") +
            (Object.keys(cur.services).length > 40 ? `\n…and ${Object.keys(cur.services).length - 40} more services.\n` : "");
    }

    const none = d.baseline ? NO_BASE : "None.";
    return [
        `# Version ${ver.replace(/^v/, "")}`,
        `**Date:** ${i.date}${prev ? ` · **Previous:** ${prev}` : " · **Baseline release**"}\n`,
        `## Executive Summary\n${parts.join("\n\n")}\n`,
        i.mcp_release ?? "",
        section("Added", addedCount, added, nar.added, none),
        section("Changed", changedCount, changed, nar.changed, none),
        section("Fixed", fixedCount, fixed, nar.fixed, none),
        section("Removed / Deprecated", removedCount, removed, nar.removed, none),
        section("Risks", null, risks, nar.risks, none),
        section("Repository Intelligence Updates", intelCount, intel, nar.discoveries, none),
        `## Rule Changes\n${rules.join("\n\n")}\n`,
        snapshot,
        `---\n*Generated by \`generate_release_notes\`. Detected changes are computed from recorded state; "Author notes" are supplied by the author.*`,
    ].filter(Boolean).join("\n");
}

// ── snapshots on disk ───────────────────────────────────────────────────────

/** Release history belongs with the project (.mcp/release-history) when that layer exists; otherwise the legacy runtime folder. */
export function releasesDir(root: string): string {
    return fs.existsSync(path.join(root, ".mcp")) ? path.join(root, ".mcp", "release-history") : path.join(root, ".secufusion", "releases");
}
const legacyDir = (root: string) => path.join(root, ".secufusion", "releases");
const snapDir = (root: string) => path.join(releasesDir(root), "snapshots");
const snapDirs = (root: string) => [...new Set([snapDir(root), path.join(legacyDir(root), "snapshots")])];

export function saveSnapshot(root: string, snap: ReleaseSnapshot): string {
    fs.mkdirSync(snapDir(root), { recursive: true });
    const p = path.join(snapDir(root), `v${snap.version.replace(/^v/, "")}.json`);
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    return p;
}

export function loadSnapshot(root: string, version: string): ReleaseSnapshot | null {
    for (const d of snapDirs(root)) {
        try { return JSON.parse(fs.readFileSync(path.join(d, `v${version.replace(/^v/, "")}.json`), "utf-8")); } catch { /* try the next location */ }
    }
    return null;
}

const semver = (v: string) => v.replace(/^v/, "").split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
export function compareVersions(a: string, b: string): number {
    const x = semver(a), y = semver(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
    return 0;
}

/** The newest stored snapshot strictly older than `version`. */
export function findPreviousSnapshot(root: string, version: string): ReleaseSnapshot | null {
    const all = snapDirs(root).filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d));
    const versions = [...new Set(all.filter((f) => f.endsWith(".json")).map((f) => f.replace(/^v|\.json$/g, "")))]
        .filter((v) => compareVersions(v, version) < 0).sort(compareVersions);
    const last = versions[versions.length - 1];
    return last ? loadSnapshot(root, last) : null;
}

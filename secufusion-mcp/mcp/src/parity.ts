/**
 * Client Review Parity Suite.
 *
 * The question is not "did the review find a bug" but "would it have written the client's comment, before seeing it?".
 *
 *   Benchmark   a completed review. purpose "parity" (an unseen story, the client's real comments, pre-review code) or
 *               "design-validation" (anything else: useful to improve the reviewer, never a parity claim).
 *   Run         the findings a review derived and SEALED before the comments were revealed, plus a judgment per comment.
 *   Judgment    MATCH / PARTIAL / MISS per client comment. A comment is MATCHED only if all four hold:
 *                 1. the same entity is identified
 *                 2. the same business consequence is derived
 *                 3. the same unsupported state is identified
 *                 4. the resulting review comment is materially equivalent
 *               Finding the dependency alone is not enough; finding the invariant alone is not enough. `reached` records how
 *               far the reasoning went (dependency < invariant < consequence < unsupported_state < comment): a comment that
 *               stopped at the dependency or the invariant can be at most PARTIAL.
 *               A MISS (and a PARTIAL) must name the step of the reasoning chain that failed and the smallest improvement
 *               that would continue the chain, or it is refused: nothing is built for a miss nobody has root-caused.
 *   Metrics     counts always; percentages only for a VALID run (blind, unseen, pre-review code, purpose parity).
 *   Regression  every client comment is a permanent test: the deterministic evidence still appears, and a new run may not
 *               lose a comment an earlier run matched.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { mapInvariantEnforcement, renderEnforcement } from "./invariant_enforcement.js";
import { inventoryEntityImpact, renderEntityImpact } from "./entity_impact.js";
import { mapFieldImpact, renderFieldImpact } from "./field_impact.js";
import { uiGating, renderGating, endpointConsumers, renderEndpointConsumers, serviceOwnership, renderOwnership, parentCascade, renderCascade } from "./parity_lenses.js";
import { buildFeatureModel, renderFeatureModel } from "./feature_model.js";

export const MISS_STEPS = ["Entity discovery", "Field discovery", "Consumer discovery", "Capability derivation", "Lifecycle reasoning", "Authority reasoning", "Consequence derivation", "Review formulation"] as const;
export type MissStep = (typeof MISS_STEPS)[number];
export type Grade = "MATCH" | "PARTIAL" | "MISS";
export type Severity = "BLOCKING" | "NON-BLOCKING" | "QUESTION" | "REQUIRES_DECISION";
export type Kind = "architecture" | "implementation" | "business";
export const REACH = ["dependency", "invariant", "consequence", "unsupported_state", "comment"] as const;
export type Reach = (typeof REACH)[number];

export interface EvidenceCheck { tool: string; args: Record<string, any>; must_match: string[]; note?: string }
export interface Concern {
    id: string; text: string; severity: Severity | "UNSPECIFIED"; kind: Kind; entity: string; consequence: string; unsupported_state?: string;
    /** the defect is already fixed in the code under review, so only the risk class can be derived from the code */
    fixed_in_code: boolean; evidence_checks: EvidenceCheck[]; source: string;
}
export interface Benchmark {
    id: string; title: string; purpose: "parity" | "design-validation"; story_chain: string[]; workspace_hint: string;
    pre_fix_available: boolean; answer_key: string; limitation: string; concerns: Concern[];
}
/** entity, consequence, unsupported_state and comment GATE a MATCH. root_cause, severity and remediation are scored beside them (undefined = not judged). */
export interface Criteria { entity: boolean; consequence: boolean; unsupported_state: boolean; comment: boolean; root_cause?: boolean; severity?: boolean; remediation?: boolean }
export interface Judgment {
    concern_id: string; grade: Grade; derived: number | null; reached: Reach | "nothing";
    criteria: Criteria; diverged_step?: MissStep; note: string; smallest_improvement?: string; downgraded_from?: Grade;
}
export interface DerivedFinding { title: string; category: Severity; entity?: string; text: string }
export interface Run {
    run_id: string; benchmark_id: string; at: string; blind: boolean; unseen_pack?: string | null; contamination: string;
    derived: DerivedFinding[]; derived_sha256: string; judgments: Judgment[];
}

// ── dataset location ────────────────────────────────────────────────────────

export function datasetDir(explicit?: string): string | null {
    const cands = [explicit, fileURLToPath(new URL("../../parity/", import.meta.url))].filter(Boolean) as string[];
    return cands.find((d) => fs.existsSync(d)) ?? null;
}
export function loadBenchmark(dir: string, id: string): Benchmark {
    return JSON.parse(fs.readFileSync(path.join(dir, "benchmarks", `${id}.json`), "utf-8"));
}
export function listBenchmarks(dir: string): string[] {
    const d = path.join(dir, "benchmarks");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort() : [];
}
export function loadRuns(dir: string, benchmark: string): Run[] {
    const d = path.join(dir, "runs");
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.startsWith(benchmark + ".") && f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf-8")));
}
export const hashDerived = (d: DerivedFinding[]) => crypto.createHash("sha256").update(JSON.stringify(d)).digest("hex");

// ── judging ─────────────────────────────────────────────────────────────────

const reachRank = (r: Reach | "nothing") => (r === "nothing" ? -1 : REACH.indexOf(r));
export function normalizeJudgment(j: Judgment): Judgment {
    const out: Judgment = { ...j, criteria: { ...j.criteria } };
    const c = out.criteria;
    const all = c.entity && c.consequence && c.unsupported_state && c.comment;
    const any = c.entity || c.consequence || c.unsupported_state || c.comment;
    if (out.grade === "MATCH") {
        // the dependency alone, or the invariant alone, is never a match: the chain must reach the comment
        if (!all || reachRank(out.reached) < REACH.indexOf("comment")) { out.downgraded_from = "MATCH"; out.grade = any && reachRank(out.reached) >= 0 ? "PARTIAL" : "MISS"; }
    } else if (out.grade === "PARTIAL" && !any && reachRank(out.reached) < 0) { out.downgraded_from = "PARTIAL"; out.grade = "MISS"; }
    if (out.grade === "MISS" || out.grade === "PARTIAL") {
        if (!out.diverged_step || !(MISS_STEPS as readonly string[]).includes(out.diverged_step)) throw new Error(`${out.concern_id}: a ${out.grade} must name the step of the reasoning chain where the review diverged (${MISS_STEPS.join(", ")}). Root-cause it before anything is built.`);
        if (!out.note?.trim()) throw new Error(`${out.concern_id}: a ${out.grade} needs a note: how far the chain went and what the review did instead, in one sentence.`);
        if (!out.smallest_improvement?.trim()) throw new Error(`${out.concern_id}: a ${out.grade} needs the smallest improvement that would continue the chain (or "none: <why>" if the material available cannot show it).`);
    }
    if (out.grade === "MISS") out.derived = null;
    return out;
}

export interface Metrics {
    comments: number; derived_findings: number; match: number; partial: number; miss: number;
    recall: number; lenient_recall: number; precision: number; dimension_agreement: { root_cause: number | null; severity: number | null; remediation: number | null }; blocking_recall: number | null; blocking_precision: number | null;
    consequence_recall: number; architecture_recall: number | null; steps: Record<string, number>;
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
export function computeMetrics(b: Benchmark, run: Run): Metrics {
    const js = run.judgments;
    const by = new Map(js.map((j) => [j.concern_id, j]));
    const n = b.concerns.length;
    const m = js.filter((j) => j.grade === "MATCH");
    const used = new Set(m.map((j) => j.derived).filter((x): x is number => x !== null));
    const blockingConcerns = b.concerns.filter((c) => c.severity === "BLOCKING");
    const blockingHit = blockingConcerns.filter((c) => { const j = by.get(c.id); return j && j.grade === "MATCH" && j.derived !== null && run.derived[j.derived]?.category === "BLOCKING"; });
    const derivedBlocking = run.derived.map((d, i) => ({ d, i })).filter((x) => x.d.category === "BLOCKING");
    const blockingPrecise = derivedBlocking.filter((x) => blockingConcerns.some((c) => { const j = by.get(c.id); return j && j.grade === "MATCH" && j.derived === x.i; }));
    const arch = b.concerns.filter((c) => c.kind === "architecture");
    const steps: Record<string, number> = {};
    for (const j of js) if ((j.grade === "MISS" || j.grade === "PARTIAL") && j.diverged_step) steps[j.diverged_step] = (steps[j.diverged_step] ?? 0) + 1;
    const partial = js.filter((j) => j.grade === "PARTIAL").length;
    return {
        comments: n, derived_findings: run.derived.length, match: m.length, partial, miss: js.filter((j) => j.grade === "MISS").length,
        dimension_agreement: ((): Metrics["dimension_agreement"] => { const d = (k: "root_cause" | "severity" | "remediation") => { const j = m.filter((x) => x.criteria[k] !== undefined); return j.length ? pct(j.filter((x) => x.criteria[k]).length, j.length) : null; }; return { root_cause: d("root_cause"), severity: d("severity"), remediation: d("remediation") }; })(),
        recall: pct(m.length, n), lenient_recall: pct(m.length + partial * 0.5, n), precision: pct(used.size, run.derived.length),
        blocking_recall: blockingConcerns.length ? pct(blockingHit.length, blockingConcerns.length) : null,
        blocking_precision: derivedBlocking.length ? pct(blockingPrecise.length, derivedBlocking.length) : null,
        consequence_recall: pct(js.filter((j) => j.criteria.consequence).length, n),
        architecture_recall: arch.length ? pct(arch.filter((c) => by.get(c.id)?.grade === "MATCH").length, arch.length) : null, steps,
    };
}

export const TARGETS = { recall: 90, blocking_recall: 95, consequence_recall: 90, max_missed: 1 };
export function verdict(b: Benchmark, run: Run, m: Metrics): { valid: boolean; reasons: string[]; achieved: boolean; label: string } {
    const reasons: string[] = [];
    if (b.purpose !== "parity") reasons.push(`this benchmark is a ${b.purpose} exercise: ${b.answer_key}`);
    if (!run.blind) reasons.push(`the run was not blind (${run.contamination})`);
    if (!b.pre_fix_available) reasons.push("the benchmark has no pre-review code, so concerns already fixed in the code under review cannot be derived from it");
    const valid = reasons.length === 0;
    const meets = m.recall >= TARGETS.recall && (m.blocking_recall ?? 0) >= TARGETS.blocking_recall && m.consequence_recall >= TARGETS.consequence_recall && m.miss <= TARGETS.max_missed;
    return { valid, reasons, achieved: valid && meets, label: valid ? (meets ? "PARITY ACHIEVED" : "PARITY NOT ACHIEVED") : "NO PARITY CLAIM: design-validation result (counts only)" };
}

// ── regression between runs ─────────────────────────────────────────────────

const rank = (g: Grade) => (g === "MATCH" ? 2 : g === "PARTIAL" ? 1 : 0);
export function compareRuns(b: Benchmark, prev: Run, next: Run): { regressions: string[]; improvements: string[]; ok: boolean } {
    const regressions: string[] = [], improvements: string[] = [];
    const pm = new Map(prev.judgments.map((j) => [j.concern_id, j])), nm = new Map(next.judgments.map((j) => [j.concern_id, j]));
    for (const c of b.concerns) {
        const p = pm.get(c.id), q = nm.get(c.id);
        if (!p) continue;
        if (!q) { regressions.push(`${c.id}: no judgment in the new run`); continue; }
        if (rank(q.grade) < rank(p.grade)) regressions.push(`${c.id}: ${p.grade} -> ${q.grade}  (${c.text.slice(0, 70)})`);
        else if (rank(q.grade) > rank(p.grade)) improvements.push(`${c.id}: ${p.grade} -> ${q.grade}`);
        else if (p.grade === "MATCH" && c.severity === "BLOCKING" && p.derived !== null && q.derived !== null && prev.derived[p.derived]?.category === "BLOCKING" && next.derived[q.derived]?.category !== "BLOCKING") regressions.push(`${c.id}: still matched but no longer at BLOCKING severity`);
    }
    const a = computeMetrics(b, prev), z = computeMetrics(b, next);
    if (z.recall < a.recall) regressions.push(`matched comments fell ${a.match} -> ${z.match}`);
    if ((z.blocking_recall ?? 0) < (a.blocking_recall ?? 0)) regressions.push(`blocking comments matched fell ${a.blocking_recall}% -> ${z.blocking_recall}%`);
    return { regressions, improvements, ok: regressions.length === 0 };
}

// ── deterministic evidence checks ───────────────────────────────────────────

export function runTool(tool: string, args: Record<string, any>, ws: string): string {
    switch (tool) {
        case "check_invariant_enforcement": return renderEnforcement(mapInvariantEnforcement(ws, { fields: args.fields, max_hits: args.max_hits ?? 12 }));
        case "check_entity_impact": return renderEntityImpact(inventoryEntityImpact(ws, { terms: args.entity_terms, flags: args.flags, story_text: args.story_text ?? "", max_ranked: args.max_ranked ?? 25 }));
        case "build_field_impact": return renderFieldImpact(mapFieldImpact(ws, { fields: args.fields, file_filter: args.file_filter, max_per_field: 800 }), args.per_capability ?? 10);
        case "find_endpoint_consumers": return renderEndpointConsumers(endpointConsumers(ws, { endpoints: args.endpoints }));
        case "check_service_ownership": return renderOwnership(serviceOwnership(ws, { entities: args.entities }));
        case "trace_parent_cascade": return renderCascade(parentCascade(ws, { parent: args.parent, children: args.children, guard_terms: args.guard_terms }), args.guard_terms ?? []);
        case "check_ui_gating": return renderGating(uiGating(ws, { action: args.action, server_hint: args.server_hint, ui_hint: args.ui_hint }));
        case "build_feature_model": return renderFeatureModel(buildFeatureModel(ws, { work_item_id: args.work_item_id, entities: args.entities, flags: args.flags }));
        default: throw new Error(`unknown tool in an evidence check: ${tool}`);
    }
}
export interface EvidenceResult { concern: string; tool: string; ok: boolean; missing: string[]; error?: string }
export function runEvidenceChecks(b: Benchmark, ws: string): EvidenceResult[] {
    const cache = new Map<string, string>();
    const out: EvidenceResult[] = [];
    for (const c of b.concerns) for (const e of c.evidence_checks) {
        const key = e.tool + JSON.stringify(e.args);
        try {
            if (!cache.has(key)) cache.set(key, runTool(e.tool, e.args, ws));
            const text = cache.get(key)!;
            const missing = e.must_match.filter((p) => !new RegExp(p).test(text));
            out.push({ concern: c.id, tool: e.tool, ok: missing.length === 0, missing });
        } catch (err: any) { out.push({ concern: c.id, tool: e.tool, ok: false, missing: [], error: err.message }); }
    }
    return out;
}

// ── report ──────────────────────────────────────────────────────────────────

export function renderReport(b: Benchmark, run: Run): string {
    const m = computeMetrics(b, run), v = verdict(b, run, m);
    const f = (x: number | null) => (x === null ? "n/a" : `${x}%`);
    const L = [`CLIENT REVIEW PARITY: ${b.title}  [${b.id}, run ${run.run_id}]`, `RESULT: ${v.label}`, ...v.reasons.map((r) => `  - ${r}`), "", `COUNTS: ${m.match} MATCH, ${m.partial} PARTIAL, ${m.miss} MISS of ${m.comments} comments; ${m.derived_findings} findings were derived and sealed.`];
    if (v.valid) {
        L.push("", "PARITY METRICS (valid run)",
            `  Recall (MATCH):                 ${m.recall}%   (target >= ${TARGETS.recall}%)   [partial counted as half: ${m.lenient_recall}%]`,
            `  Precision:                      ${m.precision}%`,
            `  Blocking recall (severity too): ${f(m.blocking_recall)}   (target >= ${TARGETS.blocking_recall}%)`,
            `  Blocking precision:             ${f(m.blocking_precision)}`,
            `  Business consequence recall:    ${m.consequence_recall}%   (target >= ${TARGETS.consequence_recall}%)`,
            `  Architecture concern recall:    ${f(m.architecture_recall)}`,
            `  Among matches, agreement on: root cause ${f(m.dimension_agreement.root_cause)}, severity ${f(m.dimension_agreement.severity)}, remediation intent ${f(m.dimension_agreement.remediation)}`,
            `  Missed comments:                ${m.miss}   (target <= ${TARGETS.max_missed})`);
    } else L.push("No recall, precision or parity percentages are reported for this run: it cannot support them.");
    if (Object.keys(m.steps).length) L.push("", "WHERE THE REASONING CHAIN FAILED (misses and partials)", ...Object.entries(m.steps).sort((a, c) => c[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`));
    L.push("", "PER COMMENT");
    for (const c of b.concerns) {
        const j = run.judgments.find((x) => x.concern_id === c.id);
        if (!j) { L.push(`- ${c.id} [${c.severity}] NOT JUDGED  ${c.text.slice(0, 90)}`); continue; }
        const cr = j.criteria, yn = (x: boolean) => (x ? "Y" : "N");
        L.push(`- ${c.id} [${c.severity}/${c.kind}${c.fixed_in_code ? ", fixed in code" : ""}] ${j.grade}${j.downgraded_from ? ` (downgraded from ${j.downgraded_from})` : ""}  ${c.text.slice(0, 80)}`);
        L.push(`    reached: ${j.reached}; entity ${yn(cr.entity)}, consequence ${yn(cr.consequence)}, unsupported state ${yn(cr.unsupported_state)}, comment ${yn(cr.comment)}${j.derived !== null ? `; derived #${j.derived + 1}` : ""}`);
        if (j.grade !== "MATCH") L.push(`    diverged at: ${j.diverged_step}. ${j.note}\n    smallest improvement: ${j.smallest_improvement}`);
    }
    return L.join("\n");
}

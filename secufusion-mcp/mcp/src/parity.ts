/**
 * Client Review Parity Suite.
 *
 * The question is not "did the review find a bug" but "would it have written the client's comment?" This module is the
 * measurement, not the review:
 *
 *   Benchmark   a completed review: the concerns the client raised (with severity, kind, consequence), whether pre-fix
 *               code exists, whether any run on it could have been blind, and DETERMINISTIC EVIDENCE CHECKS per concern.
 *   Run         the findings a review derived and sealed BEFORE the comments were revealed, plus a judgment per concern.
 *   Judgment    EXACT / EQUIVALENT / PARTIAL / MISS, decided by four criteria: entity, root cause, business consequence,
 *               recommended fix. A concern only counts as matched when ALL required criteria hold; otherwise it is
 *               downgraded. A MISS (and a PARTIAL) must name the step of the reasoning chain that failed and the smallest
 *               improvement, or it is refused: no capability is added to a miss nobody has root-caused.
 *   Metrics     concern recall/precision, blocking recall/precision (severity must match too), business-consequence
 *               recall, architecture-concern recall, missed count.
 *   Regression  every client concern is a permanent test: (1) the deterministic evidence checks still produce their
 *               evidence on the benchmark workspace; (2) a new run must not lose a concern an earlier run matched, nor
 *               lower concern recall or blocking recall.
 *   Validity    "parity achieved" is only claimed from a blind run, with the fix criterion required, on a benchmark that has
 *               pre-fix code. Anything else is reported as a regression baseline, with the reason.
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
export type Grade = "EXACT" | "EQUIVALENT" | "PARTIAL" | "MISS";
export type Severity = "BLOCKING" | "NON-BLOCKING" | "QUESTION" | "REQUIRES_DECISION";
export type Kind = "architecture" | "implementation" | "business";

export interface EvidenceCheck { tool: string; args: Record<string, any>; must_match: string[]; note?: string }
export interface Concern {
    id: string; text: string; severity: Severity | "UNSPECIFIED"; kind: Kind; entity: string; consequence: string; expected_fix?: string;
    /** the defect is already fixed in the code under review, so only the risk class can be derived from the code */
    fixed_in_code: boolean; evidence_checks: EvidenceCheck[]; source: string;
}
export interface Benchmark {
    id: string; title: string; story_chain: string[]; workspace_hint: string;
    pre_fix_available: boolean; limitation: string; concerns: Concern[];
}
export interface Criteria { entity: boolean; root_cause: boolean; consequence: boolean; fix: boolean | null }
export interface Judgment {
    concern_id: string; grade: Grade; derived: number | null; derived_severity?: Severity;
    criteria: Criteria; diverged_step?: MissStep; note: string; smallest_improvement?: string; downgraded_from?: Grade;
}
export interface DerivedFinding { title: string; category: Severity; entity?: string; text: string; fix?: string }
export interface Run {
    run_id: string; benchmark_id: string; at: string; blind: boolean; require_fix: boolean; contamination: string;
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

export function normalizeJudgment(j: Judgment, requireFix: boolean): Judgment {
    const out: Judgment = { ...j, criteria: { ...j.criteria } };
    const c = out.criteria;
    const core = c.entity && c.root_cause && c.consequence;
    const full = core && (!requireFix || c.fix === true);
    const any = c.entity || c.root_cause || c.consequence || c.fix === true;
    if ((out.grade === "EXACT" || out.grade === "EQUIVALENT") && !full) {
        out.downgraded_from = out.grade;
        out.grade = any ? "PARTIAL" : "MISS";
    } else if (out.grade === "PARTIAL" && !any) { out.downgraded_from = "PARTIAL"; out.grade = "MISS"; }
    if (out.grade === "MISS" || out.grade === "PARTIAL") {
        if (!out.diverged_step || !(MISS_STEPS as readonly string[]).includes(out.diverged_step)) throw new Error(`${out.concern_id}: a ${out.grade} must name the step of the reasoning chain where the review diverged (${MISS_STEPS.join(", ")}). Root-cause it before anything is built.`);
        if (!out.note?.trim()) throw new Error(`${out.concern_id}: a ${out.grade} needs a note: what the review did instead, in one sentence.`);
        if (!out.smallest_improvement?.trim()) throw new Error(`${out.concern_id}: a ${out.grade} needs the smallest improvement that would continue the chain (or "none: <why>" if the code under review cannot show it).`);
    }
    if (out.grade === "MISS") out.derived = null;
    return out;
}

const matched = (g: Grade) => g === "EXACT" || g === "EQUIVALENT";
export interface Metrics {
    concerns: number; derived_findings: number; exact: number; equivalent: number; partial: number; miss: number;
    concern_recall: number; lenient_recall: number; concern_precision: number;
    blocking_recall: number | null; blocking_precision: number | null; consequence_recall: number; architecture_recall: number | null;
    missed: number; steps: Record<string, number>;
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function computeMetrics(b: Benchmark, run: Run): Metrics {
    const js = run.judgments;
    const by = new Map(js.map((j) => [j.concern_id, j]));
    const n = b.concerns.length;
    const m = js.filter((j) => matched(j.grade));
    const usedDerived = new Set(m.map((j) => j.derived).filter((x): x is number => x !== null));
    const blockingConcerns = b.concerns.filter((c) => c.severity === "BLOCKING");
    const blockingHit = blockingConcerns.filter((c) => { const j = by.get(c.id); return j && matched(j.grade) && j.derived !== null && run.derived[j.derived]?.category === "BLOCKING"; });
    const derivedBlocking = run.derived.map((d, i) => ({ d, i })).filter((x) => x.d.category === "BLOCKING");
    const blockingPrecise = derivedBlocking.filter((x) => b.concerns.some((c) => c.severity === "BLOCKING" && by.get(c.id)?.derived === x.i && matched(by.get(c.id)!.grade)));
    const arch = b.concerns.filter((c) => c.kind === "architecture");
    const steps: Record<string, number> = {};
    for (const j of js) if ((j.grade === "MISS" || j.grade === "PARTIAL") && j.diverged_step) steps[j.diverged_step] = (steps[j.diverged_step] ?? 0) + 1;
    return {
        concerns: n, derived_findings: run.derived.length,
        exact: js.filter((j) => j.grade === "EXACT").length, equivalent: js.filter((j) => j.grade === "EQUIVALENT").length,
        partial: js.filter((j) => j.grade === "PARTIAL").length, miss: js.filter((j) => j.grade === "MISS").length,
        concern_recall: pct(m.length, n), lenient_recall: pct(m.length + js.filter((j) => j.grade === "PARTIAL").length * 0.5, n),
        concern_precision: pct(usedDerived.size, run.derived.length),
        blocking_recall: blockingConcerns.length ? pct(blockingHit.length, blockingConcerns.length) : null,
        blocking_precision: derivedBlocking.length ? pct(blockingPrecise.length, derivedBlocking.length) : null,
        consequence_recall: pct(js.filter((j) => j.criteria.consequence).length, n),
        architecture_recall: arch.length ? pct(arch.filter((c) => { const j = by.get(c.id); return j && matched(j.grade); }).length, arch.length) : null,
        missed: js.filter((j) => j.grade === "MISS").length, steps,
    };
}

export const TARGETS = { concern_recall: 90, blocking_recall: 95, consequence_recall: 90, max_missed: 1 };
export function verdict(b: Benchmark, run: Run, m: Metrics): { valid: boolean; reasons: string[]; achieved: boolean; label: string } {
    const reasons: string[] = [];
    if (!run.blind) reasons.push(`the run was not blind (${run.contamination})`);
    if (!run.require_fix) reasons.push("the recommended-fix criterion was not required (the run did not record fixes)");
    if (!b.pre_fix_available) reasons.push("the benchmark has no pre-fix code, so concerns already fixed in the code cannot be derived from it");
    const valid = reasons.length === 0;
    const meets = m.concern_recall >= TARGETS.concern_recall && (m.blocking_recall ?? 0) >= TARGETS.blocking_recall && m.consequence_recall >= TARGETS.consequence_recall && m.missed <= TARGETS.max_missed;
    return { valid, reasons, achieved: valid && meets, label: valid ? (meets ? "PARITY ACHIEVED" : "PARITY NOT ACHIEVED") : "NOT VALID FOR A PARITY CLAIM: regression baseline only" };
}

// ── regression between runs ─────────────────────────────────────────────────

const rank = (g: Grade) => (g === "EXACT" || g === "EQUIVALENT" ? 2 : g === "PARTIAL" ? 1 : 0);
export function compareRuns(b: Benchmark, prev: Run, next: Run): { regressions: string[]; improvements: string[]; ok: boolean } {
    const regressions: string[] = [], improvements: string[] = [];
    const pm = new Map(prev.judgments.map((j) => [j.concern_id, j])), nm = new Map(next.judgments.map((j) => [j.concern_id, j]));
    for (const c of b.concerns) {
        const p = pm.get(c.id), q = nm.get(c.id);
        if (!p) continue;
        if (!q) { regressions.push(`${c.id}: no judgment in the new run`); continue; }
        if (rank(q.grade) < rank(p.grade)) regressions.push(`${c.id}: ${p.grade} -> ${q.grade}  (${c.text.slice(0, 70)})`);
        else if (rank(q.grade) > rank(p.grade)) improvements.push(`${c.id}: ${p.grade} -> ${q.grade}`);
        else if (matched(p.grade) && c.severity === "BLOCKING" && p.derived_severity === "BLOCKING" && q.derived_severity !== "BLOCKING") regressions.push(`${c.id}: still matched but no longer at BLOCKING severity`);
    }
    const a = computeMetrics(b, prev), z = computeMetrics(b, next);
    if (z.concern_recall < a.concern_recall) regressions.push(`concern recall fell ${a.concern_recall}% -> ${z.concern_recall}%`);
    if ((z.blocking_recall ?? 0) < (a.blocking_recall ?? 0)) regressions.push(`blocking recall fell ${a.blocking_recall}% -> ${z.blocking_recall}%`);
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
    const L = [
        `CLIENT REVIEW PARITY: ${b.title}  [${b.id}, run ${run.run_id}]`,
        `VERDICT: ${v.label}`, ...v.reasons.map((r) => `  - ${r}`),
        "", "METRICS",
        `  Concern recall (exact + equivalent):  ${m.concern_recall}%   (target >= ${TARGETS.concern_recall}%)   [lenient, partial = half: ${m.lenient_recall}%]`,
        `  Concern precision:                    ${m.concern_precision}%   (${m.derived_findings} derived findings)`,
        `  Blocking recall (severity must match):${f(m.blocking_recall)}   (target >= ${TARGETS.blocking_recall}%)`,
        `  Blocking precision:                   ${f(m.blocking_precision)}`,
        `  Business consequence recall:          ${m.consequence_recall}%   (target >= ${TARGETS.consequence_recall}%)`,
        `  Architecture concern recall:          ${f(m.architecture_recall)}`,
        `  Missed concerns:                      ${m.missed}   (target <= ${TARGETS.max_missed})`,
        `  Grades: ${m.exact} exact, ${m.equivalent} equivalent, ${m.partial} partial, ${m.miss} miss of ${m.concerns}`,
    ];
    if (Object.keys(m.steps).length) L.push("", "WHERE THE REASONING CHAIN FAILED (misses and partials)", ...Object.entries(m.steps).sort((a, c) => c[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`));
    L.push("", "PER CONCERN");
    for (const c of b.concerns) {
        const j = run.judgments.find((x) => x.concern_id === c.id);
        if (!j) { L.push(`- ${c.id} [${c.severity}] NOT JUDGED  ${c.text.slice(0, 90)}`); continue; }
        const cr = j.criteria;
        L.push(`- ${c.id} [${c.severity}/${c.kind}${c.fixed_in_code ? ", fixed in code" : ""}] ${j.grade}${j.downgraded_from ? ` (downgraded from ${j.downgraded_from})` : ""}  ${c.text.slice(0, 80)}`);
        L.push(`    criteria: entity ${cr.entity ? "Y" : "N"}, root cause ${cr.root_cause ? "Y" : "N"}, consequence ${cr.consequence ? "Y" : "N"}, fix ${cr.fix === null ? "not recorded" : cr.fix ? "Y" : "N"}${j.derived !== null ? `; derived #${j.derived + 1} at ${j.derived_severity ?? "?"}` : ""}`);
        if (j.grade === "MISS" || j.grade === "PARTIAL") L.push(`    diverged at: ${j.diverged_step}. ${j.note}\n    smallest improvement: ${j.smallest_improvement}`);
    }
    return L.join("\n");
}

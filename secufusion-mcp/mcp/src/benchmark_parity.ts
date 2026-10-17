import fs from "fs";
import { fileURLToPath } from "url";
import { normalizeJudgment, computeMetrics, verdict, compareRuns, runEvidenceChecks, loadBenchmark, loadRuns, datasetDir, hashDerived, renderReport, Benchmark, Run, Judgment, MISS_STEPS } from "./parity.js";

/** The parity suite's own rules, and the permanent regression for Benchmark #1. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const C = (id: string, severity: any, kind: any = "architecture") => ({ id, text: id, severity, kind, entity: "e", consequence: "c", fixed_in_code: false, evidence_checks: [], source: "t" });
const b: Benchmark = { id: "t", title: "t", story_chain: [], workspace_hint: "", pre_fix_available: true, limitation: "", concerns: [C("A", "BLOCKING"), C("B", "BLOCKING"), C("D", "UNSPECIFIED"), C("E", "NON-BLOCKING", "implementation")] };
const T = (entity: boolean, root_cause: boolean, consequence: boolean, fix: boolean | null = true) => ({ entity, root_cause, consequence, fix });
const J = (concern_id: string, grade: any, derived: number | null, sev: any, criteria: any, extra: Partial<Judgment> = {}): Judgment => ({ concern_id, grade, derived, derived_severity: sev, criteria, note: "n", ...extra });
const derived = [{ title: "x", category: "BLOCKING" as const, text: "" }, { title: "y", category: "BLOCKING" as const, text: "" }, { title: "z", category: "NON-BLOCKING" as const, text: "" }];
const mkRun = (js: Judgment[], over: Partial<Run> = {}): Run => ({ run_id: "1", benchmark_id: "t", at: "", blind: true, require_fix: true, contamination: "", derived, derived_sha256: hashDerived(derived), judgments: js.map((j) => normalizeJudgment(j, over.require_fix ?? true)), ...over });

// ── a match needs all four criteria ──────────────────────────────────────────
{
    const ok = normalizeJudgment(J("A", "EXACT", 0, "BLOCKING", T(true, true, true, true)), true);
    check("entity, root cause, consequence and fix all true: stays EXACT", ok.grade === "EXACT");
    const noFix = normalizeJudgment(J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true, false), { diverged_step: "Review formulation", smallest_improvement: "state the fix" }), true);
    check("a wrong fix downgrades an equivalent match to PARTIAL when the fix is required", noFix.grade === "PARTIAL" && noFix.downgraded_from === "EQUIVALENT");
    const unrec = normalizeJudgment(J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true, null), { diverged_step: "Review formulation", smallest_improvement: "record the fix" }), true);
    check("a fix that was not recorded cannot be matched when the fix is required", unrec.grade === "PARTIAL");
    check("the same judgment stands when the run declared the fix not required (and says so)", normalizeJudgment(J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true, null)), false).grade === "EQUIVALENT");
    const wrongCause = normalizeJudgment(J("A", "EQUIVALENT", 0, "BLOCKING", T(true, false, true), { diverged_step: "Consequence derivation", smallest_improvement: "x" }), false);
    check("a wrong root cause downgrades to PARTIAL", wrongCause.grade === "PARTIAL");
    const none = normalizeJudgment(J("A", "EQUIVALENT", 0, "BLOCKING", T(false, false, false, false), { diverged_step: "Entity discovery", smallest_improvement: "x" }), true);
    check("no criterion true is a MISS, not a partial match", none.grade === "MISS" && none.derived === null);
}

// ── a miss must be root-caused before anything is built ──────────────────────
{
    const thrown = (j: Judgment) => { try { normalizeJudgment(j, true); return ""; } catch (e: any) { return e.message; } };
    check("a MISS without the failing step of the reasoning chain is refused", /must name the step of the reasoning chain/.test(thrown(J("A", "MISS", null, undefined, T(false, false, false)))));
    check("a MISS without the smallest improvement is refused", /smallest improvement/.test(thrown(J("A", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery" }))));
    check("a MISS without a note is refused", /needs a note/.test(thrown(J("A", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery", note: " ", smallest_improvement: "x" }))));
    check("the eight reasoning steps are the ones the suite names", MISS_STEPS.length === 8 && MISS_STEPS.includes("Consequence derivation") && MISS_STEPS.includes("Review formulation"));
}

// ── metrics: severity must match, precision counts only matched findings ─────
{
    const run = mkRun([
        J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true)),
        J("B", "EQUIVALENT", 2, "NON-BLOCKING", T(true, true, true)),
        J("D", "PARTIAL", 1, "BLOCKING", T(true, false, true), { diverged_step: "Consumer discovery", smallest_improvement: "x" }),
        J("E", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery", smallest_improvement: "x" }),
    ]);
    const m = computeMetrics(b, run);
    check("concern recall counts exact and equivalent only", m.concern_recall === 50 && m.lenient_recall === 62.5, JSON.stringify(m));
    check("blocking recall requires the severity to match: matched at the wrong severity does not count", m.blocking_recall === 50, `${m.blocking_recall}`);
    check("blocking precision: derived BLOCKING findings that matched a client BLOCKING concern", m.blocking_precision === 50, `${m.blocking_precision}`);
    check("concern precision: matched derived findings over all derived findings", m.concern_precision === 66.7, `${m.concern_precision}`);
    check("business consequence recall comes from the consequence criterion", m.consequence_recall === 75, `${m.consequence_recall}`);
    check("architecture recall is over the architecture concerns only", m.architecture_recall === 66.7, `${m.architecture_recall}`);
    check("missed count and the failing steps are reported", m.missed === 1 && m.steps["Consumer discovery"] === 1 && m.steps["Entity discovery"] === 1);
    const v = verdict(b, run, m);
    check("below target: not achieved", !v.achieved && v.valid && v.label === "PARITY NOT ACHIEVED");
    const perfect = mkRun([J("A", "EXACT", 0, "BLOCKING", T(true, true, true)), J("B", "EXACT", 1, "BLOCKING", T(true, true, true)), J("D", "EXACT", 2, "BLOCKING", T(true, true, true)), J("E", "EXACT", 2, "NON-BLOCKING", T(true, true, true))]);
    check("all targets met on a blind, fix-required run with pre-fix code: parity achieved", verdict(b, perfect, computeMetrics(b, perfect)).achieved);
    for (const [name, over, bb] of [["a non-blind run", { blind: false }, b], ["a run that did not require the fix", { require_fix: false }, b], ["a benchmark without pre-fix code", {}, { ...b, pre_fix_available: false }]] as const) {
        const r = mkRun(perfect.judgments, over as any);
        check(`${name} can never claim parity, even with perfect scores`, !verdict(bb as Benchmark, r, computeMetrics(bb as Benchmark, r)).achieved && /NOT VALID/.test(verdict(bb as Benchmark, r, computeMetrics(bb as Benchmark, r)).label));
    }
}

// ── the reviewer regression suite ────────────────────────────────────────────
{
    const prev = mkRun([J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true)), J("B", "EQUIVALENT", 1, "BLOCKING", T(true, true, true)), J("D", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery", smallest_improvement: "x" })]);
    const better = mkRun([J("A", "EXACT", 0, "BLOCKING", T(true, true, true)), J("B", "EQUIVALENT", 1, "BLOCKING", T(true, true, true)), J("D", "EQUIVALENT", 2, "NON-BLOCKING", T(true, true, true))]);
    check("a new run that keeps everything and fixes a miss is not a regression", compareRuns(b, prev, better).ok && compareRuns(b, prev, better).improvements.length === 1);
    const worse = mkRun([J("A", "EQUIVALENT", 0, "BLOCKING", T(true, true, true)), J("B", "PARTIAL", 1, "BLOCKING", T(true, false, true), { diverged_step: "Consequence derivation", smallest_improvement: "x" }), J("D", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery", smallest_improvement: "x" })]);
    const r = compareRuns(b, prev, worse);
    check("losing a previously matched concern is a regression, and recall falling is reported", !r.ok && r.regressions.some((x) => /^B: EQUIVALENT -> PARTIAL/.test(x)) && r.regressions.some((x) => /concern recall fell/.test(x)) && r.regressions.some((x) => /blocking recall fell/.test(x)), JSON.stringify(r));
    const sev = mkRun([J("A", "EQUIVALENT", 0, "NON-BLOCKING", T(true, true, true)), J("B", "EQUIVALENT", 1, "BLOCKING", T(true, true, true)), J("D", "MISS", null, undefined, T(false, false, false), { diverged_step: "Entity discovery", smallest_improvement: "x" })]);
    check("a matched blocking concern that drops to a lower severity is a regression", compareRuns(b, prev, sev).regressions.some((x) => /no longer at BLOCKING/.test(x)));
}

// ── Benchmark #1: STORY-1656 ─────────────────────────────────────────────────
{
    const dir = datasetDir();
    check("the dataset ships in the repository (not in the npm package)", !!dir);
    if (dir) {
        const bm = loadBenchmark(dir, "story-1656");
        const runs = loadRuns(dir, "story-1656");
        check("Benchmark #1 holds the 17 recorded concerns, each with an entity, a consequence and a source", bm.concerns.length === 17 && bm.concerns.every((c) => c.entity && c.consequence && c.source), `${bm.concerns.length}`);
        check("it states honestly that no pre-fix code exists and what that limits", bm.pre_fix_available === false && /already contains the fixes/.test(bm.limitation));
        const run1 = runs[0];
        check("Run 001 is stored with its sealed findings, intact", !!run1 && run1.derived.length === 15 && hashDerived(run1.derived) === run1.derived_sha256);
        check("Run 001 is not blind and is therefore a regression baseline only", !run1.blind && /NOT VALID/.test(verdict(bm, run1, computeMetrics(bm, run1)).label));
        check("every miss and partial in Run 001 names the failing step and the smallest improvement", run1.judgments.filter((j) => j.grade === "MISS" || j.grade === "PARTIAL").every((j) => j.diverged_step && j.smallest_improvement));
        check("the report prints the metrics and where the chain failed", /Concern recall/.test(renderReport(bm, run1)) && /WHERE THE REASONING CHAIN FAILED/.test(renderReport(bm, run1)));
        // every client concern is a permanent regression test: the deterministic evidence must still be produced
        const ws = process.env.SECUFI_WORKSPACE ?? "C:/Users/Yash/Desktop/secufi_full";
        if (fs.existsSync(ws) && !process.env.SKIP_PARITY_EVIDENCE) {
            const results = runEvidenceChecks(bm, ws);
            for (const r of results) check(`regression ${r.concern}: ${r.tool} still produces the evidence for this client concern`, r.ok, r.error ?? `missing ${r.missing.join(" | ")}`);
        } else console.log(`SKIP  evidence regression: workspace ${ws} not available (set SECUFI_WORKSPACE)`);
    }
}

process.exit(failures ? 1 : 0);
void fileURLToPath;

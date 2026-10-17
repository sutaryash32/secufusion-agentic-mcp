import fs from "fs";
import { normalizeJudgment, computeMetrics, verdict, compareRuns, runEvidenceChecks, loadBenchmark, loadRuns, datasetDir, hashDerived, renderReport, Benchmark, Run, Judgment, MISS_STEPS, REACH } from "./parity.js";

/** The parity suite's own rules, and the permanent regression for Benchmark #1 (a design-validation exercise). */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const C = (id: string, severity: any, kind: any = "architecture") => ({ id, text: id, severity, kind, entity: "e", consequence: "c", fixed_in_code: false, evidence_checks: [], source: "t" });
const b: Benchmark = { id: "t", title: "t", purpose: "parity", story_chain: [], workspace_hint: "", pre_fix_available: true, answer_key: "the client's review thread", limitation: "", concerns: [C("A", "BLOCKING"), C("B", "BLOCKING"), C("D", "UNSPECIFIED"), C("E", "NON-BLOCKING", "implementation")] };
const ALL = { entity: true, consequence: true, unsupported_state: true, comment: true };
const J = (concern_id: string, grade: any, derived: number | null, reached: any, criteria: any, extra: Partial<Judgment> = {}): Judgment => ({ concern_id, grade, derived, reached, criteria, note: "n", ...extra });
const derived = [{ title: "x", category: "BLOCKING" as const, text: "" }, { title: "y", category: "BLOCKING" as const, text: "" }, { title: "z", category: "NON-BLOCKING" as const, text: "" }];
const mkRun = (js: Judgment[], over: Partial<Run> = {}): Run => ({ run_id: "1", benchmark_id: "t", at: "", blind: true, contamination: "", derived, derived_sha256: hashDerived(derived), judgments: js.map((j) => normalizeJudgment(j)), ...over });
const fix = { diverged_step: "Review formulation", smallest_improvement: "x" } as const;

// ── a MATCH needs the same entity, consequence, unsupported state and a materially equivalent comment ──────────────
{
    check("all four criteria and a chain that reached the comment: MATCH", normalizeJudgment(J("A", "MATCH", 0, "comment", ALL)).grade === "MATCH");
    for (const k of ["entity", "consequence", "unsupported_state", "comment"] as const) {
        const j = normalizeJudgment(J("A", "MATCH", 0, "comment", { ...ALL, [k]: false }, fix));
        check(`a MATCH without '${k}' is downgraded to PARTIAL`, j.grade === "PARTIAL" && j.downgraded_from === "MATCH");
    }
    check("the dependency alone is never a match, even if every criterion is claimed", normalizeJudgment(J("A", "MATCH", 0, "dependency", ALL, fix)).grade === "PARTIAL");
    check("the invariant alone is never a match", normalizeJudgment(J("A", "MATCH", 0, "invariant", ALL, fix)).grade === "PARTIAL");
    check("a chain that stopped short of the comment is never a match", normalizeJudgment(J("A", "MATCH", 0, "unsupported_state", ALL, fix)).grade === "PARTIAL");
    check("nothing true and nothing reached is a MISS, not a partial", normalizeJudgment(J("A", "PARTIAL", 0, "nothing", { entity: false, consequence: false, unsupported_state: false, comment: false }, { diverged_step: "Entity discovery", smallest_improvement: "x" })).grade === "MISS");
    check("the reasoning chain has five reach levels in order", REACH.join() === "dependency,invariant,consequence,unsupported_state,comment");
}

// ── a miss must be root-caused before anything is built ──────────────────────
{
    const thrown = (j: Judgment) => { try { normalizeJudgment(j); return ""; } catch (e: any) { return e.message; } };
    const none = { entity: false, consequence: false, unsupported_state: false, comment: false };
    check("a MISS without the failing step of the reasoning chain is refused", /must name the step of the reasoning chain/.test(thrown(J("A", "MISS", null, "nothing", none))));
    check("a MISS without the smallest improvement is refused", /smallest improvement/.test(thrown(J("A", "MISS", null, "nothing", none, { diverged_step: "Entity discovery" }))));
    check("a MISS without a note is refused", /needs a note/.test(thrown(J("A", "MISS", null, "nothing", none, { diverged_step: "Entity discovery", note: " ", smallest_improvement: "x" }))));
    check("a PARTIAL is root-caused the same way", /must name the step/.test(thrown(J("A", "PARTIAL", 0, "consequence", { ...none, entity: true }))));
    check("the eight reasoning steps are the ones the suite names", MISS_STEPS.length === 8 && MISS_STEPS.includes("Consequence derivation") && MISS_STEPS.includes("Review formulation"));
}

// ── metrics, and who may see percentages ─────────────────────────────────────
{
    const run = mkRun([
        J("A", "MATCH", 0, "comment", ALL),
        J("B", "MATCH", 2, "comment", ALL),
        J("D", "PARTIAL", 1, "consequence", { entity: true, consequence: true, unsupported_state: false, comment: false }, { diverged_step: "Consumer discovery", smallest_improvement: "x" }),
        J("E", "MISS", null, "nothing", { entity: false, consequence: false, unsupported_state: false, comment: false }, { diverged_step: "Entity discovery", smallest_improvement: "x" }),
    ]);
    const m = computeMetrics(b, run);
    check("counts: matches, partials and misses of the comments", m.match === 2 && m.partial === 1 && m.miss === 1 && m.comments === 4);
    check("recall counts MATCH only; partial is half in the lenient figure", m.recall === 50 && m.lenient_recall === 62.5, JSON.stringify(m));
    check("blocking recall requires the matched finding to be BLOCKING too: matched at the wrong severity does not count", m.blocking_recall === 50, `${m.blocking_recall}`);
    check("blocking precision: derived BLOCKING findings that matched a client BLOCKING comment", m.blocking_precision === 50, `${m.blocking_precision}`);
    check("precision: matched findings over derived findings", m.precision === 66.7, `${m.precision}`);
    check("business consequence recall comes from the consequence criterion", m.consequence_recall === 75, `${m.consequence_recall}`);
    check("architecture recall is over the architecture comments only", m.architecture_recall === 66.7, `${m.architecture_recall}`);
    const v = verdict(b, run, m);
    check("a valid run below target: not achieved, percentages shown", v.valid && !v.achieved && v.label === "PARITY NOT ACHIEVED" && /Recall \(MATCH\)/.test(renderReport(b, run)));
    const perfect = mkRun([J("A", "MATCH", 0, "comment", ALL), J("B", "MATCH", 1, "comment", ALL), J("D", "MATCH", 2, "comment", ALL), J("E", "MATCH", 2, "comment", ALL)]);
    check("all targets met on a valid run: parity achieved", verdict(b, perfect, computeMetrics(b, perfect)).achieved);
    const cases: Array<[string, Run, Benchmark]> = [
        ["a run that was not blind", mkRun(perfect.judgments, { blind: false, contamination: "saw the comments" }), b],
        ["a design-validation benchmark", perfect, { ...b, purpose: "design-validation" }],
        ["a benchmark without pre-review code", perfect, { ...b, pre_fix_available: false }],
    ];
    for (const [name, r, bb] of cases) {
        const vv = verdict(bb, r, computeMetrics(bb, r));
        check(`${name} can never claim parity, even with perfect scores`, !vv.achieved && !vv.valid && /NO PARITY CLAIM/.test(vv.label));
        check(`${name}: no percentages are printed, only counts`, !/Recall \(MATCH\)|Precision:|%/.test(renderReport(bb, r).split("PER COMMENT")[0].replace(/target/g, "")) && /No recall, precision or parity percentages/.test(renderReport(bb, r)));
    }
}

// ── the reviewer regression suite ────────────────────────────────────────────
{
    const miss = J("D", "MISS", null, "nothing", { entity: false, consequence: false, unsupported_state: false, comment: false }, { diverged_step: "Entity discovery", smallest_improvement: "x" });
    const prev = mkRun([J("A", "MATCH", 0, "comment", ALL), J("B", "MATCH", 1, "comment", ALL), miss]);
    const better = mkRun([J("A", "MATCH", 0, "comment", ALL), J("B", "MATCH", 1, "comment", ALL), J("D", "MATCH", 2, "comment", ALL)]);
    check("a new run that keeps everything and fixes a miss is not a regression", compareRuns(b, prev, better).ok && compareRuns(b, prev, better).improvements.length === 1);
    const worse = mkRun([J("A", "MATCH", 0, "comment", ALL), J("B", "PARTIAL", 1, "consequence", { entity: true, consequence: true, unsupported_state: false, comment: false }, { diverged_step: "Consequence derivation", smallest_improvement: "x" }), miss]);
    const r = compareRuns(b, prev, worse);
    check("losing a previously matched comment is a regression, and the fall is reported", !r.ok && r.regressions.some((x) => /^B: MATCH -> PARTIAL/.test(x)) && r.regressions.some((x) => /matched comments fell/.test(x)) && r.regressions.some((x) => /blocking comments matched fell/.test(x)), JSON.stringify(r));
    const sev = mkRun([J("A", "MATCH", 2, "comment", ALL), J("B", "MATCH", 1, "comment", ALL), miss]);
    check("a matched blocking comment that is now raised at a lower severity is a regression", compareRuns(b, prev, sev).regressions.some((x) => /no longer at BLOCKING/.test(x)));
}

// ── Benchmark #1: STORY-1656, a design-validation exercise ───────────────────
{
    const dir = datasetDir();
    check("the dataset ships in the repository (not in the npm package)", !!dir);
    if (dir) {
        const bm = loadBenchmark(dir, "story-1656");
        const runs = loadRuns(dir, "story-1656");
        check("STORY-1656 is a design-validation exercise, never a parity benchmark", bm.purpose === "design-validation" && /NOT the client's review thread/.test(bm.answer_key));
        check("it holds the recorded concerns and the three comments the user named, each with an entity, a consequence and a source", bm.concerns.length === 20 && bm.concerns.every((c) => c.entity && c.consequence && c.source) && ["C18", "C19", "C20"].every((id) => bm.concerns.find((c) => c.id === id)?.severity === "BLOCKING"), `${bm.concerns.length}`);
        check("it states that no pre-review code exists and what that limits", bm.pre_fix_available === false && /already contains the fixes/.test(bm.limitation));
        const run1 = runs[0];
        check("Run 001 is stored with its sealed findings, intact", !!run1 && run1.derived.length === 15 && hashDerived(run1.derived) === run1.derived_sha256);
        const v = verdict(bm, run1, computeMetrics(bm, run1));
        check("Run 001 supports no parity claim and prints counts only", !run1.blind && !v.valid && /NO PARITY CLAIM/.test(v.label) && !/Recall \(MATCH\)/.test(renderReport(bm, run1)) && /No recall, precision or parity percentages/.test(renderReport(bm, run1)));
        check("every miss and partial in Run 001 names the failing step and the smallest improvement", run1.judgments.filter((j) => j.grade !== "MATCH").every((j) => j.diverged_step && j.smallest_improvement));
        const byId = (id: string) => run1.judgments.find((j) => j.concern_id === id)!;
        check("the three named comments: deactivation and admin-group removal MATCH; the promotion comment is PARTIAL (framed as escalation, not drift)", byId("C18").grade === "MATCH" && byId("C19").grade === "MATCH" && byId("C20").grade === "PARTIAL" && byId("C20").diverged_step === "Review formulation");
        // every client comment is a permanent regression test: the deterministic evidence must still be produced
        const ws = process.env.SECUFI_WORKSPACE ?? "C:/Users/Yash/Desktop/secufi_full";
        if (fs.existsSync(ws) && !process.env.SKIP_PARITY_EVIDENCE) {
            for (const r of runEvidenceChecks(bm, ws)) check(`regression ${r.concern}: ${r.tool} still produces the evidence for this comment`, r.ok, r.error ?? `missing ${r.missing.join(" | ")}`);
        } else console.log(`SKIP  evidence regression: workspace ${ws} not available (set SECUFI_WORKSPACE)`);
    }
}

process.exit(failures ? 1 : 0);

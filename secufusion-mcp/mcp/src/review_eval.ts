/**
 * Review evals: measure the reviewer, per pass, so it can be sharpened with data instead of opinion.
 *
 * An eval case lists the findings a correct review MUST produce (expected) and findings that would be wrong (must_not).
 * A run is the findings a real review produced for that case, each optionally tagged with the pass that produced it.
 * Scoring is language-neutral and offline: it needs no model and no repository.
 *   recall      expected findings that were found
 *   precision   reported findings that were expected (an unlisted finding is "unlisted", not automatically wrong)
 *   per pass    how many findings each pass reported, how many hit an expectation, how many hit a must_not
 * Aggregating many runs shows which passes earn their cost and which only make noise.
 */
export type Sev = "blocker" | "major" | "minor" | "nit";
export interface Expected { id?: string; file?: string; line?: number; near?: number; category?: string; rule?: string; min_severity?: string }
export interface CaseSpec { name: string; expected: Expected[]; must_not?: Expected[]; verdict_in?: string[] }
export interface ActualFinding { severity: string; file?: string; line?: number; category?: string; rule?: string; pass?: string | number; title?: string }
export interface RunIn { case: string; findings: ActualFinding[]; verdict?: string }

const SEV: Record<string, number> = { blocker: 3, critical: 3, major: 2, warning: 2, high: 2, minor: 1, medium: 1, suggestion: 0, nit: 0, low: 0, info: 0 };
const rank = (s: string | undefined) => SEV[(s ?? "").toLowerCase()] ?? 0;
const sameFile = (a: string | undefined, b: string | undefined) => {
    if (!a || !b) return false;
    const x = a.replace(/\\/g, "/"), y = b.replace(/\\/g, "/");
    return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
};

export function matches(f: ActualFinding, e: Expected): boolean {
    if (e.file && !sameFile(f.file, e.file)) return false;
    if (e.line !== undefined && (f.line === undefined || Math.abs(f.line - e.line) > (e.near ?? 15))) return false;
    if (e.category && (f.category ?? "").toLowerCase() !== e.category.toLowerCase()) return false;
    if (e.rule && (f.rule ?? "").toLowerCase() !== e.rule.toLowerCase()) return false;
    if (e.min_severity && rank(f.severity) < rank(e.min_severity)) return false;
    return true;
}

export interface CaseScore {
    case: string;
    found: string[];
    missed: string[];
    false_positives: string[];
    unlisted: number;
    recall: number | null;
    precision: number | null;
    verdict_ok: boolean | null;
    pass: boolean;
}
export interface PassStat { pass: string; reported: number; hit_expected: number; hit_must_not: number; unlisted: number; precision: number | null; advice: "KEEP" | "REVIEW_COST" | "DEMOTE" | "NO_DATA" }
export interface EvalReport { cases: CaseScore[]; passes: PassStat[]; overall: { recall: number | null; precision: number | null; cases_passed: number; cases: number }; notes: string[] }

const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
const label = (e: Expected, i: number) => e.id ?? `${e.rule ?? e.category ?? "expect"}@${e.file ?? "*"}${e.line !== undefined ? ":" + e.line : ""}#${i + 1}`;

export function scoreRuns(cases: CaseSpec[], runs: RunIn[]): EvalReport {
    const byCase = new Map(cases.map((c) => [c.name, c]));
    const scores: CaseScore[] = [];
    const passAgg = new Map<string, { reported: number; hit: number; fp: number; unlisted: number }>();
    const notes: string[] = [];
    let totExp = 0, totFound = 0, totReported = 0, totMatched = 0;

    for (const run of runs) {
        const c = byCase.get(run.case);
        if (!c) { notes.push(`run for unknown case "${run.case}" ignored`); continue; }
        const found: string[] = [], missed: string[] = [], fps: string[] = [];
        const matchedActual = new Set<number>();
        c.expected.forEach((e, i) => {
            const idx = run.findings.findIndex((f) => matches(f, e));
            if (idx >= 0) { found.push(label(e, i)); run.findings.forEach((f, k) => { if (matches(f, e)) matchedActual.add(k); }); } else missed.push(label(e, i));
        });
        const bad = new Set<number>();
        (c.must_not ?? []).forEach((e, i) => run.findings.forEach((f, k) => { if (matches(f, e)) { bad.add(k); fps.push(`${label(e, i)} <- ${f.title ?? f.rule ?? f.category ?? "finding"}`); } }));
        run.findings.forEach((f, k) => {
            const key = f.pass === undefined ? "(untagged)" : String(f.pass);
            const a = passAgg.get(key) ?? { reported: 0, hit: 0, fp: 0, unlisted: 0 };
            a.reported++;
            if (bad.has(k)) a.fp++; else if (matchedActual.has(k)) a.hit++; else a.unlisted++;
            passAgg.set(key, a);
        });
        const unlisted = run.findings.filter((_, k) => !matchedActual.has(k) && !bad.has(k)).length;
        const verdict_ok = c.verdict_in ? (run.verdict !== undefined && c.verdict_in.includes(run.verdict)) : null;
        const recall = ratio(found.length, c.expected.length);
        scores.push({
            case: c.name, found, missed, false_positives: fps, unlisted, recall,
            precision: ratio(matchedActual.size, run.findings.length), verdict_ok,
            pass: missed.length === 0 && fps.length === 0 && verdict_ok !== false,
        });
        totExp += c.expected.length; totFound += found.length; totReported += run.findings.length; totMatched += matchedActual.size;
    }

    const passes: PassStat[] = [...passAgg.entries()].map(([pass, a]) => {
        const precision = ratio(a.hit, a.reported);
        let advice: PassStat["advice"] = "KEEP";
        if (a.reported < 3) advice = a.reported === 0 ? "NO_DATA" : "KEEP";
        else if (a.hit === 0 && a.fp > 0) advice = "DEMOTE";
        else if ((precision ?? 0) < 20) advice = "REVIEW_COST";
        return { pass, reported: a.reported, hit_expected: a.hit, hit_must_not: a.fp, unlisted: a.unlisted, precision, advice };
    }).sort((x, y) => y.reported - x.reported);

    if (scores.length < 5) notes.push("fewer than 5 cases: per-pass numbers are anecdotes, not statistics");
    notes.push("'unlisted' findings are not automatically false positives: they are findings no case author expected. Review them and either add them to expected or to must_not.");
    return { cases: scores, passes, overall: { recall: ratio(totFound, totExp), precision: ratio(totMatched, totReported), cases_passed: scores.filter((s) => s.pass).length, cases: scores.length }, notes };
}

export function renderEval(r: EvalReport): string {
    const o = [`# Review eval: ${r.overall.cases_passed}/${r.overall.cases} case(s) pass · recall ${r.overall.recall ?? "n/a"}% · precision ${r.overall.precision ?? "n/a"}%`, ""];
    for (const c of r.cases) {
        o.push(`${c.pass ? "PASS" : "FAIL"}  ${c.case}  recall ${c.recall ?? "n/a"}% precision ${c.precision ?? "n/a"}% unlisted ${c.unlisted}${c.verdict_ok === false ? " VERDICT WRONG" : ""}`);
        if (c.missed.length) o.push(`      missed: ${c.missed.join(", ")}`);
        if (c.false_positives.length) o.push(`      wrong: ${c.false_positives.join(", ")}`);
    }
    o.push("", "Per pass (reported / hit expected / hit must_not / unlisted / precision):");
    for (const p of r.passes) o.push(`  pass ${String(p.pass).padEnd(10)} ${String(p.reported).padStart(3)} / ${p.hit_expected} / ${p.hit_must_not} / ${p.unlisted} / ${p.precision ?? "n/a"}%  ${p.advice}`);
    o.push("", ...r.notes.map((n) => `note: ${n}`));
    return o.join("\n");
}

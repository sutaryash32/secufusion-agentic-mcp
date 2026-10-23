const SEV = { blocker: 3, critical: 3, major: 2, warning: 2, high: 2, minor: 1, medium: 1, suggestion: 0, nit: 0, low: 0, info: 0 };
const rank = (s) => SEV[(s ?? "").toLowerCase()] ?? 0;
const sameFile = (a, b) => {
    if (!a || !b)
        return false;
    const x = a.replace(/\\/g, "/"), y = b.replace(/\\/g, "/");
    return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
};
export function matches(f, e) {
    if (e.file && !sameFile(f.file, e.file))
        return false;
    if (e.line !== undefined && (f.line === undefined || Math.abs(f.line - e.line) > (e.near ?? 15)))
        return false;
    if (e.category && (f.category ?? "").toLowerCase() !== e.category.toLowerCase())
        return false;
    if (e.rule && (f.rule ?? "").toLowerCase() !== e.rule.toLowerCase())
        return false;
    if (e.rule_any_of?.length && !e.rule_any_of.some((r) => r.toLowerCase() === (f.rule ?? "").toLowerCase()))
        return false;
    if (e.min_severity && rank(f.severity) < rank(e.min_severity))
        return false;
    return true;
}
const ratio = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
const label = (e, i) => e.id ?? `${e.rule ?? e.category ?? "expect"}@${e.file ?? "*"}${e.line !== undefined ? ":" + e.line : ""}#${i + 1}`;
export function scoreRuns(cases, runs) {
    const byCase = new Map(cases.map((c) => [c.name, c]));
    const scores = [];
    const passAgg = new Map();
    const notes = [];
    let totExp = 0, totFound = 0, totReported = 0, totMatched = 0;
    for (const run of runs) {
        const c = byCase.get(run.case);
        if (!c) {
            notes.push(`run for unknown case "${run.case}" ignored`);
            continue;
        }
        const found = [], missed = [], fps = [];
        const matchedActual = new Set();
        c.expected.forEach((e, i) => {
            const idx = run.findings.findIndex((f) => matches(f, e));
            if (idx >= 0) {
                found.push(label(e, i));
                run.findings.forEach((f, k) => { if (matches(f, e))
                    matchedActual.add(k); });
            }
            else
                missed.push(label(e, i));
        });
        const bad = new Set();
        (c.must_not ?? []).forEach((e, i) => run.findings.forEach((f, k) => { if (matches(f, e)) {
            bad.add(k);
            fps.push(`${label(e, i)} <- ${f.title ?? f.rule ?? f.category ?? "finding"}`);
        } }));
        run.findings.forEach((f, k) => {
            const key = f.pass === undefined ? "(untagged)" : String(f.pass);
            const a = passAgg.get(key) ?? { reported: 0, hit: 0, fp: 0, unlisted: 0 };
            a.reported++;
            if (bad.has(k))
                a.fp++;
            else if (matchedActual.has(k))
                a.hit++;
            else
                a.unlisted++;
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
        totExp += c.expected.length;
        totFound += found.length;
        totReported += run.findings.length;
        totMatched += matchedActual.size;
    }
    const passes = [...passAgg.entries()].map(([pass, a]) => {
        const precision = ratio(a.hit, a.reported);
        let advice = "KEEP";
        if (a.reported < 3)
            advice = a.reported === 0 ? "NO_DATA" : "KEEP";
        else if (a.hit === 0 && a.fp > 0)
            advice = "DEMOTE";
        else if ((precision ?? 0) < 20)
            advice = "REVIEW_COST";
        return { pass, reported: a.reported, hit_expected: a.hit, hit_must_not: a.fp, unlisted: a.unlisted, precision, advice };
    }).sort((x, y) => y.reported - x.reported);
    if (scores.length < 5)
        notes.push("fewer than 5 cases: per-pass numbers are anecdotes, not statistics");
    notes.push("'unlisted' findings are not automatically false positives: they are findings no case author expected. Review them and either add them to expected or to must_not.");
    return { cases: scores, passes, overall: { recall: ratio(totFound, totExp), precision: ratio(totMatched, totReported), cases_passed: scores.filter((s) => s.pass).length, cases: scores.length }, notes };
}
export function renderEval(r) {
    const o = [`# Review eval: ${r.overall.cases_passed}/${r.overall.cases} case(s) pass · recall ${r.overall.recall ?? "n/a"}% · precision ${r.overall.precision ?? "n/a"}%`, ""];
    for (const c of r.cases) {
        o.push(`${c.pass ? "PASS" : "FAIL"}  ${c.case}  recall ${c.recall ?? "n/a"}% precision ${c.precision ?? "n/a"}% unlisted ${c.unlisted}${c.verdict_ok === false ? " VERDICT WRONG" : ""}`);
        if (c.missed.length)
            o.push(`      missed: ${c.missed.join(", ")}`);
        if (c.false_positives.length)
            o.push(`      wrong: ${c.false_positives.join(", ")}`);
    }
    o.push("", "Per pass (reported / hit expected / hit must_not / unlisted / precision):");
    for (const p of r.passes)
        o.push(`  pass ${String(p.pass).padEnd(10)} ${String(p.reported).padStart(3)} / ${p.hit_expected} / ${p.hit_must_not} / ${p.unlisted} / ${p.precision ?? "n/a"}%  ${p.advice}`);
    o.push("", ...r.notes.map((n) => `note: ${n}`));
    return o.join("\n");
}

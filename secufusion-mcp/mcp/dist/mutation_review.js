import path from "path";
import { execFileSync } from "child_process";
export const COMMANDS = {
    "java/kotlin": "mvn org.pitest:pitest-maven:mutationCoverage -DoutputFormats=XML -DtargetClasses='<pkg>.*' -DwithHistory=true   (or gradle pitest)",
    "javascript/typescript": "npx stryker run --reporters json --mutate '<changed files>'",
    csharp: "dotnet stryker --reporter json --since:<base>",
    php: "vendor/bin/infection --logger-json=infection.json --git-diff-filter=AM --git-diff-base=<base>",
    python: "mutmut run --paths-to-mutate <changed files>; then convert `mutmut results` to the generic JSON",
    go: "go-mutesting ./...; then convert the survivors to the generic JSON",
    rust: "cargo mutants --in-diff <diff file>",
    ruby: "bundle exec mutant run --since <base>",
};
const GUARD = /ConditionalsBoundary|NegateConditionals|RemoveConditional|ConditionalExpression|EqualityOperator|LogicalOperator|BooleanLiteral|NegatedCondition|RemoveCall|VoidMethodCall|NonVoidMethodCall|MethodExpression|BlockStatement|Conditional|IfStatement|Throw|Exception|Authoriz|Guard/i;
const MEANING = (m) => /ConditionalsBoundary|EqualityOperator|ConditionalExpression/i.test(m) ? "a comparison or boundary can change and no test fails"
    : /NegateConditionals|NegatedCondition|RemoveConditional|IfStatement/i.test(m) ? "a condition can be inverted or removed and no test fails: the guard is untested"
        : /RemoveCall|VoidMethodCall|NonVoidMethodCall|MethodExpression|BlockStatement/i.test(m) ? "a call or block can be removed and no test fails (a check, save, publish or audit write is untested)"
            : /LogicalOperator/i.test(m) ? "&& / || can be swapped and no test fails"
                : /BooleanLiteral/i.test(m) ? "a boolean can be flipped and no test fails"
                    : "this behaviour can change and no test fails";
const status = (s) => {
    const u = s.toUpperCase().replace(/[\s_-]/g, "");
    if (u === "SURVIVED")
        return "SURVIVED";
    if (u === "NOCOVERAGE")
        return "NO_COVERAGE";
    if (u === "KILLED" || u === "TIMEDOUT" || u === "TIMEOUT" || u === "MEMORYERROR" || u === "RUNTIMEERROR" || u === "COMPILEERROR")
        return "KILLED";
    return "OTHER";
};
export function parseMutationReport(content) {
    const t = content.trimStart();
    if (t.startsWith("<")) {
        const mutants = [];
        for (const m of content.matchAll(/<mutation\b([^>]*)>([\s\S]*?)<\/mutation>/g)) {
            const attrs = m[1], body = m[2];
            const tag = (n) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body)?.[1]?.trim() ?? "";
            const st = /status=['"]([^'"]+)['"]/.exec(attrs)?.[1] ?? "";
            const cls = tag("mutatedClass").split("$")[0];
            const src = tag("sourceFile");
            const file = cls.includes(".") ? cls.replace(/\./g, "/") + path.extname(src) : src;
            mutants.push({ file, line: Number(tag("lineNumber")), mutator: tag("mutator").split(".").pop() ?? "", status: status(st), description: tag("description"), method: tag("mutatedMethod") });
        }
        return { format: "PIT XML", mutants };
    }
    const j = JSON.parse(content);
    if (j && typeof j === "object" && j.files && typeof j.files === "object") {
        const mutants = [];
        for (const [file, f] of Object.entries(j.files)) {
            for (const m of f.mutants ?? []) {
                mutants.push({ file, line: m.location?.start?.line ?? 0, mutator: m.mutatorName ?? "", status: status(String(m.status ?? "")), description: m.replacement ?? m.description });
            }
        }
        return { format: "mutation-testing-elements JSON (Stryker / Stryker.NET / Infection)", mutants };
    }
    const list = Array.isArray(j) ? j : Array.isArray(j?.mutants) ? j.mutants : [];
    return { format: "generic JSON", mutants: list.map((m) => ({ file: String(m.file ?? ""), line: Number(m.line ?? 0), mutator: String(m.mutator ?? m.operator ?? ""), status: status(String(m.status ?? "")), description: m.description })) };
}
/** Changed line ranges (new side) from `git diff -U0`. */
export function changedRanges(root, base) {
    if (!/^[\w./~^@{}-]+$/.test(base))
        throw new Error(`unsafe base ref: ${base}`);
    const out = execFileSync("git", ["-C", root, "diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return parseUnifiedZero(out);
}
export function parseUnifiedZero(diff) {
    const r = {};
    let file = "";
    for (const l of diff.split("\n")) {
        const f = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(l);
        if (f) {
            file = f[1] ?? "";
            continue;
        }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (h && file) {
            const start = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
            if (len > 0)
                (r[file] ??= []).push([start, start + len - 1]);
        }
    }
    return r;
}
const base = (p) => p.split(/[\\/]/).pop() ?? p;
function resolveFile(mutantFile, changed) {
    const mf = mutantFile.replace(/\\/g, "/");
    const exact = changed.filter((c) => c === mf || c.endsWith("/" + mf) || mf.endsWith("/" + c));
    if (exact.length === 1)
        return exact[0];
    if (exact.length > 1)
        return null;
    const byBase = changed.filter((c) => base(c) === base(mf));
    return byBase.length === 1 ? byBase[0] : null;
}
export function reviewMutants(parsed, changed) {
    const changedFiles = Object.keys(changed);
    const weak = [];
    let onChanged = 0, killed = 0;
    const unmatched = new Set();
    for (const m of parsed.mutants) {
        const f = resolveFile(m.file, changedFiles);
        if (!f) {
            if (m.file)
                unmatched.add(m.file);
            continue;
        }
        if (!changed[f].some(([a, b]) => m.line >= a && m.line <= b))
            continue;
        if (m.status === "OTHER")
            continue;
        onChanged++;
        if (m.status === "KILLED") {
            killed++;
            continue;
        }
        weak.push({ file: f, line: m.line, mutator: m.mutator, status: m.status, meaning: MEANING(m.mutator), guard: GUARD.test(m.mutator) });
    }
    weak.sort((a, b) => Number(b.guard) - Number(a.guard) || a.file.localeCompare(b.file) || a.line - b.line);
    const notes = [];
    if (onChanged === 0)
        notes.push("no mutant fell on a changed line: the tool may not have been run on the changed code, or the files did not match. Check the report path and the changed files.");
    if (unmatched.size)
        notes.push(`${unmatched.size} mutated file(s) matched no changed file (expected when the tool mutated the whole project).`);
    notes.push("a survivor is a lead: some mutants are equivalent (the code means the same thing). Read the line before reporting it.");
    return {
        format: parsed.format, mutants_total: parsed.mutants.length, changed_files: changedFiles.length,
        mutants_on_changed_lines: onChanged, killed_on_changed_lines: killed,
        score_on_changed_lines: onChanged ? Math.round((killed / onChanged) * 1000) / 10 : null,
        weak_spots: weak, unmatched_mutant_files: [...unmatched].slice(0, 20), notes,
    };
}
export function renderMutationReview(r) {
    const out = [`# Mutation review (${r.format})`, `${r.mutants_total} mutants · ${r.mutants_on_changed_lines} on changed lines · mutation score on changed lines ${r.score_on_changed_lines === null ? "n/a" : r.score_on_changed_lines + "%"}`, ""];
    if (!r.weak_spots.length)
        out.push("No surviving mutant on a changed line.");
    for (const w of r.weak_spots)
        out.push(`${w.guard ? "GUARD  " : "       "}${w.file}:${w.line}  ${w.status}  ${w.mutator}\n         ${w.meaning}`);
    out.push("", ...r.notes.map((n) => `note: ${n}`), "", "To produce a report:", ...Object.entries(COMMANDS).map(([k, v]) => `  ${k}: ${v}`));
    return out.join("\n");
}

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { CaseSpec, Expected, scoreRuns, RunIn, EvalReport } from "./review_eval.js";
import { runQuickCheck } from "./quick_check.js";
import { decideVerdict } from "./review_findings.js";

/**
 * The eval corpus: known changes with known answers, so the reviewer can be measured instead of trusted.
 *
 * A case is a folder `evals/cases/<name>/`:
 *   case.json   repoKey, description, quick_check (true when the mechanical check can judge it),
 *               expect { mustFind[], mustNotFind[], verdictIn[] }
 *   base/       the repository before
 *   head/       files that change (copied over base)
 *   delete.txt  optional: paths removed in head
 *
 * Cases the quick check can judge are scored deterministically (no model, runs in tests). The others are
 * the ones that need reasoning (cross-repo contracts, tenant leaks, locks); they are listed as `needs_model`
 * and scored with `score_review_run` from findings a real review produced. A reviewer that cannot find a
 * known bug, or flags a known-clean change, is a regression in the reviewer itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const corpusDir = () => {
    for (const p of [path.resolve(here, "..", "..", "evals", "cases"), path.resolve(here, "..", "evals", "cases")]) if (fs.existsSync(p)) return p;
    return path.resolve(here, "..", "..", "evals", "cases");
};

interface RawExpect { ruleId?: string; ruleIdAnyOf?: string[]; file?: string; minSeverity?: string; nearLines?: [number, number] }
export interface RawCase { repoKey: string; description?: string; quick_check?: boolean; expect?: { mustFind?: RawExpect[]; mustNotFind?: RawExpect[]; verdictIn?: string[] } }

const toExpected = (e: RawExpect): Expected => ({
    ...(e.ruleId ? { rule: e.ruleId } : {}), ...(e.ruleIdAnyOf ? { rule_any_of: e.ruleIdAnyOf } : {}),
    ...(e.file ? { file: e.file } : {}), ...(e.minSeverity ? { min_severity: e.minSeverity } : {}),
    ...(e.nearLines ? { line: Math.round((e.nearLines[0] + e.nearLines[1]) / 2), near: Math.ceil((e.nearLines[1] - e.nearLines[0]) / 2) + 3 } : {}),
});

export function loadCases(dir = corpusDir()): Array<{ name: string; dir: string; raw: RawCase; spec: CaseSpec }> {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "case.json"))).sort(); } catch { return []; }
    return names.map((name) => {
        const raw: RawCase = JSON.parse(fs.readFileSync(path.join(dir, name, "case.json"), "utf8"));
        return { name, dir: path.join(dir, name), raw, spec: { name, expected: (raw.expect?.mustFind ?? []).map(toExpected), must_not: (raw.expect?.mustNotFind ?? []).map(toExpected), verdict_in: raw.expect?.verdictIn } };
    });
}

const copyTree = (from: string, to: string) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

/** A fixture that needs a credential-shaped value writes {{S}}; each build replaces it with a fresh random one, so no secret-shaped text is stored in the repository. */
function fillPlaceholders(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { fillPlaceholders(p); continue; }
        let text: string;
        try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (text.includes("{{S}}")) fs.writeFileSync(p, text.replace(/\{\{S\}\}/g, () => crypto.randomBytes(10).toString("hex")));
    }
}

/** Builds the case as a real git repository (base on `develop`, head applied on `feature`). Returns the repo path. */
export function materialize(c: { dir: string; raw: RawCase }, into: string): string {
    const repo = path.join(into, c.raw.repoKey);
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=eval", "-c", "user.email=eval@localhost", "-c", "commit.gpgsign=false", ...a], { stdio: ["ignore", "pipe", "pipe"] });
    copyTree(path.join(c.dir, "base"), repo);
    git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/develop");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    copyTree(path.join(c.dir, "head"), repo);
    fillPlaceholders(repo);
    try { for (const p of fs.readFileSync(path.join(c.dir, "delete.txt"), "utf8").split(/\r?\n/).filter(Boolean)) fs.rmSync(path.join(repo, p), { force: true }); } catch { /* none */ }
    git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", "head");
    return repo;
}

export interface CorpusReport { report: EvalReport; needs_model: Array<{ name: string; description?: string }>; scored: string[] }

/** Runs the quick check over every case it can judge and scores it against the expectations. */
export function runQuickCorpus(dir = corpusDir()): CorpusReport {
    const cases = loadCases(dir);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfn-eval-"));
    const runs: RunIn[] = [];
    const specs: CaseSpec[] = [];
    const needs: CorpusReport["needs_model"] = [];
    try {
        for (const c of cases) {
            if (!c.raw.quick_check) { needs.push({ name: c.name, description: c.raw.description }); continue; }
            const repo = materialize(c, path.join(tmp, c.name));
            const r = runQuickCheck(repo, { repoKey: c.raw.repoKey });
            const { verdict } = decideVerdict(r.findings);
            runs.push({ case: c.name, verdict, findings: r.findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, rule: f.ruleId, category: f.category, title: f.title, pass: "quick-check" })) });
            specs.push(c.spec);
        }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return { report: scoreRuns(specs, runs), needs_model: needs, scored: specs.map((s) => s.name) };
}

/** Turns a closed bug into a regression case skeleton: the fix's parent as base, the fix reversed as head is NOT guessed; the author fills `expect`. */
export function draftCaseFromFix(root: string, fixSha: string, name?: string, outDir?: string): { path: string; case: RawCase & { source: object } } {
    if (!/^[0-9a-f]{7,40}$/i.test(fixSha)) throw new Error("fix_sha must be a commit hash");
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const subject = git("log", "-1", "--format=%s", fixSha);
    const files = git("diff", "--name-only", `${fixSha}^`, fixSha).split("\n").filter((p) => p && !/(^|\/)(src\/test\/|__tests__\/|docs?\/)|\.md$/.test(p));
    // The bug was introduced by whichever commit last touched the lines the fix changed.
    const intro = new Set<string>();
    for (const f of files.slice(0, 8)) {
        for (const l of git("diff", "-U0", `${fixSha}^`, fixSha, "--", f).split("\n")) {
            const h = l.match(/^@@ -(\d+)(?:,(\d+))? /);
            if (!h) continue;
            const a = Number(h[1]), n = h[2] === undefined ? 1 : Number(h[2]);
            if (n === 0) continue;
            try { const s = git("log", "-1", "--format=%H", `-L${a},${a + n - 1}:${f}`, `${fixSha}^`).split("\n")[0]; if (/^[0-9a-f]{40}$/.test(s)) intro.add(s); } catch { /* new file */ }
        }
    }
    const slug = (name ?? subject).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fix";
    const dir = path.join(outDir ?? path.join(root, ".secufusion", "evals", "cases"), `history-${slug}`);
    const c = {
        repoKey: path.basename(path.resolve(root)),
        description: `Missed bug, fixed by ${fixSha.slice(0, 10)} "${subject}". Review the change that introduced it; the reviewer should flag the code the fix changed, at major or worse.`,
        quick_check: false,
        source: { fix: fixSha, fixSubject: subject, introducedBy: [...intro], files },
        expect: { mustFind: files.slice(0, 3).map((file) => ({ file, minSeverity: "major" })), verdictIn: ["fix_first", "needs_discussion"] },
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(c, null, 2) + "\n");
    return { path: dir, case: c as any };
}

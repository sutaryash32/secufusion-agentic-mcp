/**
 * Merge-regression detection: functionality accidentally lost while a merge was resolved.
 *
 * DETECT, REPORT, EXPLAIN. Nothing here changes the repository: it only reads git. The developer decides whether a
 * difference is intentional. A symbol missing from a merge is never called dead code or a cleanup candidate here: it is a
 * POSSIBLE MERGE REGRESSION, with the merge commit, both parents and the merge base as evidence.
 *
 * Method: for each merge commit M with parents P1..Pn and merge base B, extract symbols (methods, endpoints, security
 * checks, queries and predicates, tests, config keys, translation keys, OpenAPI annotations, doc headings) per file from
 * every version. A symbol is reported when it is present in a parent and absent in M, except where git's own three-way
 * logic explains it: it was in the base and the OTHER parent deleted it (the merge honoured a deliberate deletion), or it
 * moved to another file in the same merge. Extraction is regex-based, so it is a detector, not a proof.
 */
import fs from "fs";
import path from "path";
import { git, gitTop } from "./diff_quality.js";

export type Severity = "HIGH" | "MEDIUM" | "LOW";
export type Kind =
    | "SECURITY_VALIDATION" | "AUTHORIZATION_CHECK" | "API_ENDPOINT" | "REPOSITORY_QUERY" | "QUERY_PREDICATE"
    | "METHOD" | "TEST_CASE" | "CONFIG_KEY" | "PUBLIC_API_CHANGED"
    | "TRANSLATION_KEY" | "OPENAPI_ANNOTATION" | "DOCUMENTATION";

export const SEVERITY: Record<Kind, Severity> = {
    SECURITY_VALIDATION: "HIGH", AUTHORIZATION_CHECK: "HIGH", API_ENDPOINT: "HIGH", REPOSITORY_QUERY: "HIGH", QUERY_PREDICATE: "HIGH",
    METHOD: "MEDIUM", TEST_CASE: "MEDIUM", CONFIG_KEY: "MEDIUM", PUBLIC_API_CHANGED: "MEDIUM",
    TRANSLATION_KEY: "LOW", OPENAPI_ANNOTATION: "LOW", DOCUMENTATION: "LOW",
};
const RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export interface Sym { kind: Kind; key: string; display: string }

// ── symbol extraction ───────────────────────────────────────────────────────

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[ \t])\/\/.*$/gm, "$1");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function depth(s: string): number {
    let d = 0, q: string | null = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") q = c; else if (c === "(") d++; else if (c === ")") d--;
    }
    return d;
}

function splitParams(params: string): string[] {
    const out: string[] = []; let cur = "", a = 0, p = 0;
    for (const c of params) {
        if (c === "<") a++; else if (c === ">") a--; else if (c === "(") p++; else if (c === ")") p--;
        if (c === "," && a === 0 && p === 0) { out.push(cur); cur = ""; } else cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

const stringLiterals = (s: string): string[] => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

const JAVA_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "case", "assert", "yield", "do", "try", "synchronized", "super", "this"]);
const HEAD = /^(?:(?:public|protected|private|static|final|abstract|synchronized|default|native|strictfp)\s+)*(?:<[^>]+>\s+)?([\w.<>\[\],?\s]+?)\s+(\w+)\s*\(/;
const SEC_LINE = /(hasAuthority|hasAnyAuthority|hasRole|isCallerAncestorOrSelf|assertTenant|validateTenant|verifyTenant|checkTenant|checkAccess|AccessDenied|ForbiddenException|SecurityContextHolder|getActingTenant|isAuthorized|authorize\()/;
const AUTH_ANN = /^@(PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/;
const OPENAPI_ANN = /^@(Operation|ApiResponses?|Tag|Parameter|Schema|Hidden|SecurityRequirement)\b/;
const MAP_ANN = /^@(Get|Post|Put|Delete|Patch|Request)Mapping\b/;
const TEST_ANN = /^@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/;

function predicates(query: string): string[] {
    const q = query.toLowerCase().replace(/\s+/g, " ");
    const where = q.includes(" where ") ? q.slice(q.indexOf(" where ")) : q;
    const out = new Set<string>();
    for (const m of where.matchAll(/([\w.]+)\s*(=|<>|!=|>=|<=|>|<|\blike\b|\bin\b|\bis not null\b|\bis null\b)\s*(:\w+|\?\d*|\([^)]*\)|'[^']*'|[\w.]+)?/g)) {
        if (["where", "and", "or", "on", "select", "from"].includes(m[1])) continue;
        out.add(norm(`${m[1]} ${m[2]} ${m[3] ?? ""}`));
    }
    return [...out];
}

function extractJava(file: string, src: string): Sym[] {
    const out: Sym[] = [];
    const lines = stripComments(src).split(/\r?\n/);
    const isRepo = /(Repository|Dao)\b/.test(path.basename(file));
    let ann: string[] = [], classBase = "", cur = "";
    for (let i = 0; i < lines.length; i++) {
        let t = lines[i].trim();
        if (!t) continue;
        // leading annotations (possibly several, possibly on the declaration's own line, possibly spanning lines)
        while (t.startsWith("@")) {
            let a = t;
            while (depth(a) > 0 && i + 1 < lines.length) a += " " + lines[++i].trim();
            const m = /^@\w+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*/.exec(a);
            if (!m) break;
            ann.push(norm(m[0]));
            t = a.slice(m[0].length).trim();
        }
        if (!t) continue;
        if (/^(?:(?:public|protected|private|abstract|final|static)\s+)*(?:class|interface|enum|record)\s+\w+/.test(t)) {
            const mp = ann.find((a) => /^@RequestMapping\b/.test(a));
            if (mp) classBase = stringLiterals(mp)[0] ?? "";
            ann = []; continue;
        }
        const head = HEAD.exec(t);
        if (head && !JAVA_KEYWORDS.has(head[1].trim().split(/\s+/)[0]) && !JAVA_KEYWORDS.has(head[2])) {
            let decl = t;
            while (depth(decl) > 0 && i + 1 < lines.length) decl += " " + lines[++i].trim();
            const open = decl.indexOf("(");
            let d = 0, close = open;
            for (let k = open; k < decl.length; k++) { if (decl[k] === "(") d++; else if (decl[k] === ")") { d--; if (d === 0) { close = k; break; } } }
            const params = splitParams(decl.slice(open + 1, close));
            const name = head[2];
            const key = `${name}/${params.length}`;
            const types = params.map((p) => norm(p.replace(/@\w+(\([^)]*\))?\s*/g, "").replace(/\s+\w+$/, "")));
            const shown = `${name}(${types.join(", ")})`;
            cur = key;
            let isEndpoint = false;
            for (const a of ann) {
                if (MAP_ANN.test(a)) {
                    const kind = /^@(\w+?)Mapping/.exec(a)![1];
                    const verb = kind === "Request" ? (/RequestMethod\.(\w+)/.exec(a)?.[1] ?? "ANY") : kind.toUpperCase();
                    const paths = stringLiterals(a);
                    for (const p of paths.length ? paths : [""]) {
                        const full = ("/" + [classBase, p].filter(Boolean).join("/")).replace(/\/+/g, "/");
                        out.push({ kind: "API_ENDPOINT", key: `${verb} ${full}`, display: `${verb} ${full} -> ${shown}` });
                        isEndpoint = true;
                    }
                } else if (AUTH_ANN.test(a)) {
                    out.push({ kind: "AUTHORIZATION_CHECK", key: `${key}@${a}`, display: `${a} on ${shown}` });
                } else if (OPENAPI_ANN.test(a)) {
                    out.push({ kind: "OPENAPI_ANNOTATION", key: `${key}@${/^@\w+/.exec(a)![0]}`, display: `${/^@\w+/.exec(a)![0]} on ${shown}` });
                } else if (/^@Query\b/.test(a)) {
                    for (const p of predicates(stringLiterals(a).join(" "))) out.push({ kind: "QUERY_PREDICATE", key: `${key}#${p}`, display: `query predicate \`${p}\` in ${shown}` });
                }
            }
            if (ann.some((a) => TEST_ANN.test(a))) out.push({ kind: "TEST_CASE", key: `${path.basename(file)}::${name}`, display: `test ${shown} in ${path.basename(file)}` });
            else if (isRepo) out.push({ kind: "REPOSITORY_QUERY", key, display: `repository method ${shown}` });
            else if (!isEndpoint) out.push({ kind: "METHOD", key, display: `method ${shown}` });
            ann = [];
            continue;
        }
        if (cur && SEC_LINE.test(t)) out.push({ kind: "SECURITY_VALIDATION", key: `${cur}|${norm(t)}`, display: `in ${cur.split("/")[0]}(): \`${norm(t).slice(0, 140)}\`` });
        ann = [];
    }
    return out;
}

function extractJs(file: string, src: string): Sym[] {
    const out: Sym[] = [];
    const text = stripComments(src);
    const isTest = /\.(test|spec)\.[jt]sx?$|__tests__/.test(file);
    const seen = new Set<string>();
    const add = (s: Sym) => { const k = s.kind + s.key; if (!seen.has(k)) { seen.add(k); out.push(s); } };
    for (const m of text.matchAll(/\bfunction\*?\s+(\w+)\s*\(/g)) add({ kind: "METHOD", key: m[1], display: `function ${m[1]}()` });
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>/g)) add({ kind: "METHOD", key: m[1], display: `function ${m[1]}()` });
    for (const m of text.matchAll(/^[ \t]{2,}(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]| ,.]+)?\s*\{/gm)) {
        if (!["if", "for", "while", "switch", "catch", "function", "constructor", "return"].includes(m[1])) add({ kind: "METHOD", key: m[1], display: `method ${m[1]}()` });
    }
    for (const m of text.matchAll(/\b(?:app|router|\w*[rR]outer)\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\2/g)) add({ kind: "API_ENDPOINT", key: `${m[1].toUpperCase()} ${m[3]}`, display: `${m[1].toUpperCase()} ${m[3]}` });
    if (isTest) for (const m of text.matchAll(/\b(?:it|test)(?:\.(?:only|skip))?\(\s*(['"`])([^'"`]+)\1/g)) add({ kind: "TEST_CASE", key: `${path.basename(file)}::${m[2]}`, display: `test "${m[2]}" in ${path.basename(file)}` });
    for (const line of text.split(/\r?\n/)) {
        if (/(hasPermission|isAuthorized|checkPermission|requireAuth|requireRole|verifyToken|isAuthenticated|canAccess)/.test(line)) add({ kind: "SECURITY_VALIDATION", key: norm(line), display: `\`${norm(line).slice(0, 140)}\`` });
    }
    return out;
}

function flatten(o: any, prefix = "", out: string[] = []): string[] {
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    else if (prefix) out.push(prefix);
    return out;
}

function yamlKeys(src: string): string[] {
    const keys: string[] = [], stack: Array<{ indent: number; key: string }> = [];
    for (const raw of src.split(/\r?\n/)) {
        if (!raw.trim() || raw.trim().startsWith("#") || raw.trim().startsWith("-")) continue;
        const m = /^(\s*)([\w.\-"/]+)\s*:/.exec(raw);
        if (!m) continue;
        const indent = m[1].length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        stack.push({ indent, key: m[2].replace(/"/g, "") });
        keys.push(stack.map((s) => s.key).join("."));
    }
    return keys;
}

export function extractSymbols(file: string, src: string): Sym[] {
    const f = file.replace(/\\/g, "/");
    const base = path.basename(f);
    if (/\.java$/.test(f)) return extractJava(f, src);
    if (/\.(jsx?|tsx?|mjs|cjs)$/.test(f)) return extractJs(f, src);
    if (/(^|\/)(application|bootstrap)[\w.-]*\.(properties|ya?ml)$/.test(f) || /(^|\/)\.env(\.[\w.-]+)?$/.test(f) || /(^|\/)config\/[^/]+\.properties$/.test(f)) {
        let keys: string[];
        if (/\.ya?ml$/.test(f)) keys = yamlKeys(src);
        else keys = [...src.matchAll(/^\s*(?:export\s+)?([\w.\-\[\]]+)\s*[=:]/gm)].filter((m) => !m[0].trim().startsWith("#") && !m[0].trim().startsWith("!")).map((m) => m[1]);
        return keys.map((k) => ({ kind: "CONFIG_KEY" as Kind, key: k, display: `config key \`${k}\`` }));
    }
    if (/\.json$/.test(f) && (/(^|\/)(i18n|locales?|translations?|lang|messages)\//i.test(f) || /^[a-z]{2}([-_][A-Za-z]{2})?\.json$/.test(base))) {
        try { return flatten(JSON.parse(src.replace(/^﻿/, ""))).map((k) => ({ kind: "TRANSLATION_KEY" as Kind, key: k, display: `translation key \`${k}\`` })); } catch { return []; }
    }
    if (/(^|\/)messages[\w-]*\.properties$/.test(f)) {
        return [...src.matchAll(/^\s*([\w.\-]+)\s*=/gm)].map((m) => ({ kind: "TRANSLATION_KEY" as Kind, key: m[1], display: `translation key \`${m[1]}\`` }));
    }
    if (/\.md$/.test(f)) {
        return [...src.matchAll(/^(#{1,4})\s+(.+?)\s*#*\s*$/gm)].map((m) => ({ kind: "DOCUMENTATION" as Kind, key: `${m[1]} ${norm(m[2])}`, display: `documentation heading "${norm(m[2])}"` }));
    }
    return [];
}

// ── analysis ────────────────────────────────────────────────────────────────

export interface MergeFinding {
    file: string; kind: Kind; severity: Severity; display: string;
    present_in: string[]; in_base: boolean; merge: string; merge_subject: string;
    observation: string; risk: string;
}
export interface MergeSummary { sha: string; subject: string; parents: string[]; base: string | null; files_examined: number; findings: number; moved_not_reported: number; deletions_honoured: number; truncated: boolean }
export interface MergeReport {
    root: string | null; range: string; merges: MergeSummary[]; findings: MergeFinding[];
    counts: Record<Severity, number>; notes: string[];
}

const ANALYZABLE = /\.(java|jsx?|tsx?|mjs|cjs|properties|ya?ml|json|md)$|(^|\/)\.env(\.[\w.-]+)?$/;
const SKIP = /(^|\/)(node_modules|dist|build|target|\.git|coverage)\//;
const MAX_FILES = 400, MAX_BYTES = 1_000_000;
const MOVABLE = new Set<Kind>(["METHOD", "REPOSITORY_QUERY", "API_ENDPOINT"]);
const short = (s: string) => s.slice(0, 7);

const RISK: Record<Severity, string> = {
    HIGH: "Potential accidental loss of security, authorization, an API contract or a data-access guarantee.",
    MEDIUM: "Potential accidental functionality loss.",
    LOW: "Potential accidental loss of supporting material (text, annotations or documentation).",
};

function observation(k: Kind, display: string, where: string): string {
    const what: Record<Kind, string> = {
        SECURITY_VALIDATION: "A security-related check", AUTHORIZATION_CHECK: "An authorization annotation", API_ENDPOINT: "An API endpoint",
        REPOSITORY_QUERY: "A repository method", QUERY_PREDICATE: "A query predicate", METHOD: "A method", TEST_CASE: "A test case",
        CONFIG_KEY: "A configuration key", PUBLIC_API_CHANGED: "A public method signature", TRANSLATION_KEY: "A translation key",
        OPENAPI_ANNOTATION: "An OpenAPI/Swagger annotation", DOCUMENTATION: "A documentation heading",
    };
    return k === "PUBLIC_API_CHANGED"
        ? `${display} existed ${where} with a different parameter list than any version in the merge result: the signature changed during the merge.`
        : `${what[k]} (${display}) existed ${where} but is absent in the merge result.`;
}

function defaultBase(top: string): string | null {
    const head = (git(top, ["rev-parse", "HEAD"]) ?? "").trim();
    for (const c of ["origin/develop", "develop", "origin/main", "origin/master", "main", "master"]) {
        const sha = (git(top, ["rev-parse", "--verify", "-q", c]) ?? "").trim();
        if (sha && sha !== head) { const mb = (git(top, ["merge-base", "HEAD", c]) ?? "").trim(); if (mb) return mb; }
    }
    return null;
}

export function analyzeMergeRegressions(cwd: string, opts: { base?: string; merge_commit?: string; max_merges?: number } = {}): MergeReport {
    const top = gitTop(cwd);
    const report: MergeReport = { root: top, range: "", merges: [], findings: [], counts: { HIGH: 0, MEDIUM: 0, LOW: 0 }, notes: [] };
    if (!top) { report.notes.push("Not a git repository: there is no merge history to scan."); return report; }

    const max = Math.max(1, Math.min(opts.max_merges ?? 10, 50));
    type Job = { sha: string | null; parents: string[]; subject: string };
    const jobs: Job[] = [];
    const mergeHead = git(top, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.trim();
    if (mergeHead && !opts.merge_commit) {
        const headSha = (git(top, ["rev-parse", "HEAD"]) ?? "").trim();
        jobs.push({ sha: null, parents: [headSha, mergeHead], subject: "merge in progress (working tree)" });
        report.range = "merge in progress: working tree vs HEAD and MERGE_HEAD";
    } else if (opts.merge_commit) {
        const sha = (git(top, ["rev-parse", "--verify", "-q", opts.merge_commit + "^{commit}"]) ?? "").trim();
        if (!sha) { report.notes.push(`Cannot resolve ${opts.merge_commit}.`); return report; }
        report.range = `merge commit ${short(sha)}`;
        jobs.push({ sha, parents: [], subject: "" });
    } else {
        const baseSha = opts.base ? (git(top, ["merge-base", "HEAD", opts.base]) ?? "").trim() || (git(top, ["rev-parse", "--verify", "-q", opts.base]) ?? "").trim() : defaultBase(top);
        const rangeArg = baseSha ? `${baseSha}..HEAD` : "HEAD";
        report.range = baseSha ? `merge commits in ${short(baseSha)}..HEAD${opts.base ? ` (base ${opts.base})` : ""}` : "recent merge commits on HEAD (no default branch found to bound the range)";
        const list = (git(top, ["rev-list", "--merges", `--max-count=${max}`, rangeArg]) ?? "").split(/\r?\n/).filter(Boolean);
        for (const sha of list) jobs.push({ sha, parents: [], subject: "" });
    }
    if (!jobs.length) {
        report.notes.push("No merge commit in the reviewed range, so there is no merge resolution to check. A branch that was rebased, squashed or fast-forwarded leaves no merge commit; this scan cannot see losses made that way.");
        return report;
    }

    for (const job of jobs) {
        const wt = job.sha === null;
        if (!wt) {
            const line = (git(top, ["rev-list", "--parents", "-n", "1", job.sha!]) ?? "").trim().split(/\s+/);
            job.parents = line.slice(1);
            job.subject = (git(top, ["log", "-1", "--format=%s", job.sha!]) ?? "").trim();
        }
        if (job.parents.length < 2) { report.notes.push(`${short(job.sha ?? "")} is not a merge commit; skipped.`); continue; }
        const baseRev = (git(top, ["merge-base", "--octopus", ...job.parents]) ?? "").trim() || null;
        const label = wt ? "working tree" : short(job.sha!);
        const parentLabels = job.parents.map((p, i) => `parent ${i + 1} (${short(p)})`);

        const show = (rev: string | null, file: string): string | null => {
            if (!rev) return null;
            const b = git(top, ["show", `${rev}:${file}`], true) as Buffer | null;
            return b && b.length <= MAX_BYTES && !b.subarray(0, 8000).includes(0) ? b.toString("utf-8") : null;
        };
        const showM = (file: string): string | null => {
            if (!wt) return show(job.sha!, file);
            try { const b = fs.readFileSync(path.join(top, file)); return b.length <= MAX_BYTES && !b.subarray(0, 8000).includes(0) ? b.toString("utf-8") : null; } catch { return null; }
        };

        const files = new Set<string>();
        for (const p of job.parents) {
            const out = git(top, wt ? ["diff", "--name-only", "--no-renames", p] : ["diff", "--name-only", "--no-renames", p, job.sha!]) ?? "";
            for (const f of out.split(/\r?\n/).filter(Boolean)) if (ANALYZABLE.test(f) && !SKIP.test(f)) files.add(f);
        }
        const list = [...files].sort();
        const truncated = list.length > MAX_FILES;
        const examined = list.slice(0, MAX_FILES);

        // symbols of every version of every file
        const tag = (s: Sym) => `${s.kind}\u0000${s.key}`;
        type FileSyms = { m: Map<string, Sym>; parents: Array<Map<string, Sym> | null>; base: Map<string, Sym> | null };
        const per = new Map<string, FileSyms>();
        const mAll = new Map<string, Set<string>>();
        const toMap = (file: string, text: string | null) => text === null ? null : new Map(extractSymbols(file, text).map((s) => [tag(s), s] as const));
        for (const file of examined) {
            const m = toMap(file, showM(file)) ?? new Map<string, Sym>();
            per.set(file, { m, parents: job.parents.map((p) => toMap(file, show(p, file))), base: toMap(file, show(baseRev, file)) });
            for (const k of m.keys()) { if (!mAll.has(k)) mAll.set(k, new Set()); mAll.get(k)!.add(file); }
        }

        const summary: MergeSummary = { sha: label, subject: job.subject, parents: parentLabels, base: baseRev ? short(baseRev) : null, files_examined: examined.length, findings: 0, moved_not_reported: 0, deletions_honoured: 0, truncated };
        const seen = new Set<string>();
        for (const [file, fs_] of per) {
            const fileText = showM(file);
            if (fileText !== null && /^<<<<<<< /m.test(fileText)) report.notes.push(`${file} still contains unresolved conflict markers in ${label}.`);
            for (let i = 0; i < job.parents.length; i++) {
                const pm = fs_.parents[i];
                if (!pm) continue;
                for (const [k, s] of pm) {
                    if (fs_.m.has(k) || seen.has(file + k)) continue;
                    const inBase = !!fs_.base?.has(k);
                    // a deliberate deletion by another parent that the merge honoured is git's three-way result, not a loss
                    const othersLackIt = job.parents.some((_, j) => j !== i && !(fs_.parents[j]?.has(k)));
                    if (inBase && othersLackIt) { summary.deletions_honoured++; seen.add(file + k); continue; }
                    // moved: the same method or endpoint newly appears in ANOTHER file of this merge (it was not there in any parent's version of that file)
                    if (MOVABLE.has(s.kind) && [...(mAll.get(k) ?? [])].some((f2) => f2 !== file && per.get(f2)!.parents.every((pm) => !pm?.has(k)))) {
                        summary.moved_not_reported++; seen.add(file + k); continue;
                    }
                    seen.add(file + k);
                    let kind = s.kind;
                    const display = s.display;
                    // same method name still present with another parameter list: the signature changed during the merge
                    if (kind === "METHOD" && [...fs_.m.values()].some((x) => x.kind === "METHOD" && x.key.split("/")[0] === s.key.split("/")[0])) kind = "PUBLIC_API_CHANGED";
                    const presentIn = job.parents.map((_, j) => (fs_.parents[j]?.has(k) ? parentLabels[j] : null)).filter(Boolean) as string[];
                    const sev = SEVERITY[kind];
                    const where = `${presentIn.join(" and ")}${inBase ? " (and in the merge base)" : " (added on that side; not in the merge base)"}`;
                    report.findings.push({
                        file, kind, severity: sev, display, present_in: presentIn, in_base: inBase, merge: label, merge_subject: job.subject,
                        observation: observation(kind, display, where), risk: RISK[sev],
                    });
                    summary.findings++;
                }
            }
        }
        report.merges.push(summary);
    }
    report.findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.display.localeCompare(b.display));
    for (const f of report.findings) report.counts[f.severity]++;
    report.notes.push("Detection is regex-based symbol extraction (Java, JS/TS, properties/YAML/.env, translation JSON, Markdown); other file types are not analyzed.");
    return report;
}

export function renderMergeReport(r: MergeReport, maxBlocks = 40): string {
    const head =
        `## MERGE REGRESSION REVIEW\n` +
        `Scope: ${r.range || "n/a"} · merges examined: ${r.merges.length} · possible regressions: HIGH ${r.counts.HIGH}, MEDIUM ${r.counts.MEDIUM}, LOW ${r.counts.LOW}\n` +
        `Nothing was changed. This scan DETECTS, REPORTS and EXPLAINS; the developer decides whether each difference is intentional. Do not delete, restore or modify code, and do not prefer a branch, on this evidence alone.\n` +
        r.merges.map((m) => `- merge ${m.sha}${m.subject ? ` "${m.subject}"` : ""}: parents ${m.parents.join(", ")}; base ${m.base ?? "none"}; files examined ${m.files_examined}${m.truncated ? " (truncated)" : ""}; ${m.findings} possible regression(s); ${m.deletions_honoured} deliberate deletion(s) honoured by the merge and ${m.moved_not_reported} move(s) not reported`).join("\n") + "\n" +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "");
    if (!r.findings.length) return head + "\nNo possible merge regressions found in the examined merges.\n";
    const blocks = r.findings.slice(0, maxBlocks).map((f) => [
        "MERGE REGRESSION REVIEW", "",
        `File: ${f.file}`, "",
        "Observation:", f.observation, "",
        "Classification:", "POSSIBLE MERGE REGRESSION", "",
        `Severity: ${f.severity}`, "",
        "Evidence:",
        ...f.present_in.map((p) => `- Present in ${p}`),
        f.in_base ? "- Present in the merge base" : "- Not in the merge base (added on that side)",
        "- Missing in merge result",
        `- First disappeared in merge commit ${f.merge}${f.merge_subject ? ` ("${f.merge_subject}")` : ""}`, "",
        "Risk:", f.risk, "",
        "Action:", "Developer review required.",
    ].join("\n"));
    const more = r.findings.length > maxBlocks ? `\n…and ${r.findings.length - maxBlocks} more (lower severity), not shown.\n` : "";
    return head + "\n" + blocks.join("\n\n---\n\n") + more;
}

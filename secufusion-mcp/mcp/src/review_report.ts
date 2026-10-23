import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { Finding } from "./review_findings.js";

/**
 * The shareable side of a review: a self-contained HTML report, suggested reviewers from git history,
 * and team metrics across stored runs.
 *
 * The HTML has no external assets (it works as a CI artifact or an email attachment), escapes every value,
 * supports light and dark, and works at phone width. Metrics are never keyed to a person: a run carries
 * repos, rules and verdicts, not authors.
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SEV = ["blocker", "major", "minor", "nit"] as const;

export interface ReviewResult {
    summary?: string;
    verdict?: string;
    verdictReason?: string;
    findings: Finding[];
    walkthrough?: Array<{ area: string; change: string; files?: string[] }>;
    testPlan?: string[];
    blastRadius?: Record<string, string[]>;
    delta?: { fixed: any[]; new: any[]; stillOpen: any[]; previousHeadSha?: string | null; previousVerdict?: string | null };
    trimmed?: Finding[];
    suppressed?: Array<Finding & { suppressedBy?: { reason?: string; expires?: string } }>;
    crossVerify?: { verifier?: string; model?: string; confirmed: number; downgraded: number; rejected: number; unverified: number };
    consensus?: { runs: number; seenOnce?: Finding[] };
    rejectedCount?: number;
    mode?: string;
    scope?: { repoKey?: string; base?: string; head?: string; headSha?: string; filesChanged?: number; linesChanged?: number; level?: string; suggestedReviewers?: Reviewer[]; missingRepos?: string[]; productFit?: string };
    ranAt?: string;
}
export interface Reviewer { name: string; why: string; files: string[] }

const VERDICT: Record<string, { label: string; cls: string }> = { ready: { label: "Ready", cls: "ok" }, fix_first: { label: "Fix first", cls: "bad" }, needs_discussion: { label: "Needs discussion", cls: "warn" } };

function card(f: Finding, repoKey?: string): string {
    const where = `${f.repo && f.repo !== repoKey ? f.repo + "/" : ""}${f.file}:${f.line}`;
    const ev = (f.evidence ?? []).map((e) => `<li><code>${esc(e.repo ? e.repo + "/" : "")}${esc(e.file)}${e.line ? ":" + e.line : ""}</code> — ${esc(e.note)}</li>`).join("");
    return `<details class="finding sev-${esc(f.severity)}"${f.severity === "blocker" || f.severity === "major" ? " open" : ""}>
<summary><span class="pill sev-${esc(f.severity)}">${esc(f.severity)}</span> <span class="pill ${f.confidence === "confirmed" ? "conf" : "poss"}">${esc(f.confidence)}</span> <span class="title">${esc(f.title)}</span> <code class="where">${esc(where)}</code></summary>
<dl>
${f.ratedSeverity ? `<dt>Severity</dt><dd>raised from ${esc(f.ratedSeverity)} by the ${esc(f.ruleId)} floor</dd>` : ""}
${f.consensus ? `<dt>Consensus</dt><dd>reported in ${esc(f.consensus)} runs</dd>` : ""}
<dt>Rule</dt><dd><code>${esc(f.ruleId)}</code>${f.category ? " · " + esc(f.category) : ""} · <code>${esc(f.anchor)}</code></dd>
<dt>Problem</dt><dd>${esc(f.problem)}</dd><dt>Fails when</dt><dd>${esc(f.failureScenario)}</dd><dt>Fix</dt><dd>${esc(f.suggestion)}</dd>
${ev ? `<dt>Evidence</dt><dd><ul>${ev}</ul></dd>` : ""}
${f.verification ? `<dt>Verified</dt><dd>${esc(f.verification)}</dd>` : ""}${f.crossVerification ? `<dt>Cross-check</dt><dd>${esc(f.crossVerification)}</dd>` : ""}
${f.id ? `<dt>ID</dt><dd><code>${esc(f.id)}</code></dd>` : ""}
</dl></details>`;
}

const THEME = `:root{--bg:#fbfbfa;--panel:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e4e4e7;--ok:#1a7f4b;--warn:#a15c00;--bad:#b42318;--blocker:#b42318;--major:#c2410c;--minor:#a16207;--nit:#52525b;--code:#f4f4f5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111113;--panel:#1a1a1d;--text:#ececef;--muted:#9d9da3;--line:#2c2c31;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--blocker:#f87171;--major:#fb923c;--minor:#facc15;--nit:#a1a1aa;--code:#232327}}
:root[data-theme="dark"]{--bg:#111113;--panel:#1a1a1d;--text:#ececef;--muted:#9d9da3;--line:#2c2c31;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--blocker:#f87171;--major:#fb923c;--minor:#facc15;--nit:#a1a1aa;--code:#232327}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}
.muted{color:var(--muted)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-all}
.head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.verdict{font-weight:600;padding:6px 14px;border-radius:999px;border:1.5px solid currentColor}.verdict.ok{color:var(--ok)}.verdict.warn{color:var(--warn)}.verdict.bad{color:var(--bad)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-top:16px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
.pill{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.sev-blocker{color:var(--blocker)}.sev-major{color:var(--major)}.sev-minor{color:var(--minor)}.sev-nit{color:var(--nit)}.conf{color:var(--ok)}.poss{color:var(--muted)}
details.finding{background:var(--panel);border:1px solid var(--line);border-left:4px solid currentColor;border-radius:8px;margin:10px 0;padding:10px 14px;color:var(--text)}
details.finding.sev-blocker{border-left-color:var(--blocker)}details.finding.sev-major{border-left-color:var(--major)}details.finding.sev-minor{border-left-color:var(--minor)}details.finding.sev-nit{border-left-color:var(--nit)}
summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:8px;align-items:center}summary .title{font-weight:600;flex:1 1 260px}summary .where{font-size:12px}
dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:12px 0 2px}dt{color:var(--muted);font-size:13px}dd{margin:0}dd ul{margin:0;padding-left:18px}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top;text-align:left}td:first-child{color:var(--muted);width:150px}th{color:var(--muted);font-weight:500}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}`;

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${THEME}</style></head><body><main>${body}</main></body></html>\n`;

export function renderHtmlReport(r: ReviewResult): string {
    const s = r.scope ?? {};
    const v = VERDICT[r.verdict ?? ""] ?? { label: r.verdict ?? "unknown", cls: "warn" };
    const blast = Object.entries(r.blastRadius ?? {}).filter(([, l]) => l?.length);
    const row = (a: string, b: string) => `<tr><td>${a}</td><td>${b}</td></tr>`;
    const body = `
<div class="head"><div><h1>${esc(s.repoKey ?? "Review")} review${r.mode ? ` <span class="muted">· ${esc(r.mode)}</span>` : ""}</h1>
<div class="muted">${s.base ? `<code>${esc(s.base)}</code> → <code>${esc(s.head ?? "working tree")}</code>` : ""}${s.headSha ? ` · ${esc(s.headSha.slice(0, 10))}` : ""}${s.filesChanged != null ? ` · ${esc(s.filesChanged)} files` : ""}${s.linesChanged != null ? ` · ${esc(s.linesChanged)} lines` : ""}</div></div>
<div class="verdict ${v.cls}">${esc(v.label)}</div></div>
<div class="panel" style="margin-top:16px"><p style="margin:0 0 8px">${esc(r.summary ?? "")}</p><p class="muted" style="margin:0"><b>Why this verdict:</b> ${esc(r.verdictReason ?? "")}</p></div>
<div class="stats">${SEV.map((sev) => `<div class="panel stat"><b class="sev-${sev}">${r.findings.filter((f) => f.severity === sev).length}</b><span>${sev}</span></div>`).join("")}${r.rejectedCount != null ? `<div class="panel stat"><b>${esc(r.rejectedCount)}</b><span>rejected by verify</span></div>` : ""}</div>
${r.walkthrough?.length ? `<h2>Walkthrough</h2><div class="panel"><table>${r.walkthrough.map((w) => row(esc(w.area), `${esc(w.change)}${w.files?.length ? `<div class="muted" style="margin-top:4px">${w.files.map((f) => `<code>${esc(f)}</code>`).join(" ")}</div>` : ""}`)).join("")}</table></div>` : ""}
${r.testPlan?.length ? `<h2>Suggested test plan</h2><div class="panel">${r.testPlan.map((t) => `<label style="display:block;margin:4px 0"><input type="checkbox"> ${esc(t)}</label>`).join("")}</div>` : ""}
<h2>Findings</h2>${r.findings.length ? r.findings.map((f) => card(f, s.repoKey)).join("") : '<p class="muted">No findings.</p>'}
${r.delta ? `<h2>Since the last review</h2><div class="panel"><table>
${row("Fixed", r.delta.fixed.length ? r.delta.fixed.map((f) => `<div><span class="pill conf">fixed</span> <code>${esc(f.ruleId)}</code> ${esc(f.title)}</div>`).join("") : "–")}
${row("New", r.delta.new.length ? r.delta.new.map((f) => `<div><span class="pill sev-${esc(f.severity)}">${esc(f.severity)}</span> <code>${esc(f.ruleId)}</code> ${esc(f.title)}</div>`).join("") : "–")}
${row("Still open", String(r.delta.stillOpen.length))}${r.delta.previousVerdict ? row("Previous", `<code>${esc((r.delta.previousHeadSha ?? "").slice(0, 10))}</code> · ${esc(r.delta.previousVerdict)}`) : ""}</table></div>` : ""}
${r.crossVerify ? `<h2>Cross-model check</h2><div class="panel">Re-checked by <b>${esc(r.crossVerify.verifier ?? "another model")}</b>${r.crossVerify.model ? ` (${esc(r.crossVerify.model)})` : ""}: ${r.crossVerify.confirmed} confirmed · ${r.crossVerify.downgraded} downgraded · ${r.crossVerify.rejected} rejected · ${r.crossVerify.unverified} unverified</div>` : ""}
${r.consensus?.seenOnce?.length ? `<details style="margin-top:8px"><summary class="muted">${r.consensus.seenOnce.length} finding(s) seen in only 1 of ${r.consensus.runs} runs (hidden by consensus)</summary>${r.consensus.seenOnce.map((f) => card(f, s.repoKey)).join("")}</details>` : ""}
${r.trimmed?.length ? `<details style="margin-top:8px"><summary class="muted">${r.trimmed.length} lower-priority finding(s) hidden by the noise cap</summary>${r.trimmed.map((f) => card(f, s.repoKey)).join("")}</details>` : ""}
${blast.length ? `<h2>Blast radius</h2><div class="panel"><table>${blast.map(([k, l]) => row(esc(k), l.map((x) => `<code>${esc(x)}</code>`).join(" "))).join("")}</table></div>` : ""}
${r.suppressed?.length ? `<h2>Suppressed (${r.suppressed.length})</h2>${r.suppressed.map((f) => `<div class="panel" style="margin:8px 0"><code>${esc(f.ruleId)}</code> ${esc(f.title)} — <code>${esc(f.file)}:${esc(f.line)}</code><div class="muted">${esc(f.suppressedBy?.reason)} (until ${esc(f.suppressedBy?.expires)})</div></div>`).join("")}` : ""}
<h2>Run</h2><div class="panel"><table>
${s.suggestedReviewers?.length ? row("Suggested reviewers", s.suggestedReviewers.map((x) => `<div><b>${esc(x.name)}</b> <span class="muted">— ${esc(x.why)}</span></div>`).join("")) : ""}
${s.missingRepos?.length ? row("Not checked", `${esc(s.missingRepos.join(", "))} — cross-repository checks for these were not possible`) : ""}
${s.productFit ? row("Product fit", esc(s.productFit)) : ""}
${row("Level", esc(s.level ?? "–"))}</table></div>`;
    return shell(`Review — ${s.repoKey ?? ""}`, body);
}

// ---- reviewers ----------------------------------------------------------------------------------

const BOT = /\b(bot|build service|azure pipelines|project collection|dependabot|renovate|github-actions)\b/i;

/**
 * Who knows the code this change touches: authors of the lines it rewrites (weight 2 per line) and of
 * recent commits to the changed files (weight 1 per commit). The change's own authors and bots are
 * excluded. Names only, never email addresses.
 */
export function scoreReviewers(o: { blames: Array<{ file: string; authors: string[] }>; recent: Array<{ file: string; authors: string[] }>; exclude?: string[]; max?: number }): Reviewer[] {
    const skip = new Set((o.exclude ?? []).map((n) => n.trim().toLowerCase()));
    const score = new Map<string, { name: string; score: number; files: Set<string>; lines: number; commits: number }>();
    const bump = (name: string, file: string, w: number, kind: "line" | "commit") => {
        if (!name || BOT.test(name) || skip.has(name.trim().toLowerCase())) return;
        const s = score.get(name) ?? { name, score: 0, files: new Set<string>(), lines: 0, commits: 0 };
        s.score += w; s.files.add(file); if (kind === "line") s.lines++; else s.commits++;
        score.set(name, s);
    };
    for (const b of o.blames) for (const a of b.authors) bump(a, b.file, 2, "line");
    for (const r of o.recent) for (const a of r.authors) bump(a, r.file, 1, "commit");
    return [...score.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, o.max ?? 3).map((s) => ({
        name: s.name,
        why: [s.lines ? `wrote ${s.lines} of the lines this change rewrites` : "", s.commits ? `${s.commits} recent commit(s) to these files` : ""].filter(Boolean).join("; "),
        files: [...s.files].slice(0, 5),
    }));
}

const git = (root: string, args: string[]): string => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

export function suggestReviewers(root: string, base: string, o: { max?: number; sinceDays?: number; maxFiles?: number } = {}): Reviewer[] {
    if (!/^[\w./~^@{}-]+$/.test(base)) throw new Error(`refusing base ref "${base}"`);
    const files = git(root, ["diff", "--name-only", "--diff-filter=MR", base]).split("\n").filter(Boolean).slice(0, o.maxFiles ?? 40);
    const me = git(root, ["config", "user.name"]).trim();
    const ownAuthors = new Set(git(root, ["log", "--format=%an", `${base}..HEAD`]).split("\n").filter(Boolean));
    if (me) ownAuthors.add(me);
    const blames: Array<{ file: string; authors: string[] }> = [];
    const recent: Array<{ file: string; authors: string[] }> = [];
    for (const f of files) {
        const ranges: Array<[number, number]> = [];
        for (const l of git(root, ["diff", "-U0", "--no-color", base, "--", f]).split("\n")) {
            const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
            if (h) { const n = h[2] === undefined ? 1 : Number(h[2]); if (n > 0) ranges.push([Number(h[1]), Number(h[1]) + n - 1]); }
        }
        const authors: string[] = [];
        for (const [a, b] of ranges.slice(0, 20)) for (const l of git(root, ["blame", "-L", `${a},${b}`, "--line-porcelain", base, "--", f]).split("\n")) if (l.startsWith("author ")) authors.push(l.slice(7));
        blames.push({ file: f, authors });
        recent.push({ file: f, authors: git(root, ["log", `--since=${o.sinceDays ?? 180}.days.ago`, "--format=%an", "-n", "10", base, "--", f]).split("\n").filter(Boolean) });
    }
    return scoreReviewers({ blames, recent, exclude: [...ownAuthors], max: o.max });
}

// ---- metrics ------------------------------------------------------------------------------------

export function isoWeek(dateStr: string): string {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "unknown";
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}

const runsDir = (root: string) => path.join(root, ".secufusion", "review-runs");

/** Stores a finished review so metrics and the next re-review delta can use it. Returns the path. */
export function recordRun(root: string, r: ReviewResult): string {
    const at = r.ranAt ?? new Date().toISOString();
    const dir = runsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${at.replace(/[:.]/g, "-")}_${(r.scope?.repoKey ?? "repo").replace(/[^\w.-]/g, "_")}.json`);
    fs.writeFileSync(p, JSON.stringify({ ...r, ranAt: at }, null, 1));
    return p;
}

export function loadRuns(root: string): Array<{ at: string; result: ReviewResult }> {
    const dir = runsDir(root);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
    const out: Array<{ at: string; result: ReviewResult }> = [];
    for (const n of names) { try { const result = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); out.push({ at: result.ranAt ?? n.slice(0, 24), result }); } catch { /* skip a damaged file */ } }
    return out;
}

/** The most recent stored run for a repo, to feed the delta of the next review. */
export function latestRun(root: string, repoKey?: string): ReviewResult | undefined {
    const runs = loadRuns(root).filter((r) => !repoKey || r.result.scope?.repoKey === repoKey);
    return runs.length ? runs[runs.length - 1].result : undefined;
}

export function aggregate(runs: Array<{ at: string; result: ReviewResult }>) {
    const weeks = new Map<string, any>(), rules = new Map<string, any>(), repos = new Map<string, any>(), categories = new Map<string, number>(), modes = new Map<string, number>();
    const verdicts: Record<string, number> = { ready: 0, fix_first: 0, needs_discussion: 0 };
    let findings = 0, rejected = 0, candidates = 0, suppressed = 0, fixed = 0;
    for (const { at, result: r } of runs) {
        const wk = isoWeek(at);
        const w = weeks.get(wk) ?? { week: wk, reviews: 0, blocker: 0, major: 0, minor: 0, nit: 0 };
        w.reviews++;
        for (const f of r.findings ?? []) {
            w[f.severity] = (w[f.severity] ?? 0) + 1;
            const rule = rules.get(f.ruleId) ?? { ruleId: f.ruleId, count: 0, blocker: 0, repos: new Set<string>() };
            rule.count++; if (f.severity === "blocker") rule.blocker++;
            rule.repos.add(f.repo ?? r.scope?.repoKey ?? "unknown");
            rules.set(f.ruleId, rule);
            if (f.category) categories.set(f.category, (categories.get(f.category) ?? 0) + 1);
        }
        weeks.set(wk, w);
        const repo = r.scope?.repoKey ?? "unknown";
        const rp = repos.get(repo) ?? { repo, reviews: 0, findings: 0, fixFirst: 0 };
        rp.reviews++; rp.findings += r.findings?.length ?? 0; if (r.verdict === "fix_first") rp.fixFirst++;
        repos.set(repo, rp);
        if (r.verdict && r.verdict in verdicts) verdicts[r.verdict]++;
        if (r.mode) modes.set(r.mode, (modes.get(r.mode) ?? 0) + 1);
        findings += r.findings?.length ?? 0; rejected += r.rejectedCount ?? 0; candidates += (r.findings?.length ?? 0) + (r.rejectedCount ?? 0);
        suppressed += r.suppressed?.length ?? 0; fixed += r.delta?.fixed?.length ?? 0;
    }
    const reviews = runs.length;
    return {
        generatedAt: new Date().toISOString(), reviews, findings,
        findingsPerReview: reviews ? +(findings / reviews).toFixed(2) : 0,
        verifyRejectRate: candidates ? +(rejected / candidates).toFixed(3) : 0,
        suppressed, fixedOnRereview: fixed, verdicts,
        weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
        topRules: [...rules.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId)).slice(0, 12).map((x) => ({ ...x, repos: [...x.repos].sort() })),
        repos: [...repos.values()].sort((a, b) => b.findings - a.findings),
        categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
        modes: Object.fromEntries(modes),
    };
}

export type Metrics = ReturnType<typeof aggregate>;

export function renderMetrics(m: Metrics): string {
    const o = [`# Review metrics: ${m.reviews} review(s), ${m.findings} finding(s) (${m.findingsPerReview}/review) — not attributed to people`, "",
        `Verdicts: ${m.verdicts.ready} ready · ${m.verdicts.fix_first} fix first · ${m.verdicts.needs_discussion} needs discussion`,
        `Rejected by verification: ${Math.round(m.verifyRejectRate * 100)}% of candidates · fixed on re-review: ${m.fixedOnRereview} · suppressed: ${m.suppressed}`, "", "Top rules:"];
    for (const r of m.topRules) o.push(`  ${r.ruleId.padEnd(9)} ${String(r.count).padStart(3)}  (${r.blocker} blocker)  ${r.repos.join(", ")}`);
    o.push("", "By week:", ...m.weeks.map((w: any) => `  ${w.week}  ${w.reviews} review(s): ${SEV.map((s) => `${w[s] ?? 0} ${s}`).join(" · ")}`));
    return o.join("\n");
}

export function renderMetricsHtml(m: Metrics, title = "Review metrics"): string {
    const tile = (v: unknown, label: string) => `<div class="panel stat"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
    const body = `<h1>${esc(title)}</h1><div class="muted">${m.reviews} reviews · generated ${esc(m.generatedAt.slice(0, 10))} · not attributed to people</div>
<div class="stats">${tile(m.reviews, "reviews")}${tile(m.findingsPerReview, "findings / review")}${tile(m.verdicts.fix_first, "fix-first verdicts")}${tile(Math.round(m.verifyRejectRate * 100) + "%", "rejected by verify")}${tile(m.fixedOnRereview, "fixed on re-review")}${tile(m.suppressed, "suppressed")}</div>
<h2>Findings per week, by severity</h2><div class="panel"><table><tr><th>Week</th><th class="n">Reviews</th>${SEV.map((s) => `<th class="n">${s}</th>`).join("")}</tr>${m.weeks.map((w: any) => `<tr><td>${esc(w.week)}</td><td class="n">${w.reviews}</td>${SEV.map((s) => `<td class="n">${w[s] ?? 0}</td>`).join("")}</tr>`).join("")}</table></div>
<h2>Most frequent rules</h2><div class="panel"><table><tr><th>Rule</th><th class="n">Findings</th><th class="n">Blockers</th><th>Repos</th></tr>${m.topRules.map((r: any) => `<tr><td>${esc(r.ruleId)}</td><td class="n">${r.count}</td><td class="n">${r.blocker}</td><td>${esc(r.repos.join(", "))}</td></tr>`).join("")}</table></div>
<h2>By repo</h2><div class="panel"><table><tr><th>Repo</th><th class="n">Reviews</th><th class="n">Findings</th><th class="n">Fix-first</th></tr>${m.repos.map((r: any) => `<tr><td>${esc(r.repo)}</td><td class="n">${r.reviews}</td><td class="n">${r.findings}</td><td class="n">${r.fixFirst}</td></tr>`).join("")}</table></div>
<h2>By category</h2><div class="panel"><table><tr><th>Category</th><th class="n">Findings</th></tr>${Object.entries(m.categories).map(([c, n]) => `<tr><td>${esc(c)}</td><td class="n">${n}</td></tr>`).join("")}</table></div>`;
    return shell(title, body);
}

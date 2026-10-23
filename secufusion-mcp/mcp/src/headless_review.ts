import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { Engine } from "./engine.js";
import { runQuickCheck, defaultBase, QuickResult } from "./quick_check.js";
import { loadCatalog, repoNotes } from "./rule_catalog.js";
import { validateEvidence } from "./finding_evidence.js";
import { Finding, DEFAULT_SEVERITY_FLOORS, applyDecisions, applySeverityFloors, applySuppressions, assignIds, computeDelta, decideVerdict, sortFindings, trimNoise } from "./review_findings.js";
import { ReviewResult, latestRun, recordRun } from "./review_report.js";

/**
 * Headless review: the same pipeline as /sfn-review's findings stage, for CI, a pre-push hook or the command
 * line, where no editor model exists.
 *
 *   quick check (no model) -> the engine reviews the diff against the rule catalog -> every citation is
 *   checked against the real files (an unsupported finding is dropped) -> an optional verifier (a DIFFERENT
 *   provider if configured) tries to refute each finding -> floors, suppressions, noise cap, verdict, delta.
 *
 * It is less than the interactive review: it has no product conversation, no Context Sufficiency questions
 * and no tool investigation. It says so in the result (`mode`), and it fails CLOSED: if the engine's answer
 * cannot be parsed there is no "ready" verdict, there is an error.
 */
const git = (root: string, args: string[]): string => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

export function extractJson(text: string): any {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const s = body.indexOf("{"), e = body.lastIndexOf("}");
    if (s === -1 || e <= s) throw new Error("no JSON object in the engine's answer");
    return JSON.parse(body.slice(s, e + 1));
}

const SEV = new Set(["blocker", "major", "minor", "nit"]);
/** Keeps only well-formed findings; returns how many were dropped as malformed. */
export function normalizeFindings(raw: any[]): { findings: Finding[]; malformed: number } {
    const findings: Finding[] = [];
    let malformed = 0;
    for (const f of raw ?? []) {
        if (!f || typeof f.file !== "string" || !SEV.has(f.severity) || typeof f.title !== "string" || typeof f.ruleId !== "string") { malformed++; continue; }
        findings.push({
            ruleId: f.ruleId, severity: f.severity, confidence: f.confidence === "confirmed" ? "confirmed" : "possible", category: f.category, file: f.file, line: Number.isFinite(f.line) ? f.line : 1,
            anchor: String(f.anchor ?? `${f.file}#${f.ruleId}`), title: f.title, problem: String(f.problem ?? ""), failureScenario: String(f.failureScenario ?? ""), suggestion: String(f.suggestion ?? ""),
            evidence: Array.isArray(f.evidence) ? f.evidence : undefined, specialist: "engine", quote: typeof f.quote === "string" ? f.quote : undefined,
        } as Finding);
    }
    return { findings, malformed };
}

const SYSTEM = `You are the SecuFusion code reviewer. You review a change for defects that matter in production, against the rules you are given and against what the product must always keep true (tenant isolation, authorization, data integrity, contracts between services, safe deployment).
Rules of evidence: report a finding only if you can point at the exact line and quote the code. Use confidence "confirmed" ONLY when the defect is visible in the code shown; if you are inferring it, use "possible". Never invent a rule id: use one from the catalog, or GEN. Prefer a few real findings over many speculative ones. Say what breaks and when (failureScenario), not just that something looks wrong.
Respond with ONE JSON object and nothing else:
{"summary":"2-3 sentences","findings":[{"ruleId":"SEC-003","severity":"blocker|major|minor|nit","confidence":"confirmed|possible","category":"security|db|contracts|runtime|tests|deps|webui","file":"path","line":12,"quote":"code copied from that line","anchor":"Class#method or table.column (stable, no line numbers)","title":"short","problem":"what is wrong","failureScenario":"who does what and what breaks","suggestion":"the fix"}],"walkthrough":[{"area":"...","change":"...","files":["..."]}],"testPlan":["..."]}`;

export interface HeadlessOptions {
    base?: string; repoKey?: string; level?: "quick" | "standard" | "deep";
    engine: Engine; verifyEngine?: Engine; maxDiffChars?: number; failClosed?: boolean;
}

export async function headlessReview(root: string, o: HeadlessOptions): Promise<ReviewResult & { error?: string; qc: QuickResult }> {
    const repoKey = o.repoKey ?? path.basename(path.resolve(root));
    const base = o.base ?? defaultBase(root);
    const qc = runQuickCheck(root, { base, repoKey });
    const diff = git(root, ["diff", "--no-color", "-U8", ...(base ? [base] : ["HEAD"])]).slice(0, o.maxDiffChars ?? 120_000);
    const files = qc.files_changed;
    const web = qc.stack === "react-vite";
    const cat = loadCatalog(root).rules.filter((r) => (web ? r.area !== "database" : r.area !== "web-ui"));
    const notes = repoNotes(repoKey, root).map((n) => n.text).join("\n\n");
    const user = `Repository: ${repoKey} (${qc.stack}); ${files} file(s) changed against ${base ?? "HEAD"}.\n\n## Rule catalog\n${cat.map((r) => `${r.id} [${r.severity}] ${r.text}`).join("\n")}\n\n${notes ? `## Repository notes\n${notes}\n\n` : ""}## Mechanical leads the quick check already found (confirm or ignore; do not repeat them verbatim)\n${qc.findings.map((f) => `${f.ruleId} ${f.file}:${f.line} ${f.title}`).join("\n") || "none"}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``;

    let parsed: any;
    try { parsed = extractJson(await o.engine.complete({ system: SYSTEM, user, maxTokens: 8000 })); }
    catch (e: any) {
        return { findings: qc.findings, verdict: "needs_discussion", verdictReason: `The engine's answer could not be used (${e?.message ?? e}). Only the mechanical quick check ran.`, error: String(e?.message ?? e), mode: "Headless review (failed)", scope: { repoKey, base: base ?? undefined }, qc, ranAt: new Date().toISOString() };
    }
    const { findings: modelFindings, malformed } = normalizeFindings(parsed.findings);

    // 1. Every citation is checked against the real files; an unsupported finding is dropped, an unquoted one is only possible.
    const ev = validateEvidence(root, modelFindings.map((f, i) => ({ id: String(i), file: f.file, line: f.line, quote: (f as any).quote })));
    const act = new Map(ev.results.map((r) => [Number(r.id), r]));
    let dropped = malformed;
    let candidates: Finding[] = [];
    modelFindings.forEach((f, i) => {
        const r = act.get(i);
        if (!r || r.action === "DROP") { dropped++; return; }
        const fixed = { ...f, ...(r.actual_line ? { line: r.actual_line } : {}) };
        candidates.push(r.action === "KEEP" ? fixed : { ...fixed, confidence: "possible" });
    });
    // The quick check's exact findings join the engine's, unless the engine reported the same issue.
    const dup = (q: Finding) => candidates.some((f) => f.ruleId === q.ruleId && f.file === q.file && Math.abs(f.line - q.line) <= 15);
    candidates = [...candidates, ...qc.findings.filter((q) => !dup(q))];

    // 2. Adversarial verification (cross-model when a verify engine is configured). Quick-check findings are exact and skip it.
    let rejectedCount = dropped;
    let crossVerify: ReviewResult["crossVerify"];
    const toVerify = candidates.filter((f) => f.specialist === "engine");
    if (o.level !== "quick" && toVerify.length) {
        const verifier = o.verifyEngine ?? o.engine;
        const cross = !!o.verifyEngine;
        const numbered = toVerify.slice(0, 40).map((f, n) => ({ n, ...f, quote: undefined }));
        try {
            const out = extractJson(await verifier.complete({
                system: `You are an adversarial verifier. Try to REFUTE each finding: find the guard, test, caller or constraint that makes it wrong. Respond with ONE JSON object: {"decisions":[{"n":0,"decision":"confirm|downgrade|reject","severity":"(when downgrading)","confidence":"confirmed|possible","verification":"what you checked"}]}. ${cross ? "You may lower a severity, never raise one." : ""} If you cannot decide from the code shown, confirm with confidence "possible".`,
                user: JSON.stringify(numbered.map((f) => ({ ...f, code: codeAround(root, f.file, f.line) })), null, 1), maxTokens: 4000,
            }));
            const r = applyDecisions(toVerify.slice(0, 40), out.decisions ?? [], cross ? "cross" : "same");
            const rest = toVerify.slice(40);
            candidates = [...candidates.filter((f) => f.specialist !== "engine"), ...r.kept, ...rest];
            rejectedCount += r.rejected.length;
            crossVerify = { verifier: verifier.provider, model: verifier.model, ...r.stats };
        } catch (e: any) {
            candidates = candidates.map((f) => (f.specialist === "engine" ? { ...f, confidence: "possible" as const, verification: "not verified (verifier failed)" } : f));
        }
    }

    // 3. Deterministic finishing.
    const withIds = applySeverityFloors(assignIds(candidates, repoKey), DEFAULT_SEVERITY_FLOORS);
    let supp: any[] = [];
    try { supp = JSON.parse(fs.readFileSync(path.join(root, ".secufusion", "suppressions.json"), "utf8")).suppressions ?? []; } catch { /* none */ }
    const { kept, suppressed } = applySuppressions(withIds, supp.filter((s) => s.expires));
    const { kept: shown, trimmed } = trimNoise(sortFindings(kept), {}, o.level);
    const v = decideVerdict(shown, { dropped: 0 });
    const result: ReviewResult & { qc: QuickResult } = {
        summary: parsed.summary, verdict: v.verdict, verdictReason: v.reason, findings: shown, trimmed, suppressed, walkthrough: parsed.walkthrough, testPlan: parsed.testPlan,
        rejectedCount, crossVerify, mode: "Headless review (no product conversation)", ranAt: new Date().toISOString(),
        scope: { repoKey, base: base ?? undefined, filesChanged: files, level: o.level ?? "standard" }, qc,
    };
    const delta = computeDelta(latestRun(root, repoKey) as any, shown, repoKey);
    if (delta) result.delta = delta as any;
    return result;
}

function codeAround(root: string, file: string, line: number, radius = 8): string {
    try {
        const abs = path.resolve(root, file);
        if (!abs.startsWith(path.resolve(root))) return "";
        const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
        const a = Math.max(0, line - 1 - radius), b = Math.min(lines.length, line + radius);
        return lines.slice(a, b).map((l, i) => `${a + i + 1}: ${l}`).join("\n");
    } catch { return ""; }
}

export { recordRun };

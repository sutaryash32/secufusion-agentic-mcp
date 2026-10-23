/**
 * Finding evidence validator: a review finding must point at something that is really there.
 *
 * A model can cite `UserService.java:88` with a confident quote that does not exist. This module checks every
 * citation mechanically, in any language, before a finding reaches the report:
 *   - the file exists and is inside the workspace (no path escapes, no symlink escapes);
 *   - the line is inside the file;
 *   - the quoted text (whitespace-insensitive) is on that line, near it, or elsewhere in the file (the line is corrected).
 * It can also weigh a "proof by test": a finding that comes with a test which was run against the change.
 *   head_result FAIL  -> PROVEN       (the suspicion is demonstrated by an executable test)
 *   head_result PASS  -> REFUTED      (the test says the suspicion is wrong: downgrade or drop it)
 *   NOT_RUN / absent  -> INCONCLUSIVE
 * It never edits anything and never runs anything: running the test is the caller's job.
 */
import fs from "fs";
import path from "path";

export interface ProofIn {
    test_file?: string;
    test_name?: string;
    head_result?: "FAIL" | "PASS" | "NOT_RUN";
    base_result?: "FAIL" | "PASS" | "NOT_RUN";
}
export interface FindingIn {
    id?: string;
    file: string;
    line?: number;
    quote?: string;
    severity?: string;
    proof?: ProofIn;
}
export type EvidenceStatus =
    | "VERIFIED" | "VERIFIED_NEAR" | "QUOTE_AT_OTHER_LINE" | "LINE_OK_UNQUOTED"
    | "QUOTE_NOT_FOUND" | "LINE_OUT_OF_RANGE" | "FILE_MISSING" | "PATH_OUTSIDE_ROOT" | "UNREADABLE";
export type ProofStatus = "PROVEN" | "REFUTED" | "INCONCLUSIVE" | "NO_PROOF" | "PROOF_TEST_MISSING";
export type Action = "KEEP" | "KEEP_AS_POSSIBLE" | "DOWNGRADE" | "DROP";

export interface EvidenceResult {
    id: string;
    file: string;
    line?: number;
    status: EvidenceStatus;
    actual_line?: number;
    proof: ProofStatus;
    action: Action;
    reason: string;
}
export interface EvidenceReport {
    root: string;
    results: EvidenceResult[];
    kept: number;
    dropped: number;
    downgraded: number;
    possible: number;
}

const MAX_BYTES = 2_000_000;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Resolves a (possibly relative) path inside root; returns null when it escapes the root, even through a symlink. */
export function confine(root: string, file: string): string | null {
    const rootReal = fs.realpathSync(root);
    const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(rootReal, file);
    const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep);
    if (!inside(abs)) return null;
    if (!fs.existsSync(abs)) return abs; // missing, but lexically inside: caller reports FILE_MISSING
    const real = fs.realpathSync(abs);
    return inside(real) ? real : null;
}

function readLines(abs: string): string[] | null {
    try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_BYTES) return null;
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) return null;
        return buf.toString("utf8").split(/\r?\n/);
    } catch {
        return null;
    }
}

function checkProof(root: string, p: ProofIn | undefined): { status: ProofStatus; note: string } {
    if (!p) return { status: "NO_PROOF", note: "" };
    if (p.test_file) {
        const abs = confine(root, p.test_file);
        if (!abs || !fs.existsSync(abs)) return { status: "PROOF_TEST_MISSING", note: `proof test file ${p.test_file} does not exist` };
        if (p.test_name) {
            const lines = readLines(abs);
            if (!lines || !lines.join("\n").includes(p.test_name)) {
                return { status: "PROOF_TEST_MISSING", note: `test ${p.test_name} is not in ${p.test_file}` };
            }
        }
    }
    if (p.head_result === "FAIL") return { status: "PROVEN", note: "the proof test fails on the change" };
    if (p.head_result === "PASS") return { status: "REFUTED", note: "the proof test passes on the change: the suspicion is not demonstrated" };
    return { status: "INCONCLUSIVE", note: "the proof test was not run" };
}

export function validateEvidence(root: string, findings: FindingIn[], opts: { window?: number } = {}): EvidenceReport {
    const window = Math.max(0, Math.min(opts.window ?? 3, 25));
    const results: EvidenceResult[] = [];
    findings.forEach((f, i) => {
        const id = f.id ?? `#${i + 1}`;
        const base = { id, file: f.file, line: f.line };
        const proof = checkProof(root, f.proof);
        const finish = (status: EvidenceStatus, reason: string, actual_line?: number): void => {
            let action: Action;
            if (status === "QUOTE_NOT_FOUND" || status === "LINE_OUT_OF_RANGE" || status === "FILE_MISSING" || status === "PATH_OUTSIDE_ROOT" || status === "UNREADABLE") action = "DROP";
            else if (status === "LINE_OK_UNQUOTED") action = "KEEP_AS_POSSIBLE";
            else action = "KEEP";
            // a refuted proof overrides a clean citation: the code is there, but the claim about it is not demonstrated
            if (proof.status === "REFUTED" && action !== "DROP") action = "DOWNGRADE";
            if (proof.status === "PROOF_TEST_MISSING" && action === "KEEP") action = "KEEP_AS_POSSIBLE";
            results.push({ ...base, status, actual_line, proof: proof.status, action, reason: [reason, proof.note].filter(Boolean).join("; ") });
        };

        const abs = confine(root, f.file);
        if (!abs) return finish("PATH_OUTSIDE_ROOT", "path resolves outside the workspace root");
        if (!fs.existsSync(abs)) return finish("FILE_MISSING", "file does not exist");
        const lines = readLines(abs);
        if (!lines) return finish("UNREADABLE", "file is binary, a directory or larger than the limit");

        if (f.line !== undefined && (f.line < 1 || f.line > lines.length)) {
            return finish("LINE_OUT_OF_RANGE", `line ${f.line} is outside the file (${lines.length} lines)`);
        }
        const quote = f.quote ? norm(f.quote) : "";
        if (!quote) return finish("LINE_OK_UNQUOTED", "no quote supplied: the line exists but the claim cannot be matched to the code");

        const at = (n: number) => norm(lines[n - 1] ?? "");
        if (f.line !== undefined && at(f.line).includes(quote)) return finish("VERIFIED", "quote found on the cited line", f.line);
        if (f.line !== undefined) {
            const lo = Math.max(1, f.line - window), hi = Math.min(lines.length, f.line + window);
            const slice = norm(lines.slice(lo - 1, hi).join(" "));
            if (slice.includes(quote)) {
                for (let n = lo; n <= hi; n++) if (at(n).includes(quote)) return finish("VERIFIED_NEAR", `quote found at line ${n}, near the cited line`, n);
                return finish("VERIFIED_NEAR", `quote spans lines near ${f.line}`, f.line);
            }
        }
        const whole = norm(lines.join(" "));
        if (whole.includes(quote)) {
            let hit: number | undefined;
            for (let n = 1; n <= lines.length; n++) if (at(n).includes(quote)) { hit = n; break; }
            return finish("QUOTE_AT_OTHER_LINE", `quote exists in the file${hit ? ` at line ${hit}` : ""}, not at the cited line: correct the line`, hit);
        }
        return finish("QUOTE_NOT_FOUND", "the quoted code is not in the file: the citation is not supported");
    });
    return {
        root,
        results,
        kept: results.filter((r) => r.action === "KEEP").length,
        possible: results.filter((r) => r.action === "KEEP_AS_POSSIBLE").length,
        downgraded: results.filter((r) => r.action === "DOWNGRADE").length,
        dropped: results.filter((r) => r.action === "DROP").length,
    };
}

export function renderEvidence(r: EvidenceReport): string {
    const out = [`# Finding evidence check: ${r.results.length} finding(s)`, `KEEP ${r.kept} · KEEP AS POSSIBLE ${r.possible} · DOWNGRADE ${r.downgraded} · DROP ${r.dropped}`, ""];
    for (const x of r.results) {
        out.push(`${x.action.padEnd(16)} ${x.id}  ${x.file}${x.line ? ":" + x.line : ""}  [${x.status}${x.actual_line && x.actual_line !== x.line ? ` → line ${x.actual_line}` : ""}] proof=${x.proof}`);
        out.push(`  ${x.reason}`);
    }
    out.push("", "DROP means the citation is not supported by the code: remove the finding (or re-investigate it) before the report. DOWNGRADE means a proof test passed on the change.");
    return out.join("\n");
}

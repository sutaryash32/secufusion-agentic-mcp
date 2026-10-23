import crypto from "crypto";

/**
 * Review findings core: identity, severity floors, noise cap, verdict, CI gate, re-review delta,
 * multi-run consensus, adversarial verification decisions and SARIF export.
 *
 * Everything here is pure and language-neutral. The model produces findings; this module makes the
 * parts around them deterministic, so the same findings always give the same verdict, the same gate
 * result and the same ids (which is what makes "fixed since the last review" possible).
 */
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Confidence = "confirmed" | "possible";

export interface Finding {
    id?: string;
    repo?: string;
    ruleId: string;
    severity: Severity;
    confidence: Confidence;
    category?: string;
    specialist?: string;
    file: string;
    line: number;
    endLine?: number;
    anchor: string;
    title: string;
    problem: string;
    failureScenario: string;
    suggestion: string;
    evidence?: Array<{ repo?: string; file: string; line?: number; note: string }>;
    ratedSeverity?: Severity;
    verification?: string;
    crossVerification?: string;
    consensus?: string;
    [k: string]: unknown;
}

export const SEVERITY_RANK: Record<string, number> = { nit: 1, minor: 2, major: 3, blocker: 4 };

/** Stable across runs: built from what the finding is about, never from line numbers or wording. */
export function findingId(f: Pick<Finding, "repo" | "file" | "anchor" | "ruleId">, defaultRepo = ""): string {
    return crypto.createHash("sha1").update([f.repo ?? defaultRepo, f.file, f.anchor, f.ruleId].join("|")).digest("hex").slice(0, 12);
}

export function assignIds(findings: Finding[], defaultRepo = ""): Finding[] {
    return findings.map((f) => ({ ...f, repo: f.repo ?? defaultRepo, id: findingId(f, defaultRepo) }));
}

export interface Suppression { id?: string; ruleId?: string; repo?: string; anchor?: string; path?: string; reason?: string; owner?: string; expires?: string }

const globToRegExp = (g: string): RegExp =>
    new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");

/** An expired suppression no longer applies; it is returned so someone renews or deletes it. */
export function applySuppressions(findings: Finding[], suppressions: Suppression[], today = new Date().toISOString().slice(0, 10)) {
    const active: Suppression[] = [];
    const expired: Suppression[] = [];
    for (const s of suppressions) (s.expires && s.expires < today ? expired : active).push(s);
    const kept: Finding[] = [];
    const suppressed: Array<Finding & { suppressedBy: Partial<Suppression> }> = [];
    for (const f of findings) {
        const hit = active.find((s) => {
            if (s.id) return s.id === f.id;
            if (s.ruleId && s.ruleId !== f.ruleId) return false;
            if (s.repo && s.repo !== f.repo) return false;
            if (s.anchor && s.anchor !== f.anchor) return false;
            if (s.path && !globToRegExp(s.path).test(f.file)) return false;
            return Boolean(s.ruleId || s.path);
        });
        if (hit) suppressed.push({ ...f, suppressedBy: { reason: hit.reason, expires: hit.expires, owner: hit.owner } });
        else kept.push(f);
    }
    return { kept, suppressed, expired };
}

/** Raises findings of critical rules to their floor; remembers what the model originally said. */
export function applySeverityFloors(findings: Finding[], floors: Record<string, Severity>): Finding[] {
    return findings.map((f) => {
        const floor = floors[f.ruleId];
        // Only a CONFIRMED finding is lifted: a possible one stays possible, the floor never invents evidence.
        if (!floor || f.confidence !== "confirmed" || SEVERITY_RANK[f.severity] >= SEVERITY_RANK[floor]) return f;
        return { ...f, severity: floor, ratedSeverity: f.severity };
    });
}

export function sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort(
        (a, b) =>
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            (a.confidence === b.confidence ? 0 : a.confidence === "confirmed" ? -1 : 1) ||
            a.file.localeCompare(b.file) ||
            a.line - b.line,
    );
}

/** Noise cap: every blocker and major stays; the best few minors and nits stay. Input must be sorted. */
export function trimNoise(sorted: Finding[], o: { maxMinor?: number; maxNit?: number; nitsAtQuick?: boolean } = {}, level?: string) {
    const { maxMinor = 5, maxNit = 3, nitsAtQuick = false } = o;
    const kept: Finding[] = [];
    const trimmed: Finding[] = [];
    let minors = 0;
    let nits = 0;
    for (const f of sorted) {
        if (f.severity === "minor" && minors++ >= maxMinor) trimmed.push(f);
        else if (f.severity === "nit" && ((level === "quick" && !nitsAtQuick) || nits++ >= maxNit)) trimmed.push(f);
        else kept.push(f);
    }
    return { kept, trimmed };
}

export type Verdict = "ready" | "fix_first" | "needs_discussion";

export function decideVerdict(findings: Finding[], o: { failed?: string[]; dropped?: number; missingRepos?: string[]; contractsRan?: boolean } = {}): { verdict: Verdict; reason: string } {
    const { failed = [], dropped = 0, missingRepos = [], contractsRan = false } = o;
    const blockers = findings.filter((f) => f.severity === "blocker");
    const confirmedMajors = findings.filter((f) => f.severity === "major" && f.confidence === "confirmed");
    if (blockers.length || confirmedMajors.length) {
        const top = [...blockers, ...confirmedMajors].slice(0, 3).map((f) => `${f.ruleId} ${f.title}`).join("; ");
        return { verdict: "fix_first", reason: `${blockers.length} blocker(s), ${confirmedMajors.length} confirmed major(s): ${top}.` };
    }
    const open: string[] = [];
    if (failed.length) open.push(`specialist(s) failed: ${failed.join(", ")}`);
    if (dropped) open.push(`${dropped} finding(s) dropped as malformed`);
    const possibleMajors = findings.filter((f) => f.severity === "major");
    if (possibleMajors.length) open.push(`${possibleMajors.length} unconfirmed major(s) need a human check`);
    if (contractsRan && missingRepos.length) open.push(`consumers in ${missingRepos.join(", ")} not checked`);
    if (open.length) return { verdict: "needs_discussion", reason: `${open.join("; ")}.` };
    return { verdict: "ready", reason: findings.length ? "Only minor findings remain." : "No findings." };
}

export interface Gate { failOn: Severity | "none"; blockOnPossible?: boolean; onReviewError?: "fail" | "warn" }

export function gateDecision(result: { verdict?: string; findings: Finding[] } | undefined, gate: Gate) {
    if (!result) {
        return gate.onReviewError === "warn"
            ? { exitCode: 0, status: "warn", message: "Review failed to produce a valid result (onReviewError=warn).", blocking: [] as Finding[] }
            : { exitCode: 2, status: "error", message: "Review failed to produce a valid result (onReviewError=fail).", blocking: [] as Finding[] };
    }
    if (gate.failOn === "none") return { exitCode: 0, status: "pass", message: `Verdict ${result.verdict}; gate disabled.`, blocking: [] as Finding[] };
    const threshold = SEVERITY_RANK[gate.failOn];
    if (!threshold) throw new Error(`Unknown gate.failOn "${gate.failOn}"`);
    const blocking = result.findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold && (gate.blockOnPossible || f.confidence === "confirmed"));
    return blocking.length
        ? { exitCode: 1, status: "fail", message: `${blocking.length} finding(s) at or above "${gate.failOn}".`, blocking }
        : { exitCode: 0, status: "pass", message: `Verdict ${result.verdict}; nothing at or above "${gate.failOn}".`, blocking };
}

/** Re-review delta by stable id: what was fixed, what is new, what is still open. */
export function computeDelta(previous: { findings: Finding[]; verdict?: string; scope?: { headSha?: string; repoKey?: string } } | undefined, findings: Finding[], repoKey?: string) {
    if (!previous?.findings) return undefined;
    if (repoKey && previous.scope?.repoKey && previous.scope.repoKey !== repoKey) return undefined;
    const brief = (f: Finding) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, title: f.title, file: f.file, line: f.line });
    const before = new Map(previous.findings.map((f) => [f.id, f]));
    const now = new Map(findings.map((f) => [f.id, f]));
    return {
        previousHeadSha: previous.scope?.headSha ?? null,
        previousVerdict: previous.verdict ?? null,
        fixed: [...before.values()].filter((f) => !now.has(f.id)).map(brief),
        new: [...now.values()].filter((f) => !before.has(f.id)).map(brief),
        stillOpen: [...now.values()].filter((f) => before.has(f.id)).map(brief),
    };
}

// ---- adversarial verification ---------------------------------------------------------------

export interface Decision { n: number; decision: "confirm" | "downgrade" | "reject"; severity?: Severity; confidence?: Confidence; verification?: string }
export interface VerifyStats { confirmed: number; downgraded: number; rejected: number; unverified: number }

/**
 * Applies a verifier's decisions to the findings it saw.
 *   same  - the reviewing model checks itself: it may confirm, downgrade or reject.
 *   cross - a DIFFERENT model checks it: it may lower a severity, never raise one, and its reasons are
 *           stored apart (`crossVerification`) so a human can see both opinions.
 * A finding with no decision stays but is marked unverified and possible: silence is not confirmation.
 */
export function applyDecisions(items: Finding[], decisions: Decision[], mode: "same" | "cross" = "same", stats: VerifyStats = { confirmed: 0, downgraded: 0, rejected: 0, unverified: 0 }) {
    const byN = new Map(decisions.map((d) => [Number(d.n), d]));
    const field = mode === "cross" ? "crossVerification" : "verification";
    const kept: Finding[] = [];
    const rejected: Finding[] = [];
    items.forEach((f, n) => {
        const d = byN.get(n);
        if (!d) {
            stats.unverified++;
            kept.push(mode === "cross" ? { ...f, crossVerification: "no decision returned" } : { ...f, confidence: "possible", verification: "not verified (no decision returned)" });
            return;
        }
        const note = d.verification ? String(d.verification) : undefined;
        if (d.decision === "reject") { stats.rejected++; rejected.push({ ...f, [field]: note ?? "rejected" }); return; }
        let severity: Severity = SEVERITY_RANK[d.severity ?? ""] ? (d.severity as Severity) : f.severity;
        if (mode === "cross" && SEVERITY_RANK[severity] > SEVERITY_RANK[f.severity]) severity = f.severity;
        const confirmed = d.decision === "confirm" || d.confidence === "confirmed";
        // A second opinion can only keep a finding confirmed if the first one already had it confirmed.
        const confidence: Confidence = mode === "cross" ? (confirmed && f.confidence === "confirmed" ? "confirmed" : "possible") : confirmed ? "confirmed" : "possible";
        if (d.decision === "downgrade") stats.downgraded++; else stats.confirmed++;
        kept.push({ ...f, severity, confidence, ...(note ? { [field]: note } : {}) });
    });
    return { kept, rejected, stats };
}

// ---- consensus ------------------------------------------------------------------------------

const NEAR = 15;
const sameIssue = (a: Finding, b: Finding) =>
    (a.repo ?? "") === (b.repo ?? "") && a.file === b.file && a.ruleId === b.ruleId && (a.anchor === b.anchor || Math.abs((a.line ?? 0) - (b.line ?? 0)) <= NEAR);
const better = (a: Finding, b: Finding) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.confidence === b.confidence ? 0 : a.confidence === "confirmed" ? -1 : 1);

/**
 * Merges N independent runs of the same review. Models vary from run to run, so a finding is kept when
 * enough runs agree, or when any run reported a CONFIRMED major-or-worse for a critical rule (a verified
 * catch there is not thrown away). The rest are listed as seen-once, never posted.
 */
export function mergeRuns(results: Array<{ findings: Finding[]; [k: string]: any }>, o: { minAgree?: number; missingRepos?: string[]; criticalRules?: string[] } = {}) {
    const { minAgree = 2, missingRepos = [], criticalRules = [] } = o;
    const critical = new Set(criticalRules);
    const ok = results.filter((r) => r && Array.isArray(r.findings));
    if (!ok.length) throw new Error("no usable run to merge");
    const n = ok.length;
    const clusters: Array<{ items: Array<{ run: number; f: Finding }> }> = [];
    ok.forEach((r, run) => {
        for (const f of r.findings) {
            const c = clusters.find((x) => sameIssue(x.items[0].f, f));
            if (c) c.items.push({ run, f }); else clusters.push({ items: [{ run, f }] });
        }
    });
    const kept: Finding[] = [];
    const seenOnce: Finding[] = [];
    for (const c of clusters) {
        const runs = new Set(c.items.map((i) => i.run)).size;
        const best = c.items.map((i) => i.f).sort(better)[0];
        const strong = c.items.some((i) => critical.has(i.f.ruleId) && SEVERITY_RANK[i.f.severity] >= SEVERITY_RANK.major && i.f.confidence === "confirmed");
        const out = { ...best, consensus: `${runs}/${n}` };
        if (runs >= Math.min(minAgree, n) || strong) kept.push(out); else seenOnce.push(out);
    }
    const specialistsRun = [...new Set(ok.flatMap((r) => (r.specialistsRun ?? []) as string[]))];
    const { verdict, reason } = decideVerdict(kept, { missingRepos, contractsRan: specialistsRun.includes("contracts") });
    return {
        summary: ok[0].summary,
        findings: sortFindings(kept),
        specialistsRun,
        verdict,
        verdictReason: `${reason} (consensus of ${n} runs; ${seenOnce.length} finding(s) seen in only one run are hidden)`,
        consensus: { runs: n, failedRuns: results.length - n, kept: kept.length, seenOnce },
    };
}

// ---- SARIF ----------------------------------------------------------------------------------

export function toSarif(result: { findings: Finding[]; scope?: { repoKey?: string } }, toolName = "secufusion-mcp") {
    const level: Record<string, string> = { blocker: "error", major: "error", minor: "warning", nit: "note" };
    const rules = new Map<string, any>();
    for (const f of result.findings) {
        if (!rules.has(f.ruleId)) rules.set(f.ruleId, { id: f.ruleId, name: f.ruleId, shortDescription: { text: f.ruleId === "GEN" ? "General finding" : `SecuFusion rule ${f.ruleId}` }, properties: { category: f.category } });
    }
    return {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [{
            tool: { driver: { name: toolName, rules: [...rules.values()] } },
            results: result.findings.map((f) => ({
                ruleId: f.ruleId,
                level: level[f.severity],
                message: { text: `${f.title}\n\n${f.problem}\n\nFails when: ${f.failureScenario}\n\nFix: ${f.suggestion}` },
                locations: [{ physicalLocation: {
                    artifactLocation: { uri: f.repo && f.repo !== result.scope?.repoKey ? `../${f.repo}/${f.file}` : f.file },
                    region: { startLine: Math.max(1, f.line || 1), ...(f.endLine ? { endLine: f.endLine } : {}) },
                } }],
                partialFingerprints: { secufusionFindingId: f.id },
                properties: { severity: f.severity, confidence: f.confidence, anchor: f.anchor },
            })),
        }],
    };
}

/** Rules whose findings, once CONFIRMED, are never rated below major: tenant isolation, authorization, applied migrations, destructive deletes and contract breaks. */
export const DEFAULT_SEVERITY_FLOORS: Record<string, Severity> = {
    "SEC-001": "major", "SEC-002": "major", "SEC-003": "major", "SEC-005": "major", "SEC-006": "major", "SEC-008": "major", "SEC-010": "major", "SEC-017": "major", "SEC-018": "major",
    "DB-001": "major", "DB-002": "major", "DB-004": "major", "DB-006": "major", "DB-007": "major", "DB-012": "major",
    "CON-001": "major", "CON-004": "major",
};

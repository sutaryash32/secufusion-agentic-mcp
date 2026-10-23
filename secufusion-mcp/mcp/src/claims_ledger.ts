/**
 * Claims ledger: the story, the code and the tests, in both directions.
 *
 * "Does the code match the story, does the story match reality, are there gaps between what is written and what is
 * built?" is answered here by bookkeeping, not by a feeling. Every statement in the story becomes a CLAIM. The reviewer
 * (a model) judges each claim and attaches EVIDENCE: code that implements it, a test that proves it, code that shows it is
 * true today, or code that contradicts it. This module does the part a model must not be trusted with:
 *   - every piece of evidence is checked against the real files (exists, inside the workspace, quote really there);
 *   - each claim gets a status from the evidence that survived: VERIFIED, IMPLEMENTED_UNTESTED, CONTRADICTED,
 *     UNVERIFIABLE, UNVERIFIED or NO_EVIDENCE (written, but nothing shows it was built);
 *   - the diff is mapped BACK to the claims: a changed region no claim accounts for is an UNCLAIMED_CHANGE (built, but
 *     nobody wrote it down).
 * Claims come in kinds. A change claim (acceptance, non-functional) must be implemented and tested. A reality claim ("today
 * the export only includes active users"), an assumption or a decision is checked against the code that exists now.
 * Language-neutral: it never parses code, it only checks citations. READ-ONLY.
 */
import { validateEvidence } from "./finding_evidence.js";
import type { EvidenceResult } from "./finding_evidence.js";
import { changedRanges } from "./mutation_review.js";
import type { Ranges } from "./mutation_review.js";

/** implied: the product requires it though the story does not say it. silent: a path that exists for the story's entities and the story never mentions. */
export type ClaimKind = "acceptance" | "reality" | "assumption" | "decision" | "nonfunctional" | "implied" | "silent";
export type Relation = "implements" | "tests" | "supports" | "contradicts";
export type Status = "VERIFIED" | "IMPLEMENTED_UNTESTED" | "CONTRADICTED" | "UNVERIFIABLE" | "UNVERIFIED" | "NO_EVIDENCE";

export interface ClaimIn { id?: string; text: string; kind?: ClaimKind; source?: string }
export interface EvidenceIn { claim_id: string; relation: Relation; file: string; line?: number; quote?: string; note?: string }
export interface Claim { id: string; text: string; kind: ClaimKind; source?: string }
export interface LedgerClaim extends Claim {
    status: Status;
    why: string;
    evidence: Array<EvidenceIn & { check: EvidenceResult["status"]; action: EvidenceResult["action"]; actual_line?: number; in_change?: boolean }>;
}
export interface UnclaimedChange { file: string; start: number; end: number }
export interface Ledger {
    claims: LedgerClaim[];
    counts: Record<Status, number>;
    unclaimed_changes: UnclaimedChange[];
    unknown_claim_ids: string[];
    gaps: Array<{ severity: "BLOCKER" | "WARNING" | "NOTE"; type: string; ref: string; text: string }>;
    diff_known: boolean;
    notes: string[];
}

// ------------------------------------------------------------ extraction
const ACCEPT = /\b(given|when|then|should|must|shall|can(?:not)?|only|never|always|exactly|at least|at most|returns?|displays?|rejects?|allows?|prevents?|ensures?|require[sd]?|acceptance|AC\s*\d*)\b/i;
const REALITY = /\b(currently|today|already|existing|at present|right now|at the moment|as it stands|legacy|presently|so far)\b/i;
const ASSUME = /\b(assum\w*|presum\w*|probably|likely|i think|maybe|unless|depending on|expect(?:ed)? that|supposedly|should already)\b/i;
const DECIDE = /\b(decided|agreed|we will|we'll|approved|confirmed by|signed off|per the decision|decision:)\b/i;
const NONFUNC = /\b(performance|latency|within \d+|under \d+\s*(?:ms|s|seconds)|throughput|\d+\s*(?:rps|req\/s)|audit(?:ed)?|log(?:ged)?|retention|gdpr|privacy|secur\w+|encrypt\w*|accessib\w+)\b/i;

const classify = (s: string, inAc: boolean, inCtx = false): ClaimKind => {
    if (DECIDE.test(s)) return "decision";
    if (ASSUME.test(s)) return "assumption";
    if (REALITY.test(s)) return "reality";
    if (NONFUNC.test(s) && !/^(given|when|then)\b/i.test(s)) return "nonfunctional";
    if (inAc || ACCEPT.test(s)) return "acceptance";
    // plain prose: what the story asks for is a claim the change must make true; prose under a context heading describes today
    return inCtx ? "reality" : "acceptance";
};

/** Splits free story text into candidate claims. Heuristic: the reviewer reads and corrects the list. */
export function extractClaims(text: string): Claim[] {
    const out: string[] = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let inAc = false;
    let inCtx = false;
    let buf = "";
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ""; };
    const kindOf = new Map<string, boolean>();
    const ctxOf = new Map<string, boolean>();
    for (const raw of lines) {
        const l = raw.trim();
        if (!l) { flush(); continue; }
        if (/^#{1,6}\s|^[A-Z][A-Za-z ]{2,40}:$/.test(l)) { flush(); inAc = /accept|criteri|requirement|scope|expected|definition of done/i.test(l); inCtx = /context|background|notes?|description|current|existing|today/i.test(l); continue; }
        const bullet = /^(?:[-*•]|\d+[.)]|AC\s*\d*[:.)]|\[[ xX]\])\s+(.*)$/.exec(l);
        if (/^(given|when|then|and|but)\b/i.test(l)) { buf += (buf ? " " : "") + l; kindOf.set(buf, true); continue; }
        flush();
        if (bullet) { out.push(bullet[1]); kindOf.set(bullet[1], inAc); continue; }
        // every declarative sentence is a claim: dropping the ones without a modal verb ("the new owner becomes the IT Admin") loses the story's own outcomes
        for (const sent of l.split(/(?<=[.!?])\s+/)) { if (sent.split(/\s+/).length >= 4) { out.push(sent); kindOf.set(sent, inAc); ctxOf.set(sent, inCtx); } }
    }
    flush();
    const seen = new Set<string>();
    const claims: Claim[] = [];
    for (const s of out) {
        const t = s.replace(/\s+/g, " ").slice(0, 300);
        if (t.split(" ").length < 3 || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        claims.push({ id: `C${claims.length + 1}`, text: t, kind: classify(t, kindOf.get(s) ?? false, ctxOf.get(s) ?? false) });
        if (claims.length >= 80) break;
    }
    return claims;
}

// ------------------------------------------------------------ ledger
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec|specs)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt|cs)$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const NONCODE = /\.(md|rst|txt|adoc|lock|svg|png|jpg|json)$|(^|\/)docs?\//i;
const inRange = (n: number, a: number, b: number, slack = 0) => n >= a - slack && n <= b + slack;

export function buildLedger(root: string, o: { claims: ClaimIn[]; evidence?: EvidenceIn[]; changed?: Ranges; base?: string }): Ledger {
    const notes: string[] = [];
    const claims: Claim[] = o.claims.map((c, i) => ({ id: c.id ?? `C${i + 1}`, text: c.text, kind: c.kind ?? classify(c.text, false), source: c.source }));
    const ids = new Set(claims.map((c) => c.id));
    const evidence = o.evidence ?? [];

    let changed: Ranges | undefined = o.changed;
    if (!changed && o.base) { try { changed = changedRanges(root, o.base); } catch (e) { notes.push(`could not read the diff against ${o.base}: ${(e as Error).message.split("\n")[0]}`); } }
    const diffKnown = !!changed;

    const checked = validateEvidence(root, evidence.map((e, i) => ({ id: String(i), file: e.file, line: e.line, quote: e.quote })));
    const ev = evidence.map((e, i) => {
        const r = checked.results[i];
        const line = r.actual_line ?? e.line;
        let inChange: boolean | undefined;
        if (changed && line !== undefined) {
            const key = Object.keys(changed).find((f) => f === e.file.replace(/\\/g, "/") || f.endsWith("/" + e.file.replace(/\\/g, "/")) || e.file.replace(/\\/g, "/").endsWith("/" + f));
            inChange = key ? changed[key].some(([a, b]) => inRange(line, a, b)) : false;
        }
        return { ...e, check: r.status, action: r.action, actual_line: r.actual_line, in_change: inChange };
    });
    const unknown = [...new Set(ev.filter((e) => !ids.has(e.claim_id)).map((e) => e.claim_id))];

    const counts: Record<Status, number> = { VERIFIED: 0, IMPLEMENTED_UNTESTED: 0, CONTRADICTED: 0, UNVERIFIABLE: 0, UNVERIFIED: 0, NO_EVIDENCE: 0 };
    const ledger: LedgerClaim[] = claims.map((c) => {
        const mine = ev.filter((e) => e.claim_id === c.id);
        const strong = (rel: Relation) => mine.filter((e) => e.relation === rel && e.action === "KEEP");
        let status: Status, why: string;
        if (strong("contradicts").length) {
            status = "CONTRADICTED"; why = `the code contradicts this claim (${strong("contradicts").map((e) => `${e.file}:${e.actual_line ?? e.line}`).join(", ")})`;
        } else if (c.kind === "acceptance" || c.kind === "nonfunctional") {
            const impl = strong("implements"), tests = strong("tests");
            if (impl.length && tests.length) { status = "VERIFIED"; why = "implemented and tested, both citations confirmed in the code"; }
            else if (impl.length) { status = "IMPLEMENTED_UNTESTED"; why = "implemented, but no confirmed test shows it"; }
            else if (!mine.length) { status = "NO_EVIDENCE"; why = "written in the story, but nothing shows it was built"; }
            else { status = "UNVERIFIABLE"; why = "evidence was supplied but none of it survived the check (no quote, or the quote is not in the code, or it only tests)"; }
            if (status !== "NO_EVIDENCE" && impl.length && changed && impl.every((e) => e.in_change === false)) why += "; the implementing code is outside the change, so the claim may already hold or the change does not touch it";
        } else {
            const sup = strong("supports");
            if (sup.length) { status = "VERIFIED"; why = `${c.kind === "implied" ? "preserved by" : c.kind === "silent" ? "answered by" : "holds today according to"} ${sup.map((e) => `${e.file}:${e.actual_line ?? e.line}`).join(", ")}`; }
            else if (!mine.length) { status = "UNVERIFIED"; why = c.kind === "implied" ? "the product requires this and nobody showed the change preserves it" : c.kind === "silent" ? "the story is silent here and nobody said what must happen" : `a ${c.kind} nobody checked against the code`; }
            else { status = "UNVERIFIABLE"; why = "evidence was supplied but none of it survived the check"; }
        }
        counts[status]++;
        return { ...c, status, why, evidence: mine };
    });

    // reverse direction: what changed that no claim accounts for?
    const unclaimed: UnclaimedChange[] = [];
    if (changed) {
        const claimed = ev.filter((e) => e.action === "KEEP" && (e.relation === "implements" || e.relation === "supports") && ids.has(e.claim_id));
        for (const [file, ranges] of Object.entries(changed)) {
            if (TEST.test(file) || NONCODE.test(file)) continue;
            for (const [a, b] of ranges) {
                const hit = claimed.some((e) => {
                    const ef = e.file.replace(/\\/g, "/");
                    const l = e.actual_line ?? e.line;
                    return (ef === file || ef.endsWith("/" + file) || file.endsWith("/" + ef)) && l !== undefined && inRange(l, a, b, 3);
                });
                if (!hit) unclaimed.push({ file, start: a, end: b });
            }
        }
    } else notes.push("no diff was given (pass `base` or `changed`): the reverse check, changes that no claim accounts for, was not run");
    if (diffKnown && evidence.length === 0) notes.push("no evidence was supplied yet, so every changed region is unclaimed: judge the claims first, then re-run");

    const gaps: Ledger["gaps"] = [];
    for (const c of ledger) {
        if (c.status === "CONTRADICTED") gaps.push({ severity: "BLOCKER", type: "CONTRADICTED", ref: c.id, text: `${c.text} — ${c.why}` });
        else if ((c.kind === "acceptance" || c.kind === "nonfunctional") && (c.status === "NO_EVIDENCE" || c.status === "UNVERIFIABLE")) gaps.push({ severity: "BLOCKER", type: "WRITTEN_NOT_BUILT", ref: c.id, text: `${c.text} — ${c.why}` });
        else if (c.status === "IMPLEMENTED_UNTESTED") gaps.push({ severity: "WARNING", type: "UNTESTED", ref: c.id, text: c.text });
        else if (c.kind === "implied" && c.status !== "VERIFIED") gaps.push({ severity: "WARNING", type: "PRODUCT_REQUIRES_UNCHECKED", ref: c.id, text: `${c.text}${c.source ? ` [${c.source}]` : ""} — ${c.why}` });
        else if (c.kind === "silent" && c.status !== "VERIFIED") gaps.push({ severity: "WARNING", type: "STORY_SILENT", ref: c.id, text: `${c.text} — ${c.why}. Put it to the user as a decision.` });
        else if (c.kind === "decision" && c.status !== "VERIFIED") gaps.push({ severity: "WARNING", type: "DECISION_NOT_SHOWN", ref: c.id, text: `${c.text} — ${c.why}` });
        else if ((c.kind === "reality" || c.kind === "assumption") && c.status !== "VERIFIED") gaps.push({ severity: "NOTE", type: `UNCHECKED_${c.kind.toUpperCase()}`, ref: c.id, text: `${c.text} — ${c.why}` });
    }
    for (const u of unclaimed.slice(0, 40)) gaps.push({ severity: "WARNING", type: "BUILT_NOT_WRITTEN", ref: `${u.file}:${u.start}-${u.end}`, text: "a changed region that no claim accounts for: scope creep, a missing acceptance criterion, or a claim nobody linked" });
    if (unknown.length) gaps.push({ severity: "NOTE", type: "EVIDENCE_FOR_UNKNOWN_CLAIM", ref: unknown.join(","), text: "evidence names a claim id that does not exist" });
    const order = { BLOCKER: 0, WARNING: 1, NOTE: 2 };
    gaps.sort((a, b) => order[a.severity] - order[b.severity]);
    notes.push("the tool checks that evidence EXISTS, not that it MEANS what the reviewer says: read each cited line before relying on a VERIFIED status");
    return { claims: ledger, counts, unclaimed_changes: unclaimed, unknown_claim_ids: unknown, gaps, diff_known: diffKnown, notes };
}

export function renderLedger(l: Ledger): string {
    const c = l.counts;
    const out = [`# Claims ledger: ${l.claims.length} claim(s)`, `VERIFIED ${c.VERIFIED} · IMPLEMENTED_UNTESTED ${c.IMPLEMENTED_UNTESTED} · CONTRADICTED ${c.CONTRADICTED} · UNVERIFIABLE ${c.UNVERIFIABLE} · UNVERIFIED ${c.UNVERIFIED} · NO_EVIDENCE ${c.NO_EVIDENCE} · unclaimed changes ${l.unclaimed_changes.length}`, ""];
    for (const k of l.claims) {
        out.push(`${k.id}  [${k.kind}]  ${k.status}`, `    ${k.text}`, ...(k.source ? [`    source: ${k.source}`] : []), `    ${k.why}`);
        for (const e of k.evidence) out.push(`      ${e.relation.padEnd(11)} ${e.file}${e.line ? ":" + e.line : ""}  ${e.check}${e.action === "DROP" ? " (DROPPED)" : ""}${e.in_change === false ? " (outside the change)" : ""}`);
    }
    if (l.gaps.length) { out.push("", "GAPS between what is written and what is built:"); for (const g of l.gaps) out.push(`  ${g.severity.padEnd(7)} ${g.type}  ${g.ref}  ${g.text.slice(0, 200)}`); }
    out.push("", ...l.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}

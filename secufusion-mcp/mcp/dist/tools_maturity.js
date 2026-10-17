// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { gitTop } from "./diff_quality.js";
import { loadDecisions, collectChange, checkDecisionAlignment, renderDecisionAlignment, relevantInvariants, candidateInvariants, renderInvariants, scoreConfidence, } from "./review_maturity.js";
import { reviewStalenessFor } from "./review_staleness.js";
const root = (w) => gitTop(w) ?? path.resolve(w);
const ok = (t) => ({ content: [{ type: "text", text: t }] });
const bad = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
export function registerMaturityTools(server) {
    server.tool("get_relevant_invariants", "Invariant Catalog lookup for /sfn-review. Surfaces the invariants the project has recorded (.mcp/invariants/) that are relevant to this change, by terms, changed files, fields and domain, so a review stops rediscovering them story after story. " +
        "Each is classified CONFIRMED (accepted AND enforcement demonstrated by a DB constraint or lock), PROPOSED (nobody accepted it), NOT DEMONSTRATED (accepted but enforcement is code-only or check-then-act, or not examined) or VIOLATED (only when you pass the id in `violated` because you found a concrete violation). " +
        "It shows SOURCE, EVIDENCE, WRITE PATHS (file:line, protected or not) and ENFORCEMENT TYPE (DB / LOCK / TEST / CODE) using the same scan as check_invariant_enforcement. " +
        "It also lists CANDIDATE invariants lifted from recorded decisions; those are suggestions to confirm with the user, never records. READ-ONLY.", {
        workspace_root: z.string().describe("A directory inside the project that holds .mcp/"),
        terms: z.array(z.string()).max(20).optional().describe("Entity and story terms, e.g. ['tenant', 'IT Admin', 'owner']"),
        files: z.array(z.string()).max(60).optional().describe("Changed files (default: the git diff against the base)"),
        fields: z.array(z.string()).max(8).optional().describe("Fields under change, e.g. ['defaultUser']; matches invariants that declare them"),
        domains: z.array(z.string()).max(6).optional().describe("Domains to include whole, e.g. ['Tenant', 'User']"),
        code_root: z.string().optional().describe("Where to scan write paths when the code lives outside workspace_root (a multi-service workspace)"),
        scan: z.boolean().optional().describe("false skips the code scan (classification then rests on status only)"),
        violated: z.array(z.string()).max(20).optional().describe("Invariant ids you found violated in this review, with evidence in the report"),
        base: z.string().optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async (a) => {
        try {
            const r = root(a.workspace_root);
            const ctx = collectChange(r, { base: a.base, terms: a.terms, files: a.files });
            const files = a.files ?? ctx.files;
            const res = relevantInvariants(r, { terms: a.terms, files, fields: a.fields, domains: a.domains, scan: a.scan, code_root: a.code_root, violated: a.violated });
            // candidates come only from decisions this change touches: a workspace-wide harvest would drown the review in other stories
            const cands = candidateInvariants(checkDecisionAlignment(loadDecisions(r), ctx).map((c) => c.decision));
            if (a.format === "json")
                return ok(JSON.stringify({ ...res, candidates: cands }, null, 2));
            return ok(renderInvariants(res, cands));
        }
        catch (e) {
            return bad(e);
        }
    });
    server.tool("check_decision_alignment", "Decision Registry check for /sfn-review. Loads the decisions a person made (.mcp/decisions/, plus read-only the decisions recorded in .secufusion/tasks/*/decisions.json and the answered user decisions in .secufusion/requirements/), finds the ones this change touches by shared identifiers, and reports deterministic SIGNALS: a guardrail line removed, a new writer of a field a decision protects (a possible second source of truth), a decision that itself records an unconfirmed assumption, code changed with no test change. " +
        "It NEVER says ALIGNS. You judge each: ALIGNS / VIOLATES / PARTIALLY ALIGNS / UNVERIFIED, asking: does it contradict, weaken, add a second source of truth, or bypass a prior guardrail? Decisions found only in work records are RECORDED, not ACCEPTED. READ-ONLY.", {
        workspace_root: z.string().describe("A directory inside the project (for a multi-service workspace, the folder that holds .secufusion/)"),
        terms: z.array(z.string()).max(30).optional().describe("Story terms, field names, endpoints and decision refs the change concerns, e.g. ['defaultUser', 'tenant.email', 'UD-1']"),
        files: z.array(z.string()).max(80).optional().describe("Changed files (default: the git diff against the base)"),
        base: z.string().optional().describe("Base ref for the diff (default: the repository's main branch)"),
        diff_path: z.string().optional().describe("A unified diff file to use instead of git (useful for a multi-repo story)"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async (a) => {
        try {
            const r = root(a.workspace_root);
            const diff_text = a.diff_path ? fs.readFileSync(a.diff_path, "utf-8") : undefined;
            const ctx = collectChange(r, { base: a.base, terms: a.terms, files: a.files, diff_text });
            const decisions = loadDecisions(r);
            const checks = checkDecisionAlignment(decisions, ctx);
            if (a.format === "json")
                return ok(JSON.stringify({ total: decisions.length, checks }, null, 2));
            return ok(renderDecisionAlignment(checks, decisions.length, ctx));
        }
        catch (e) {
            return bad(e);
        }
    });
    server.tool("score_review_confidence", "Review Confidence Scoring for /sfn-review. Turns the evidence the review actually has into HIGH / MEDIUM / LOW CONFIDENCE, so 'I found no issue' is separated from 'I have enough evidence to trust this review'. " +
        "Inputs are counts and states you took from this review (invariants confirmed vs inferred, whether the cross-service scan ran, test evidence, whether database constraints were examined, concurrency / lifecycle / authority coverage, UNVERIFIED and REQUIRES_DECISION counts). " +
        "Hard caps: a STALE review (looked up from work_item_id) is LOW; a pessimistic story with no cross-service scan is LOW; open decisions or UNVERIFIED items, inferred-over-confirmed invariants, or an incomplete scan cap it at MEDIUM. Unexamined dimensions count against confidence, never for it. " +
        "Output: `CONFIDENCE SCORE:` and `CONFIDENCE EXPLANATION:`. With work_item_id the result is saved next to the gate ledger and shown by spec_status.", {
        workspace_root: z.string(),
        work_item_id: z.string().optional(),
        invariants_confirmed: z.number().int().min(0).optional(), invariants_inferred: z.number().int().min(0).optional(),
        invariants_violated: z.number().int().min(0).optional(), invariants_not_demonstrated: z.number().int().min(0).optional(),
        cross_service_scan: z.enum(["complete", "partial", "not_run", "n/a"]).optional(),
        services_with_hits: z.number().int().min(0).optional(), services_total: z.number().int().min(0).optional(),
        test_evidence: z.enum(["ran_and_passed", "exists_not_run", "none", "n/a"]).optional(),
        db_constraints: z.enum(["verified", "unknown", "n/a"]).optional().describe("verified = you examined the schema/migrations for a constraint and know whether one exists"),
        concurrency: z.enum(["covered", "partial", "none", "n/a"]).optional(),
        lifecycle: z.enum(["covered", "partial", "none", "n/a"]).optional(),
        authority: z.enum(["covered", "partial", "none", "n/a"]).optional(),
        unverified: z.number().int().min(0).optional(), requires_decision: z.number().int().min(0).optional(),
        pessimistic_trigger_fired: z.boolean().optional(), findings_count: z.number().int().min(0).optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async (a) => {
        try {
            const r = root(a.workspace_root);
            const stale = a.work_item_id ? reviewStalenessFor(r, a.work_item_id)?.stale === true : false;
            const { workspace_root, work_item_id, format, ...input } = a;
            const c = scoreConfidence({ ...input, stale });
            if (a.work_item_id) {
                const p = path.join(r, ".secufusion", "gates", `${a.work_item_id.replace(/[^a-zA-Z0-9._-]/g, "_")}.confidence.json`);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), level: c.level, score: c.score, caps: c.caps, input: { ...input, stale } }, null, 2));
            }
            return ok(a.format === "json" ? JSON.stringify(c, null, 2) : c.explanation);
        }
        catch (e) {
            return bad(e);
        }
    });
}

// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { gitTop } from "./diff_quality.js";
import { loadDecisions, collectChange, checkDecisionAlignment, renderDecisionAlignment, relevantInvariants, candidateInvariants, renderInvariants, scoreConfidence, } from "./review_maturity.js";
import { reviewStalenessFor } from "./review_staleness.js";
import { buildFeatureModel, renderFeatureModel } from "./feature_model.js";
import { mapFieldImpact, renderFieldImpact } from "./field_impact.js";
import { uiGating, renderGating, endpointConsumers, renderEndpointConsumers, serviceOwnership, renderOwnership, parentCascade, renderCascade } from "./parity_lenses.js";
import { seal, reveal, renderReveal } from "./calibration.js";
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
        completeness_unknown: z.number().int().min(0).max(10).optional().describe("How many of the 10 review-completeness questions you could only answer UNKNOWN (ownership, authority, lifecycle, data consistency, audit, UI vs backend, service divergence, platform assumptions, supportability, client concerns). Any UNKNOWN reduces confidence."),
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
    server.tool("build_feature_model", "Builds the review's model of a feature BEFORE any diff is judged. Discovers the work item family (the story, its child tasks, the item it was split from), the primary business entities (given, or proposed from tags), the lifecycle transitions that EXIST in the workspace per entity with file:line (create, update, transfer, enable/disable, delete, plus status changes and membership changes performed inside generic update methods) and whether each performing method ever mentions the ownership/status flag, the capability dependencies (code that decides authority from the entity or flag), the cross-service graph with rules copied across services, and a REVIEW MATRIX that lists every transition against every contract clause (ownership, authority, lifecycle, consistency/source of truth, audit, dependencies, tenancy). Transitions with no path are listed too: an absent path is a lifecycle question. " +
        "Pattern-based and READ-ONLY. It builds the questions; you answer them, and read a lead before calling it a finding.", {
        workspace_root: z.string().describe("The workspace root (for a multi-repo workspace, the folder that holds the services and .secufusion/)"),
        work_item_id: z.string().describe("The story or task id, e.g. STORY-1656 or TASK-1657"),
        entities: z.array(z.string()).max(8).optional().describe("The primary business entities as they appear in file names, e.g. ['User', 'Tenant', 'Group']. Omit to have them proposed from tags."),
        flags: z.array(z.string()).max(8).optional().describe("Fields that identify ownership or status, e.g. ['defaultUser', 'isAdmin']"),
        story_text: z.string().optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async (a) => {
        try {
            const m = buildFeatureModel(path.resolve(a.workspace_root), { work_item_id: a.work_item_id, entities: a.entities, flags: a.flags, story_text: a.story_text });
            if (a.format === "json") {
                const { impact, ...rest } = m;
                return ok(JSON.stringify(rest, null, 2));
            }
            return ok(renderFeatureModel(m));
        }
        catch (e) {
            return bad(e);
        }
    });
    server.tool("calibrate_review", "Calibration: would this review have written the same comments as the client reviewer? A blind protocol enforced by files. action=seal records your own derived concerns (BLOCKING / NON-BLOCKING / QUESTION / REQUIRES_DECISION, each with the model line it was derived from) and hashes them; it is refused once client comments exist. " +
        "action=reveal then adds the client's comments (refused without an intact seal) and reports PARITY: derived / partial / missed, blocking recall, severity differences, and the concerns you raised that the client did not. Matching is lexical and only proposes pairings: confirm or override with `overrides`. For every MISSED comment, state which contract, transition or capability would have produced it.", {
        workspace_root: z.string(),
        work_item_id: z.string(),
        action: z.enum(["seal", "reveal"]),
        findings: z.array(z.object({ title: z.string(), category: z.enum(["BLOCKING", "NON-BLOCKING", "QUESTION", "REQUIRES_DECISION"]), entity: z.string().optional(), text: z.string(), derived_from: z.string().optional() })).max(60).optional().describe("seal: the concerns you derived before seeing any client comment"),
        client_comments: z.array(z.object({ text: z.string(), category: z.string().optional() })).max(80).optional().describe("reveal: the client reviewer's comments, with blocking / non-blocking where known"),
        overrides: z.array(z.object({ client: z.number().int().min(0), derived: z.number().int().min(0).nullable(), verdict: z.enum(["DERIVED", "PARTIAL", "MISSED"]) })).optional().describe("reveal: your confirmed pairings (0-based indexes) replacing the lexical proposals"),
    }, async (a) => {
        try {
            const r = path.resolve(a.workspace_root);
            if (a.action === "seal") {
                const s = seal(r, a.work_item_id, a.findings ?? []);
                return ok(`SEALED ${s.count} derived concern(s) for ${a.work_item_id} at ${s.sealed_at} (sha256 ${s.sha256.slice(0, 16)}...). They cannot be edited. Only now may the client comments be looked at: call action=reveal.`);
            }
            const res = reveal(r, a.work_item_id, a.client_comments ?? [], a.overrides ?? []);
            return ok(renderReveal(res, a.client_comments ?? []));
        }
        catch (e) {
            return bad(e);
        }
    });
    server.tool("build_field_impact", "Field Impact Model for /sfn-review. For each field the change affects (defaultUser, tenant.email, status, createdBy, groups, roles ...): every consumer across the workspace (service, file:line, read or write), classified by what it does with the value: AUTHORITY (inside an authorizer or an authorization decision), API, UI, PERSISTENCE, EVENT, AUDIT, REPORT or plain LOGIC, with the question that turns each class of dependency into a business consequence. " +
        "A dependency is not a finding: you must argue the consequence (who loses access, what the user sees, which rows disagree) from what each consumer does. DTO mappers, comments, logs and tests are not counted. Pattern-based and READ-ONLY.", {
        workspace_root: z.string().describe("The workspace root (for a multi-repo workspace, the folder that holds the services)"),
        fields: z.array(z.string()).min(1).max(8).describe("Fields the change affects, camelCase or snake_case, e.g. ['defaultUser', 'status', 'createdBy']"),
        per_capability: z.number().int().min(1).max(15).optional().describe("Sample consumers shown per capability (default 4)"),
        file_filter: z.array(z.string()).max(8).optional().describe("Only files whose NAME contains one of these (case-insensitive), e.g. ['User'] to scope a generic field like status to one entity"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async (a) => {
        try {
            const r = mapFieldImpact(path.resolve(a.workspace_root), { fields: a.fields, file_filter: a.file_filter });
            return ok(a.format === "json" ? JSON.stringify(r, null, 2) : renderFieldImpact(r, a.per_capability ?? 4));
        }
        catch (e) {
            return bad(e);
        }
    });
    server.tool("check_ui_gating", "UI Gating Matrix for /sfn-review. For one action (for example transfer ownership) it lists WHO THE SERVER LETS EXECUTE it (entry point, @PreAuthorize, the authorization checks in the handler and the service method it calls) beside WHO THE UI SHOWS it to (the hidden/disabled/can* gates around the action, and for each can* predicate where its input comes from: a lookup of the current user in a list, and what it returns when nothing is found). " +
        "It raises the questions the two sides leave open: a caller the server accepts (an ancestor or parent tenant administrator) who is not in the list the UI derives its predicate from, a restriction with no UI gate, server conditions the UI does not mirror. Pattern-based and READ-ONLY; it lists both sides and you decide whether they agree.", {
        workspace_root: z.string().describe("The workspace root (the folder that holds the services and the UI)"),
        action: z.string().describe("A label for the action, e.g. 'transfer ownership'"),
        server_hint: z.string().describe("A regex that finds the server entry point and service method, e.g. 'transfer-?ownership|transferOwnership'"),
        ui_hint: z.string().describe("A regex that finds the UI gate and dialog, e.g. 'TransferOwnership|ownerToTransfer|canTransferOwnership'"),
    }, async (a) => { try {
        return ok(renderGating(uiGating(path.resolve(a.workspace_root), a)));
    }
    catch (e) {
        return bad(e);
    } });
    server.tool("find_endpoint_consumers", "Endpoint Consumer Graph for /sfn-review. For each endpoint whose response or behavior the change alters (for example GET /users now includes the IT Admin), finds the server handlers and EVERY caller: UI screens, UI services, other services and the browser extension, following one hop through the wrapper functions that hold the URL. Each caller assumed a response; the change alters it. " +
        "Pattern-based and READ-ONLY: a caller built from a variable URL, a gateway or a generated client is invisible, and no callers found is stated, never assumed.", {
        workspace_root: z.string(),
        endpoints: z.array(z.object({ method: z.string().optional(), path: z.string() })).min(1).max(6).describe("e.g. [{ method: 'GET', path: '/users' }]"),
    }, async (a) => { try {
        return ok(renderEndpointConsumers(endpointConsumers(path.resolve(a.workspace_root), { endpoints: a.endpoints })));
    }
    catch (e) {
        return bad(e);
    } });
    server.tool("check_service_ownership", "Service Ownership Model for /sfn-review. For each entity: the table(s) it maps, which services map it, which service owns the table (the one whose migrations create and alter it), and which services WRITE it through its repository. A write from a service that does not own the table assumes a shared database and the owner's schema, constraints and rules (for example iam-api saving a Tenant that tenants-api owns). Pattern-based and READ-ONLY.", {
        workspace_root: z.string(),
        entities: z.array(z.string()).min(1).max(6).describe("Entity class names, e.g. ['Tenant', 'User']"),
    }, async (a) => { try {
        return ok(renderOwnership(serviceOwnership(path.resolve(a.workspace_root), { entities: a.entities })));
    }
    catch (e) {
        return bad(e);
    } });
    server.tool("trace_parent_cascade", "Parent Cascade Analysis for /sfn-review. For a parent entity (Tenant) and its children (User): the parent transitions that remove or retire it (delete, deprovision, offboard, terminate ...), the child removals those transitions reach (repository delete that bypasses the service method, service delete, raw SQL, identity-provider removal), whether each path mentions the child guard (for example defaultUser), and database or mapping cascades (ON DELETE CASCADE, CascadeType.REMOVE) that remove children without any service code. A guard on the child's own delete protects nothing when the parent's lifecycle removes children another way. Pattern-based and READ-ONLY.", {
        workspace_root: z.string(),
        parent: z.string().describe("Parent entity, e.g. 'Tenant'"),
        children: z.array(z.string()).min(1).max(5).describe("Child entities, e.g. ['User']"),
        guard_terms: z.array(z.string()).max(5).optional().describe("Words that show the child guard is on the path, e.g. ['defaultUser', 'isDefaultUser']"),
    }, async (a) => { try {
        return ok(renderCascade(parentCascade(path.resolve(a.workspace_root), { parent: a.parent, children: a.children, guard_terms: a.guard_terms }), a.guard_terms ?? []));
    }
    catch (e) {
        return bad(e);
    } });
}

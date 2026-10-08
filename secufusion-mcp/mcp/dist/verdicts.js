import { z } from "zod";
/** Schemas + rubrics for every LLM judgment the server asks for. */
// ── philosophy ──────────────────────────────────────────────────────────────
export const PhilosophyVerdict = z.object({
    verdict: z.enum(["PASS", "ADVISORY", "FAIL", "BLOCKED"]),
    why: z.string().min(1),
    who: z.string().min(1),
    what: z.string().min(1),
    risk: z.string().min(1),
    questions_for_user: z.array(z.string()).default([]),
}).refine((v) => v.verdict === "PASS" || v.verdict === "ADVISORY" || v.questions_for_user.length > 0, {
    message: "FAIL/BLOCKED must include at least one question_for_user",
});
export const PhilosophyHint = `{"verdict":"PASS|ADVISORY|FAIL|BLOCKED","why":"...","who":"decision maker / user affected","what":"scope in one line","risk":"what breaks if built wrong or not built","questions_for_user":["required when FAIL/BLOCKED"]}`;
export const PhilosophyRubric = [
    "WHY: is the business problem stated, not just a solution?",
    "WHO: is there a named decision maker / affected user? Has it been confirmed (see client_confirmed)?",
    "WHAT: is the scope bounded enough to write testable acceptance criteria?",
    "RISK: does it touch tenant isolation, auth, destructive operations or shared contracts (events, APIs) in the project DNA?",
    "Check against rejected_patterns: does the request ask for something the team already rejected?",
    "Bugs/hotfixes may PASS with less business framing but still need a reproducible symptom.",
    "FAIL = unclear intent, ask the user. BLOCKED = unsafe or contradicts golden rules. ADVISORY = proceed but note concerns.",
];
// ── classification ─────────────────────────────────────────────────────────
export const ClassificationVerdict = z.object({
    classification: z.enum(["BACKEND_ONLY", "FRONTEND_ONLY", "FULL_STACK", "EXTENSION_ONLY"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    root_cause_location: z.string().min(1),
    reasoning: z.string().min(1),
    services_in_scope: z.array(z.string()).default([]),
    breaking_change_risks: z.array(z.string()).default([]),
    needs_user_confirmation: z.boolean(),
});
export const ClassificationHint = `{"classification":"BACKEND_ONLY|FRONTEND_ONLY|FULL_STACK|EXTENSION_ONLY","confidence":"HIGH|MEDIUM|LOW","root_cause_location":"where the fix lives","reasoning":"...","services_in_scope":["..."],"breaking_change_risks":["endpoint/topic/table + consumers"],"needs_user_confirmation":false}`;
export const ClassificationRubric = [
    "Classify by WHERE THE FIX LIVES, not where the symptom shows. A wrong number on a dashboard is usually a backend fix.",
    "Honour negations and explicit overrides in the description (\"not a UI issue\", \"no backend changes\").",
    "services_in_scope must come from the project spec's services, not guesses.",
    "breaking_change_risks: name each endpoint, Kafka topic or table that changes AND its consumers from the spec.",
    "heuristic_prior is a keyword-count hint only; disagree with it when the evidence says so.",
    "Set needs_user_confirmation=true when confidence is not HIGH or scope is mixed.",
];
// ── requirement assessment ─────────────────────────────────────────────────
export const RequirementVerdict = z.object({
    verdict: z.enum(["READY", "NEEDS_CLARIFICATION", "BLOCKED"]),
    summary: z.string().min(1),
    missing: z.array(z.object({
        topic: z.string(),
        issue: z.string(),
        severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        blocking: z.boolean(),
        question: z.string(),
    })).default([]),
    acceptance_criteria_testable: z.boolean(),
});
export const RequirementHint = `{"verdict":"READY|NEEDS_CLARIFICATION|BLOCKED","summary":"...","missing":[{"topic":"authorization","issue":"...","severity":"HIGH","blocking":true,"question":"..."}],"acceptance_criteria_testable":true}`;
export const RequirementRubric = [
    "READY only if scope, actors, tenancy, authorization, data lifecycle and acceptance criteria are unambiguous.",
    "Every acceptance criterion must be observable and testable (Given/When/Then or equivalent).",
    "Destructive operations (delete/purge/revoke) need an explicit recorded decision about their semantics (soft vs hard, cascade, audit).",
    "Do not invent facts. Anything not in the evidence is unknown, and a blocking unknown means NEEDS_CLARIFICATION.",
    "Each gap becomes a concrete question a human can answer in one sentence.",
    "BLOCKED = contradictory or unsafe requirement.",
];
// ── plan vs spec ───────────────────────────────────────────────────────────
export const PlanVerdict = z.object({
    verdict: z.enum(["APPROVED", "REVISE", "REJECT"]),
    summary: z.string().min(1),
    ac_coverage: z.array(z.object({
        criterion: z.string(),
        covered_by: z.array(z.string()),
        covered: z.boolean(),
    })),
    scope_creep: z.array(z.string()).default([]),
    destructive_operations: z.array(z.object({ operation: z.string(), confirmed_in_requirement: z.boolean() })).default([]),
    required_changes: z.array(z.string()).default([]),
});
export const PlanHint = `{"verdict":"APPROVED|REVISE|REJECT","summary":"...","ac_coverage":[{"criterion":"...","covered_by":["step or test obligation"],"covered":true}],"scope_creep":["plan items not traceable to any criterion"],"destructive_operations":[{"operation":"...","confirmed_in_requirement":true}],"required_changes":["..."]}`;
export const PlanRubric = [
    "Every acceptance criterion in the requirement must be covered by at least one implementation step AND at least one test obligation.",
    "Flag plan items that trace to no criterion as scope_creep.",
    "List every destructive operation; it is only acceptable if the requirement's decisions explicitly confirm it.",
    "Check security_implications against tenant isolation and authorization rules in the project spec.",
    "APPROVED requires: all criteria covered, no unconfirmed destructive operation, no scope_creep, no open unknowns.",
    "deterministic_errors are hard failures already found by the server; do not APPROVE while any remain.",
    "exploration.user_decisions are the user's answers: the plan must implement them exactly. A plan that contradicts or silently reinterprets one is REVISE.",
    "If exploration.ui_reference is CONFIRMED, the plan needs a frontend step for each affected component and a test for the resulting behaviour. The reference is design intent, not a pixel spec.",
    "If exploration.ui_impact is YES but ui_reference is not CONFIRMED or NOT_REQUIRED, REJECT: exploration is not finished.",
];
// ── verify against spec (review) ───────────────────────────────────────────
export const ReviewVerdict = z.object({
    verdict: z.enum(["APPROVED", "CHANGES_REQUIRED"]),
    summary: z.string().min(1),
    criteria: z.array(z.object({
        criterion: z.string(),
        status: z.enum(["MET", "PARTIAL", "UNMET", "UNVERIFIABLE"]),
        evidence: z.array(z.string()),
    })).min(1),
    out_of_scope_changes: z.array(z.string()).default([]),
    guardrail_violations: z.array(z.string()).default([]),
}).superRefine((v, ctx) => {
    v.criteria.forEach((c, i) => {
        if (c.status === "MET" && c.evidence.length === 0) {
            ctx.addIssue({ code: "custom", path: ["criteria", i, "evidence"], message: "MET requires at least one piece of evidence (file:line or test name)" });
        }
    });
    if (v.verdict === "APPROVED" && v.criteria.some((c) => c.status !== "MET")) {
        ctx.addIssue({ code: "custom", path: ["verdict"], message: "APPROVED requires every criterion to be MET" });
    }
    if (v.verdict === "APPROVED" && (v.guardrail_violations.length > 0 || v.out_of_scope_changes.length > 0)) {
        ctx.addIssue({ code: "custom", path: ["verdict"], message: "APPROVED requires no guardrail violations and no out-of-scope changes" });
    }
});
export const ReviewHint = `{"verdict":"APPROVED|CHANGES_REQUIRED","summary":"...","criteria":[{"criterion":"...","status":"MET|PARTIAL|UNMET|UNVERIFIABLE","evidence":["path/File.java:42","TestName"]}],"out_of_scope_changes":["..."],"guardrail_violations":["..."]}`;
export const ReviewRubric = [
    "Be adversarial. Your job is to find reasons the change does NOT satisfy the spec.",
    "Mark a criterion MET only with concrete evidence: a file:line you read, or a passing test that exercises it. No evidence means UNVERIFIABLE.",
    "Compare files_touched with the plan's affected_files; anything extra goes in out_of_scope_changes.",
    "Check golden_rules (tenant isolation, no hardcoded URLs, migrations for entity changes, no blocking calls in Kafka listeners) against the changed files.",
    "test_results are recorded results; a criterion whose only evidence is a failing or missing test is not MET.",
    "APPROVED only when every criterion is MET and there are no violations.",
    "exploration.user_decisions must be reflected in the implementation; an implementation that contradicts a recorded user decision is a guardrail violation.",
    "If exploration.ui_reference is CONFIRMED, check the production UI follows its intent (terminology, structure, states). Do not require pixel-perfect matching; report divergence from the approved intent.",
    "A UI reference is NOT_IMPLEMENTED until production code and a test exist; never count the static reference as evidence of implementation.",
];

import { z } from "zod";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { loadRequirement, saveRequirement, validateStateTransition, generateConfirmedSpecification } from "./requirement_manager.js";
import { loadTestResults } from "./test_engine.js";
import { loadPlan, savePlan, validatePlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { explorationSummary } from "./exploration.js";
import { renderSpecDocument } from "./spec_document.js";
import { loadKnowledge, queryKnowledge } from "./project_knowledge.js";
import { knowledgeRoot } from "./tools_knowledge.js";
import { displayRef, WORK_ITEM_ID_DESC } from "./work_item_ref.js";
import { analyzeDiffQuality, applyAcknowledgements, blockingFindings, checkScope } from "./diff_quality.js";
import { loadTraceability, addTraceabilityLink, traceForward, traceReverse, findTraceabilityGaps } from "./traceability_engine.js";
import { judge, judgmentParam, loadJudgment, hashOf } from "./judge.js";
import { recordGate, requireGates, readLedger, nextPhase, nextStepHint, PHASES } from "./gates.js";
import { takeReviewSnapshot, saveReviewSnapshot, reviewStalenessFor, describeStaleness, STALE_NEXT } from "./review_staleness.js";
import { RequirementVerdict, RequirementHint, RequirementRubric, PlanVerdict, PlanHint, PlanRubric, ReviewVerdict, ReviewHint, ReviewRubric, } from "./verdicts.js";
import { getWorkspaceRoot, resolve, readJson, writeFile, specEvidence, textResult, TASKS_DIR, resolveTaskFolder, getEcosystemRoot, getDnaPath } from "./shared.js";
const PLAN_CREATED_HEADER = ["Plan created.", "", "Confirmed exploration this plan MUST honour (decisions are the user's, not yours to change):", ""].join(String.fromCharCode(10));
export function registerSpecTools(server) {
    server.tool("manage_requirement", "Manages the structured lifecycle of a requirement, including clarification state and confirmation.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        id: z.string().describe("Stable requirement identifier (e.g. '2847' or 'req-123')."),
        action: z.enum(["create", "update", "read", "add_clarification", "resolve_clarification", "confirm", "generate_spec", "assess"]).describe("Action to perform on the requirement. 'assess' asks the LLM whether the requirement is READY; status=CONFIRMED is only accepted after a fresh READY assessment."),
        raw_request: z.string().optional(),
        title: z.string().optional(),
        status: z.enum(["RAW", "UNDERSTOOD", "INVESTIGATING", "UI_DESIGN_REQUIRED", "USER_FEEDBACK_REQUIRED", "USER_DECISION_REQUIRED", "CLARIFICATION_REQUIRED", "CONFIRMED", "BLOCKED", "SUPERSEDED"]).optional(),
        // Clarification specifics
        clarification_id: z.string().optional(),
        topic: z.string().optional(),
        issue: z.string().optional(),
        severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
        blocking: z.boolean().optional(),
        question: z.string().optional(),
        answer: z.string().optional(),
        decision: z.string().optional(),
        // Arrays and updates
        facts: z.array(z.string()).optional(),
        unknowns: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        scope: z.string().optional(),
        actors: z.array(z.string()).optional(),
        tenancy: z.string().optional(),
        authorization: z.string().optional(),
        business_rules: z.array(z.string()).optional(),
        data_lifecycle: z.string().optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        decisions: z.array(z.string()).optional(),
        root_cause: z.string().optional().describe("Root cause as an evidence-backed FACT (file:line), not a hypothesis. Required for bugs."),
        inferences: z.array(z.string()).optional(),
        assumptions: z.array(z.string()).optional(),
        conflicts: z.array(z.string()).optional(),
        judgment: judgmentParam
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const wsRoot = getWorkspaceRoot();
            let req = loadRequirement(ecosystemRoot, args.id);
            // Everything an assessment depends on; if it changes, the assessment is stale.
            const reqFingerprint = (r) => hashOf({
                raw_request: r.raw_request, scope: r.scope, actors: r.actors, tenancy: r.tenancy,
                authorization: r.authorization, business_rules: r.business_rules, data_lifecycle: r.data_lifecycle,
                acceptance_criteria: r.acceptance_criteria, constraints: r.constraints, facts: r.facts,
                unknowns: r.unknowns, decisions: r.decisions, blockers: r.blockers,
                root_cause: r.root_cause, assumptions: r.assumptions, inferences: r.inferences, conflicts: r.conflicts,
                clarifications: (r.clarification_questions || []).map((c) => [c.id, c.state, c.answer]),
                user_decisions: (r.user_decisions || []).map((d) => [d.id, d.state, d.answer]),
                ui_impact: r.ui_impact ? [r.ui_impact.status, r.ui_impact.affected_components] : null,
                ui_reference: r.ui_reference ? [r.ui_reference.design_id, r.ui_reference.status, r.ui_reference.revision] : null,
            });
            if (args.action === "create") {
                if (req)
                    return { content: [{ type: "text", text: `Requirement ${args.id} already exists.` }] };
                req = {
                    id: args.id,
                    title: args.title || "Untitled",
                    raw_request: args.raw_request,
                    status: args.status || "RAW",
                    clarification_questions: []
                };
                saveRequirement(ecosystemRoot, req);
                return { content: [{ type: "text", text: `Requirement ${args.id} created successfully.` }] };
            }
            if (!req)
                return { content: [{ type: "text", text: `Requirement ${args.id} not found.` }], isError: true };
            if (args.action === "read") {
                return { content: [{ type: "text", text: JSON.stringify(req, null, 2) }] };
            }
            if (args.action === "assess") {
                const outcome = await judge(server, wsRoot, {
                    kind: "requirement",
                    subject: args.id,
                    role: "Requirement Analyst (decides whether a requirement is specified well enough to plan against)",
                    rubric: RequirementRubric,
                    evidence: { requirement: req, project: specEvidence(wsRoot) },
                    schema: RequirementVerdict,
                    schemaHint: RequirementHint,
                    supplied: args.judgment,
                    reinvoke: "manage_requirement (action=assess)",
                });
                if (outcome.status !== "ok")
                    return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
                const rv = outcome.verdict;
                for (const m of rv.missing) {
                    const cid = `Q-${hashOf([m.topic, m.question]).slice(0, 6)}`;
                    if (!req.clarification_questions.some((c) => c.id === cid)) {
                        req.clarification_questions.push({
                            id: cid, topic: m.topic, issue: m.issue, state: "OPEN", evidence: [],
                            severity: m.severity, blocking: m.blocking, question: m.question, created_at: new Date().toISOString(),
                        });
                    }
                }
                if (rv.verdict !== "READY" && req.status === "INVESTIGATING")
                    req.status = "CLARIFICATION_REQUIRED";
                saveRequirement(ecosystemRoot, req);
                // Bind the verdict to the exact content it judged (after clarifications were added),
                // so any later edit makes it stale and forces a re-assessment.
                const stored = loadJudgment(wsRoot, args.id, "requirement");
                if (stored) {
                    stored.evidence_hash = reqFingerprint(req);
                    fs.writeFileSync(path.join(wsRoot, ".secufusion", "judgments", args.id.replace(/[^a-zA-Z0-9._-]/g, "_"), "requirement.json"), JSON.stringify(stored, null, 2));
                }
                if (rv.verdict !== "READY")
                    recordGate(wsRoot, args.id, "requirement", false, outcome.source, rv.summary);
                return { content: [{ type: "text", text: `${rv.verdict === "READY" ? "✅" : "❓"} Requirement ${args.id}: ${rv.verdict} (judged by ${outcome.source})\n${rv.summary}\n` +
                                (rv.missing.length ? `\nOpen questions (added as clarifications):\n${rv.missing.map((m) => `- [${m.severity}${m.blocking ? ", blocking" : ""}] ${m.question}`).join("\n")}\n` : "") +
                                (rv.verdict === "READY"
                                    ? `\nNext: manage_requirement action=update status=CONFIRMED (requirement must be INVESTIGATING first).`
                                    : `\nAnswer these with action=resolve_clarification, then assess again.`) }] };
            }
            if (args.action === "update") {
                if (args.title)
                    req.title = args.title;
                if (args.facts)
                    req.facts = args.facts;
                if (args.unknowns)
                    req.unknowns = args.unknowns;
                if (args.blockers)
                    req.blockers = args.blockers;
                if (args.scope)
                    req.scope = args.scope;
                if (args.actors)
                    req.actors = args.actors;
                if (args.tenancy)
                    req.tenancy = args.tenancy;
                if (args.authorization)
                    req.authorization = args.authorization;
                if (args.business_rules)
                    req.business_rules = args.business_rules;
                if (args.data_lifecycle)
                    req.data_lifecycle = args.data_lifecycle;
                if (args.acceptance_criteria)
                    req.acceptance_criteria = args.acceptance_criteria;
                if (args.constraints)
                    req.constraints = args.constraints;
                if (args.decisions)
                    req.decisions = args.decisions;
                if (args.root_cause)
                    req.root_cause = args.root_cause;
                if (args.inferences)
                    req.inferences = args.inferences;
                if (args.assumptions)
                    req.assumptions = args.assumptions;
                if (args.conflicts)
                    req.conflicts = args.conflicts;
                if (args.status) {
                    validateStateTransition(req.status, args.status, req);
                    if (args.status === "CONFIRMED") {
                        const assessed = loadJudgment(wsRoot, args.id, "requirement");
                        if (!assessed || assessed.verdict.verdict !== "READY") {
                            return { isError: true, content: [{ type: "text", text: `⛔ SPEC GATE: ${args.id} cannot be CONFIRMED without a READY assessment. Run manage_requirement action=assess first.` }] };
                        }
                        if (assessed.evidence_hash !== reqFingerprint(req)) {
                            return { isError: true, content: [{ type: "text", text: `⛔ SPEC GATE: ${args.id} changed after it was assessed. Run manage_requirement action=assess again.` }] };
                        }
                        recordGate(wsRoot, args.id, "requirement", true, assessed.source, assessed.verdict.summary);
                    }
                    else {
                        recordGate(wsRoot, args.id, "requirement", false, "status", `status is ${args.status}`);
                    }
                    req.status = args.status;
                }
                saveRequirement(ecosystemRoot, req);
                return { content: [{ type: "text", text: `Requirement ${args.id} updated.` }] };
            }
            if (args.action === "add_clarification") {
                if (!args.clarification_id || !args.topic || !args.issue || !args.question) {
                    return { content: [{ type: "text", text: "Missing clarification fields." }], isError: true };
                }
                req.clarification_questions.push({
                    id: args.clarification_id,
                    topic: args.topic,
                    issue: args.issue,
                    state: "OPEN",
                    evidence: [],
                    severity: args.severity || "MEDIUM",
                    blocking: args.blocking || false,
                    question: args.question,
                    created_at: new Date().toISOString()
                });
                saveRequirement(ecosystemRoot, req);
                return { content: [{ type: "text", text: `Clarification ${args.clarification_id} added.` }] };
            }
            if (args.action === "resolve_clarification") {
                const c = req.clarification_questions.find(q => q.id === args.clarification_id);
                if (!c)
                    return { content: [{ type: "text", text: `Clarification not found.` }], isError: true };
                c.state = "RESOLVED";
                c.answer = args.answer;
                c.decision = args.decision;
                c.resolved_at = new Date().toISOString();
                if (args.decision) {
                    if (!req.decisions)
                        req.decisions = [];
                    req.decisions.push(args.decision);
                }
                saveRequirement(ecosystemRoot, req);
                return { content: [{ type: "text", text: `Clarification ${args.clarification_id} resolved.` }] };
            }
            if (args.action === "generate_spec") {
                const spec = generateConfirmedSpecification(req);
                return { content: [{ type: "text", text: spec }] };
            }
            return { content: [{ type: "text", text: `Unknown action ${args.action}` }], isError: true };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("create_traceability_link", "Explicitly creates a traceability link between two nodes in the graph.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        source: z.string().describe("Source node ID (e.g. 'REQUIREMENT:BM-RET-1')"),
        target: z.string().describe("Target node ID (e.g. 'CLASS:RetentionPolicy')"),
        type: z.string().describe("Relationship type (e.g. 'IMPLEMENTED_BY', 'AFFECTS')"),
        provenance: z.enum(["DIRECT", "INFERRED", "USER_CONFIRMED", "HISTORICAL", "UNKNOWN"]),
        confidence: z.enum(["CONFIRMED", "SUPPORTED", "INFERRED", "CONFLICT", "UNKNOWN", "STALE"])
    }, async ({ workspace_root, source, target, type, provenance, confidence }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const link = addTraceabilityLink(ecosystemRoot, source, target, type, provenance, confidence);
            return { content: [{ type: "text", text: `Traceability link created: ${JSON.stringify(link)}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("trace_requirement", "Traces a requirement forward or an implementation backward to find linked artifacts.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        node_id: z.string().describe("The node ID to start tracing from (e.g. 'REQUIREMENT:BM-RET-1' or 'CLASS:EventEntity')"),
        direction: z.enum(["FORWARD", "REVERSE"]).describe("Direction to trace"),
        depth: z.number().optional().describe("Maximum traversal depth")
    }, async ({ workspace_root, node_id, direction, depth }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const dnaPath = getDnaPath(ecosystemRoot);
            if (!fs.existsSync(dnaPath))
                return { content: [{ type: "text", text: "No DNA graph found." }] };
            const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
            if (!dna.graph)
                return { content: [{ type: "text", text: "No graph in DNA." }] };
            const edges = loadTraceability(ecosystemRoot);
            const res = direction === "FORWARD"
                ? traceForward(dna.graph, edges, node_id, depth || 3)
                : traceReverse(dna.graph, edges, node_id, depth || 3);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("find_traceability_gaps", "Finds gaps in traceability mapping (e.g. requirements without implementation).", {
        workspace_root: z.string().describe("Root directory of the workspace")
    }, async ({ workspace_root }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const dnaPath = getDnaPath(ecosystemRoot);
            if (!fs.existsSync(dnaPath))
                return { content: [{ type: "text", text: "No DNA graph found." }] };
            const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
            const edges = loadTraceability(ecosystemRoot);
            const gaps = findTraceabilityGaps(ecosystemRoot, dna.graph || { nodes: [], edges: [] }, edges);
            return { content: [{ type: "text", text: JSON.stringify(gaps, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("manage_implementation_plan", "Creates, retrieves, or updates an implementation plan.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        id: z.string().describe("Plan ID"),
        requirement_id: z.string().optional().describe("Associated requirement ID"),
        action: z.enum(["create", "get", "update"]),
        status: z.enum(["DRAFT", "VALIDATED", "IMPLEMENTING", "VALIDATING", "REVIEWED", "COMPLETED", "BLOCKED"]).optional(),
        summary: z.string().optional(),
        affected_services: z.array(z.string()).optional(),
        affected_files: z.array(z.string()).optional(),
        api_changes: z.array(z.string()).optional(),
        database_changes: z.array(z.string()).optional(),
        event_changes: z.array(z.string()).optional(),
        frontend_changes: z.array(z.string()).optional(),
        extension_changes: z.array(z.string()).optional(),
        security_implications: z.array(z.string()).optional(),
        implementation_steps: z.array(z.string()).optional(),
        test_obligations: z.array(z.string()).optional(),
        validation_requirements: z.array(z.string()).optional(),
        traceability_requirements: z.array(z.string()).optional(),
        risks: z.array(z.string()).optional(),
        assumptions: z.array(z.string()).optional(),
        unknowns: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            let plan = loadPlan(ecosystemRoot, args.id);
            if (args.action === "get") {
                if (!plan)
                    return { content: [{ type: "text", text: "Plan not found." }], isError: true };
                return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
            }
            if (args.action === "create") {
                if (plan)
                    return { content: [{ type: "text", text: "Plan already exists." }], isError: true };
                if (!args.requirement_id)
                    return { content: [{ type: "text", text: "⛔ A plan must reference the requirement_id it implements." }], isError: true };
                const planGate = requireGates(getWorkspaceRoot(), args.requirement_id, ["philosophy", "intent", "classification", "requirement"], "create a plan");
                if (planGate)
                    return { content: [{ type: "text", text: planGate }], isError: true };
                plan = {
                    id: args.id,
                    requirement_id: args.requirement_id || "",
                    status: args.status || "DRAFT",
                    summary: args.summary || "",
                    affected_services: args.affected_services || [],
                    affected_files: args.affected_files || [],
                    api_changes: args.api_changes || [],
                    database_changes: args.database_changes || [],
                    event_changes: args.event_changes || [],
                    frontend_changes: args.frontend_changes || [],
                    extension_changes: args.extension_changes || [],
                    security_implications: args.security_implications || [],
                    implementation_steps: args.implementation_steps || [],
                    test_obligations: args.test_obligations || [],
                    validation_requirements: args.validation_requirements || [],
                    traceability_requirements: args.traceability_requirements || [],
                    risks: args.risks || [],
                    assumptions: args.assumptions || [],
                    unknowns: args.unknowns || [],
                    blockers: args.blockers || [],
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    snapshot_id: "LATEST"
                };
                savePlan(ecosystemRoot, plan);
                const exploration = explorationSummary(ecosystemRoot, args.requirement_id);
                return { content: [{ type: "text", text: PLAN_CREATED_HEADER + JSON.stringify(exploration, null, 2) }] };
            }
            if (args.action === "update") {
                if (!plan)
                    return { content: [{ type: "text", text: "Plan not found." }], isError: true };
                if (args.status)
                    plan.status = args.status;
                if (args.summary)
                    plan.summary = args.summary;
                if (args.affected_services)
                    plan.affected_services = args.affected_services;
                if (args.affected_files)
                    plan.affected_files = args.affected_files;
                if (args.api_changes)
                    plan.api_changes = args.api_changes;
                if (args.database_changes)
                    plan.database_changes = args.database_changes;
                if (args.event_changes)
                    plan.event_changes = args.event_changes;
                if (args.frontend_changes)
                    plan.frontend_changes = args.frontend_changes;
                if (args.extension_changes)
                    plan.extension_changes = args.extension_changes;
                if (args.security_implications)
                    plan.security_implications = args.security_implications;
                if (args.implementation_steps)
                    plan.implementation_steps = args.implementation_steps;
                if (args.test_obligations)
                    plan.test_obligations = args.test_obligations;
                if (args.validation_requirements)
                    plan.validation_requirements = args.validation_requirements;
                if (args.traceability_requirements)
                    plan.traceability_requirements = args.traceability_requirements;
                if (args.risks)
                    plan.risks = args.risks;
                if (args.assumptions)
                    plan.assumptions = args.assumptions;
                if (args.unknowns)
                    plan.unknowns = args.unknowns;
                if (args.blockers)
                    plan.blockers = args.blockers;
                savePlan(ecosystemRoot, plan);
                return { content: [{ type: "text", text: "Plan updated." }] };
            }
            return { content: [{ type: "text", text: "Unknown action." }], isError: true };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("validate_implementation_plan", "Validates a plan before execution: deterministic checks (requirement CONFIRMED, staleness, test obligations, blockers) plus an LLM judgment that every acceptance criterion is covered by a step and a test, with no scope creep or unconfirmed destructive operations. Passing records the 'plan' gate.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        plan_id: z.string().describe("Plan ID"),
        judgment: judgmentParam
    }, async ({ workspace_root, plan_id, judgment }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const plan = loadPlan(ecosystemRoot, plan_id);
            if (!plan)
                return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            const errors = validatePlan(ecosystemRoot, plan);
            // Aggregate Validation
            let reqStatus = "UNKNOWN";
            const req = loadRequirement(ecosystemRoot, plan.requirement_id);
            if (req)
                reqStatus = req.status;
            const dnaPath = getDnaPath(ecosystemRoot);
            let graph = { nodes: [], edges: [] };
            if (fs.existsSync(dnaPath)) {
                graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
            }
            const edges = loadTraceability(ecosystemRoot);
            const gaps = findTraceabilityGaps(ecosystemRoot, graph, edges);
            const hasTests = plan.test_obligations.length > 0;
            const hasSecurityUnknowns = plan.unknowns.some(u => u.toLowerCase().includes("security") || u.toLowerCase().includes("auth"));
            const testResults = loadTestResults(ecosystemRoot);
            const validation = aggregateValidation(reqStatus, errors, plan.test_obligations, testResults, gaps, hasSecurityUnknowns);
            const wsRoot = getWorkspaceRoot();
            const outcome = await judge(server, wsRoot, {
                kind: "plan",
                subject: plan.requirement_id || plan_id,
                role: "Plan Reviewer (checks an implementation plan against the confirmed requirement before any code is written)",
                rubric: PlanRubric,
                evidence: {
                    requirement: req,
                    exploration: explorationSummary(ecosystemRoot, plan.requirement_id),
                    plan,
                    deterministic_errors: errors,
                    traceability_gaps: gaps,
                    project: specEvidence(wsRoot),
                },
                schema: PlanVerdict,
                schemaHint: PlanHint,
                supplied: judgment,
                reinvoke: "validate_implementation_plan",
            });
            if (outcome.status !== "ok")
                return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
            const pv = outcome.verdict;
            const passed = pv.verdict === "APPROVED" && errors.length === 0;
            if (plan.requirement_id) {
                recordGate(wsRoot, plan.requirement_id, "plan", passed, outcome.source, passed ? pv.summary : `${pv.verdict}${errors.length ? `; ${errors.join(", ")}` : ""}`);
            }
            if (passed && plan.status === "DRAFT") {
                plan.status = "VALIDATED";
                savePlan(ecosystemRoot, plan);
            }
            return { content: [{ type: "text", text: JSON.stringify({ ...validation, llm_review: { judged_by: outcome.source, ...pv }, plan_gate: passed ? "PASSED" : "FAILED" }, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("generate_spec_document", "Writes the /sfn-spec deliverable: the complete Implementation Specification for a work item, assembled deterministically from recorded state " +
        "(requirement, root cause, facts, confirmed user decisions, UI reference, validated plan, gate ledger). Nothing is invented; missing sections say so. " +
        "Requires every gate up to 'plan'. /sfn-code implements exactly this document.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        work_item_id: z.string().describe(WORK_ITEM_ID_DESC),
    }, async ({ workspace_root, work_item_id }) => {
        try {
            const wsRoot = getWorkspaceRoot();
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const gateError = requireGates(wsRoot, work_item_id, ["philosophy", "intent", "classification", "requirement", "plan"], "write the specification");
            if (gateError)
                return textResult(gateError, true);
            const req = loadRequirement(ecosystemRoot, work_item_id);
            if (!req)
                return textResult(`Requirement ${work_item_id} not found.`, true);
            let plan = null;
            const plansDir = path.join(ecosystemRoot, ".secufusion", "plans");
            if (fs.existsSync(plansDir)) {
                for (const f of fs.readdirSync(plansDir).filter((n) => n.endsWith(".json"))) {
                    const p = loadPlan(ecosystemRoot, f.replace(/\.json$/, ""));
                    if (p && p.requirement_id === work_item_id) {
                        plan = p;
                        break;
                    }
                }
            }
            if (!plan)
                return textResult(`No implementation plan references requirement ${work_item_id}. Run manage_implementation_plan first.`, true);
            const doc = renderSpecDocument(work_item_id, req, plan, readLedger(wsRoot, work_item_id), explorationSummary(ecosystemRoot, work_item_id));
            const taskDir = resolveTaskFolder(work_item_id, resolve(TASKS_DIR));
            const target = taskDir ? path.join(taskDir, "spec.md") : resolve(path.join(".secufusion", "specs", `${displayRef(work_item_id)}.md`));
            writeFile(target, doc);
            return textResult(`📄 Specification written: ${target}\n\nShow it to the user for approval. Do not start coding until they approve; then run /sfn-code ${work_item_id}.\n\n---\n${doc}`);
        }
        catch (e) {
            return textResult(`Error: ${e.message}`, true);
        }
    });
    server.tool("verify_against_spec", "Adversarial final review. Judges the implemented change against the task's acceptance criteria, the validated plan, recorded test results and the golden rules. " +
        "Every criterion must be MET with concrete evidence (file:line or test name) for the 'review' gate to pass; manage_task action=complete requires it.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        work_item_id: z.string().describe("Work item / requirement id the change implements."),
        diff_summary: z.string().optional().describe("Optional: summary or excerpt of the diff, in addition to the git diff stat the server collects."),
        acknowledge_diff_quality: z.array(z.object({
            file: z.string().describe("File path from the finding (or '*' for all files with that finding)"),
            finding: z.string().describe("Finding name, e.g. LINE_ENDING_CHANGE"),
            user_statement: z.string().describe("The user's own words accepting this diff noise (e.g. a deliberate normalization). Required."),
        })).optional().describe("Accept HIGH diff-quality findings the USER says are intentional. Without their words a HIGH finding blocks APPROVED."),
        judgment: judgmentParam
    }, async ({ workspace_root, work_item_id, diff_summary, acknowledge_diff_quality, judgment }) => {
        try {
            const wsRoot = getWorkspaceRoot();
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const gateError = requireGates(wsRoot, work_item_id, ["philosophy", "intent", "classification", "requirement", "plan"], "verify the change");
            if (gateError)
                return textResult(gateError, true);
            const taskDir = resolveTaskFolder(work_item_id, resolve(TASKS_DIR));
            const taskSpec = taskDir ? readJson(path.join(taskDir, "spec.json")) : null;
            const filesTouched = taskDir ? readJson(path.join(taskDir, "files-touched.json")) : null;
            const req = loadRequirement(ecosystemRoot, work_item_id);
            let plan = null;
            const plansDir = path.join(ecosystemRoot, ".secufusion", "plans");
            if (fs.existsSync(plansDir)) {
                for (const f of fs.readdirSync(plansDir).filter((n) => n.endsWith(".json"))) {
                    const p = loadPlan(ecosystemRoot, f.replace(/\.json$/, ""));
                    if (p && p.requirement_id === work_item_id) {
                        plan = p;
                        break;
                    }
                }
            }
            let gitStat = "";
            try {
                gitStat = execSync("git diff --stat HEAD", { cwd: wsRoot, stdio: "pipe" }).toString().slice(0, 4000);
            }
            catch { /* not a repo */ }
            const criteria = [
                ...(req?.acceptance_criteria ?? []),
                ...(taskSpec?.acceptance_criteria ?? []),
            ].filter((c, i, a) => a.indexOf(c) === i);
            if (criteria.length === 0) {
                return textResult(`⛔ No acceptance criteria found for ${work_item_id} (requirement or task spec). A change cannot be verified against an empty spec.`, true);
            }
            // Deterministic repository-consistency evidence: the model weighs it, and HIGH findings also block below.
            const dq = analyzeDiffQuality(wsRoot);
            applyAcknowledgements(dq.findings, acknowledge_diff_quality);
            const dqBlocking = blockingFindings(dq.findings);
            const scope = checkScope(dq, plan?.affected_files ?? []);
            // Project Intelligence Layer: the decisions, exceptions and lessons that apply to the files and terms in this change.
            const km = loadKnowledge(knowledgeRoot(wsRoot));
            const projectKnowledge = km.exists
                ? {
                    note: "Accepted entries are project decisions. Do not flag an intentional exception as a defect; a change that violates an accepted decision IS a finding. Proposed entries are unreviewed hints.",
                    entries: queryKnowledge(km.entries, { files: scope.changed, terms: [req?.title ?? "", String(taskSpec?.title ?? ""), ...(req?.facts ?? []).slice(0, 5)], limit: 6 })
                        .map((h) => ({ id: h.entry.id, title: h.entry.title, category: h.entry.category, status: h.entry.status, matched: h.why, text: h.entry.body.slice(0, 1200) })),
                }
                : null;
            const outcome = await judge(server, wsRoot, {
                kind: "review",
                subject: work_item_id,
                role: "Adversarial Spec Verifier (tries to prove the change does NOT meet its spec)",
                rubric: ReviewRubric,
                evidence: {
                    acceptance_criteria: criteria,
                    exploration: explorationSummary(ecosystemRoot, work_item_id),
                    plan,
                    files_touched: filesTouched,
                    git_diff_stat: gitStat,
                    diff_quality: {
                        base: dq.base, base_reason: dq.base_reason, notes: dq.notes, max_severity: dq.max_severity,
                        findings: dq.findings,
                        churn_by_file: dq.files.filter((f) => f.churn).map((f) => ({ file: f.file, ...f.churn, classes: f.classifications })),
                        guidance: "Deterministic. Existing file/repo style is the expected style; consistent CRLF or LF is not a defect. Report these findings; do not demand normalization to your own taste.",
                    },
                    diff_scope: {
                        ...scope,
                        guidance: "outside_plan = changed files the specification never mentioned (check each is a necessary consequence, e.g. a test or a rename); planned_untouched = specified files with no change. Files outside the plan are scope drift: report them in the summary; they never fail the review. Use out_of_scope_changes only for work the specification explicitly excludes or a recorded user decision forbids.",
                    },
                    project_knowledge: projectKnowledge,
                    diff_summary: diff_summary ?? null,
                    test_results: loadTestResults(ecosystemRoot),
                    project: specEvidence(wsRoot),
                    instruction: "Read the touched files yourself before judging; the evidence above lists where to look, not proof.",
                },
                schema: ReviewVerdict,
                schemaHint: ReviewHint,
                supplied: judgment,
                reinvoke: "verify_against_spec",
            });
            if (outcome.status !== "ok")
                return { ...(outcome.status === "invalid" ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] };
            const rv = outcome.verdict;
            // The judgment must cover every criterion the spec has, not a convenient subset.
            const judged = new Set(rv.criteria.map((c) => c.criterion.trim().toLowerCase()));
            const unjudged = criteria.filter((c) => !judged.has(c.trim().toLowerCase()));
            // A deterministic HIGH diff-quality finding cannot be approved away by the model; only the user can accept it.
            const passed = rv.verdict === "APPROVED" && unjudged.length === 0 && dqBlocking.length === 0;
            recordGate(wsRoot, work_item_id, "review", passed, outcome.source, passed ? rv.summary
                : dqBlocking.length ? `diff noise: ${dqBlocking.map((f) => `${f.finding} in ${f.file}`).join("; ")}`
                    : unjudged.length ? `${unjudged.length} criteria not judged` : rv.summary);
            // remember exactly what was reviewed, so a later change makes this verdict stale; a verdict that is not an approval records nothing
            try {
                saveReviewSnapshot(wsRoot, work_item_id, passed ? takeReviewSnapshot(workspace_root) : null);
            }
            catch { /* staleness tracking is best effort */ }
            return textResult(`${passed ? "✅" : "⛔"} Review ${passed ? "APPROVED" : "CHANGES REQUIRED"} — ${work_item_id} (judged by ${outcome.source})\n${rv.summary}\n\n` +
                rv.criteria.map((c) => `- [${c.status}] ${c.criterion}${c.evidence.length ? `\n    evidence: ${c.evidence.join("; ")}` : ""}`).join("\n") +
                (unjudged.length ? `\n\n⚠️ Criteria missing from the judgment (copy them verbatim):\n${unjudged.map((c) => `- ${c}`).join("\n")}` : "") +
                (rv.out_of_scope_changes.length ? `\n\nOut-of-scope changes:\n${rv.out_of_scope_changes.map((c) => `- ${c}`).join("\n")}` : "") +
                (rv.guardrail_violations.length ? `\n\nGuardrail violations:\n${rv.guardrail_violations.map((c) => `- ${c}`).join("\n")}` : "") +
                (dqBlocking.length
                    ? `\n\n⛔ DIFF QUALITY (deterministic) blocks approval:\n${dqBlocking.map((f) => `- ${f.finding} in ${f.file}: ${f.evidence}\n    ${f.recommendation}`).join("\n")}` +
                        `\nFix the diff, or — only if the user says it is intentional — re-run with acknowledge_diff_quality containing their words.`
                    : "") +
                (passed ? `\n\nNext: manage_task action=complete.` : `\n\nFix the gaps, then run verify_against_spec again.`));
        }
        catch (e) {
            return textResult(`Error: ${e.message}`, true);
        }
    });
    server.tool("spec_status", "Shows the spec-driven lifecycle ledger for a work item: which gates (philosophy → intent → classification → requirement → plan → review) have passed, who judged each, " +
        "and exactly which tool to call next. Call this whenever unsure what the next step is, and at session start when resuming.", { work_item_id: z.string().describe("Work item / requirement id.") }, async ({ work_item_id }) => {
        const wsRoot = getWorkspaceRoot();
        const ledger = readLedger(wsRoot, work_item_id);
        const rows = PHASES.map((p) => {
            const g = ledger.phases[p];
            return g ? `${g.status === "PASSED" ? "✅" : "⛔"} ${p.padEnd(15)} ${g.source.padEnd(10)} ${g.summary}` : `⬜ ${p.padEnd(15)} not done`;
        });
        const next = nextPhase(wsRoot, work_item_id);
        const stale = !next ? reviewStalenessFor(wsRoot, work_item_id) : null;
        return textResult(`## Spec status — ${work_item_id}\n\n${rows.join("\n")}\n\n` +
            (next ? `**Next:** ${nextStepHint(next)}`
                : stale?.stale ? `⚠️ **REVIEW STALE.** All gates passed, but files changed after the review:\n${describeStaleness(stale)}\n\n**Next:** ${STALE_NEXT} manage_task action=complete is blocked until then.`
                    : `**All gates passed.** manage_task action=complete is allowed.`));
    });
    server.tool("get_change_context", "Retrieves the consolidated deterministic change context for the host LLM before it writes code.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        plan_id: z.string().describe("Plan ID")
    }, async ({ workspace_root, plan_id }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const plan = loadPlan(ecosystemRoot, plan_id);
            if (!plan)
                return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            const req = loadRequirement(ecosystemRoot, plan.requirement_id);
            const context = {
                requirement: req ? { id: req.id, status: req.status, decisions: req.decisions } : null,
                plan_summary: plan.summary,
                affected_services: plan.affected_services,
                affected_files: plan.affected_files,
                blockers: plan.blockers,
                unknowns: plan.unknowns,
                test_obligations: plan.test_obligations
            };
            return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("generate_test_obligations", "Generates test obligations based on the plan changes.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        plan_id: z.string().describe("Plan ID")
    }, async ({ workspace_root, plan_id }) => {
        try {
            const ecosystemRoot = getEcosystemRoot(workspace_root);
            const plan = loadPlan(ecosystemRoot, plan_id);
            if (!plan)
                return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            const obligations = generateTestObligations(plan);
            return { content: [{ type: "text", text: JSON.stringify(obligations, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
}
